/**
 * 遥控器连接状态探测（仅 Windows）。
 *
 * ## 为什么不用原生模块
 *
 * 判断"遥控器现在连没连上"最省事的办法是查 PnP 设备树，而这正是 PowerShell 的
 * `Get-PnpDevice` 的主场。这样做的好处是本插件**零原生依赖**：不需要编译 C++、
 * 不需要管理员权限、不会被 Electron 的 ABI 版本卡住。
 *
 * 探测是**可选的、惰性的、有缓存的**：配置里 `advanced.deviceProbe` 可关，失败也
 * 只是状态显示为 `unknown`，绝不影响按键与语音主链路。真正的"是否在线"以
 * 客户端最近一次收到遥控器按键时间为准（`lastSeenAt`），那才是零成本且永远准确的信号。
 *
 * 设备的实例 ID 形如：
 * `HID\{00001812-0000-1000-8000-00805f9b34fb}_Dev_VID&012717_PID&32b8_REV&00a4`
 * 因此按 VID/PID 两个片段同时匹配即可，不依赖具体固件版本。
 */

import { execFile } from 'node:child_process'

/** RC003 的 USB/BLE 厂商 ID（0x2717）。 */
export const RC003_VENDOR_ID = '2717'

/** RC003 的产品 ID（0x32B8）。 */
export const RC003_PRODUCT_ID = '32b8'

/**
 * 查询 PnP 设备树的 PowerShell 脚本。用 EncodedCommand 传递，彻底回避引号转义问题。
 *
 * 开头两行是必须的：Windows PowerShell 5.1 默认按**控制台代码页**写出 stdout，而 Node 按
 * UTF-8 读取它，于是中文设备名（"蓝牙 LE 通用属性服务"之类）会变成乱码。显式把输出编码
 * 设成 UTF-8 才能拿到正确的中文名。
 */
const PROBE_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$OutputEncoding = [System.Text.Encoding]::UTF8',
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$items = Get-PnpDevice -PresentOnly |',
  "  Where-Object { $_.InstanceId -match '2717' -and $_.InstanceId -match '32b8' } |",
  '  Select-Object @{n="status";e={[string]$_.Status}},',
  '                @{n="class";e={[string]$_.Class}},',
  '                @{n="name";e={[string]$_.FriendlyName}},',
  '                @{n="instanceId";e={[string]$_.InstanceId}}',
  "if ($null -eq $items) { Write-Output '[]' }",
  'else { Write-Output ($items | ConvertTo-Json -Compress -Depth 3) }',
].join('\n')

/**
 * 把 PowerShell 脚本编成 `-EncodedCommand` 需要的 base64（UTF-16LE）。
 * @param {string} script
 * @returns {string}
 */
export function encodePowerShellCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * 把设备列表总结成面板能直接显示的几个事实。
 *
 * 实测这台机器上 RC003 会展开成 10 个 PnP 节点（每个 GATT 服务一个），
 * 直接铺一长串名字对用户没有意义；有用的是"HOGP 键盘接口在不在""ATVV 语音服务在不在"。
 *
 * @param {Array<{ class: string, instanceId: string }>} devices
 */
export function summariseDevices(devices) {
  /** @type {Record<string, number>} */
  const classes = {}
  for (const device of devices) {
    const key = device.class === '' ? '(未知)' : device.class
    classes[key] = (classes[key] ?? 0) + 1
  }
  const matches = (pattern) => devices.some((device) => pattern.test(device.instanceId))

  return {
    total: devices.length,
    classes,
    /** HOGP（0x1812）——Windows 就是靠它把遥控器变成键盘的。 */
    hasHogp: matches(/\{00001812-/i),
    /** Windows 实际创建的 HID 键盘接口；有它按键才可能到达页面。 */
    hasKeyboardInterface: devices.some((device) => device.class.toLowerCase() === 'keyboard'),
    /** ATVV（ab5e0001）——遥控器自己的麦克风通道，v0.1 尚未使用。 */
    hasAtvv: matches(/\{ab5e0001-/i),
    /** 厂商私有服务。 */
    hasVendorService: matches(/\{8a7a0001-/i),
    /** 电量服务。 */
    hasBattery: matches(/\{0000180f-/i),
  }
}

/**
 * 默认的执行器：调用 powershell.exe。
 * @param {string} command
 * @param {string[]} args
 * @param {{ timeout: number }} options
 * @returns {Promise<string>}
 */
function defaultRunner(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: options.timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(String(stdout))
    })
  })
}

/**
 * 创建带缓存的设备探测器。
 *
 * @param {{
 *   runner?: (command: string, args: string[], options: { timeout: number }) => Promise<string>,
 *   timeoutMs?: number,
 *   cacheTtlMs?: number,
 *   platform?: string,
 *   logger?: { warn?: Function },
 * }} [options]
 */
export function createDeviceProbe(options = {}) {
  const runner = typeof options.runner === 'function' ? options.runner : defaultRunner
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000
  const cacheTtlMs = Number.isFinite(options.cacheTtlMs) ? options.cacheTtlMs : 15000
  const platform = options.platform ?? process.platform
  const logger = options.logger ?? console

  /** @type {{ at: number, result: object } | null} */
  let cache = null
  /** @type {Promise<object> | null} */
  let inflight = null

  async function probeOnce() {
    if (platform !== 'win32') {
      return {
        status: 'unsupported',
        devices: [],
        summary: summariseDevices([]),
        probedAt: Date.now(),
        reason: `设备探测目前只支持 Windows（当前平台 ${platform}）。`,
      }
    }

    const startedAt = Date.now()
    try {
      const stdout = await runner(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encodePowerShellCommand(PROBE_SCRIPT),
        ],
        { timeout: timeoutMs },
      )

      const text = String(stdout).trim()
      let parsed = []
      if (text !== '') {
        const value = JSON.parse(text)
        parsed = Array.isArray(value) ? value : [value]
      }

      const devices = parsed
        .filter((item) => item !== null && typeof item === 'object')
        .map((item) => ({
          status: typeof item.status === 'string' ? item.status : '',
          class: typeof item.class === 'string' ? item.class : '',
          name: typeof item.name === 'string' ? item.name : '',
          instanceId: typeof item.instanceId === 'string' ? item.instanceId : '',
        }))
        .filter((item) => item.instanceId !== '')

      return {
        status: devices.length > 0 ? 'connected' : 'absent',
        devices,
        summary: summariseDevices(devices),
        probedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      }
    } catch (error) {
      // 探测失败不是错误路径：主链路（按键 + 语音）完全不依赖它
      logger.warn?.(`[xiaomi-remote-2-pro] 设备探测失败，状态回落为 unknown：${String(error)}`)
      return {
        status: 'unknown',
        devices: [],
        summary: summariseDevices([]),
        probedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        reason: String(error?.message ?? error),
      }
    }
  }

  return {
    /**
     * 探测一次（带缓存）。
     * @param {{ force?: boolean }} [probeOptions]
     * @returns {Promise<object>}
     */
    async probe(probeOptions = {}) {
      const now = Date.now()
      if (probeOptions.force !== true && cache !== null && now - cache.at < cacheTtlMs) {
        return { ...cache.result, cached: true }
      }
      if (inflight !== null) return inflight

      inflight = probeOnce().then(
        (result) => {
          cache = { at: Date.now(), result }
          inflight = null
          return { ...result, cached: false }
        },
        (error) => {
          inflight = null
          throw error
        },
      )
      return inflight
    },

    /** 清掉缓存，下一次探测重新执行。 */
    invalidate() {
      cache = null
    },

    /**
     * 最近一次结果（可能为 null）。
     *
     * 会带上 `stale`：**过期与否必须由调用方看到**。如果这里无条件返回缓存，设备状态
     * 一旦探测过一次就再也不会更新——遥控器断开重连后面板还显示"已连接"。
     */
    last() {
      if (cache === null) return null
      const age = Date.now() - cache.at
      return { ...cache.result, cached: true, stale: age >= cacheTtlMs }
    },
  }
}
