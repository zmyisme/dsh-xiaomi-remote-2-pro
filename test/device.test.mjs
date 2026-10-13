import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RC003_PRODUCT_ID,
  RC003_VENDOR_ID,
  createDeviceProbe,
  encodePowerShellCommand,
  summariseDevices,
} from '../lib/device.js'

test('RC003 的 VID / PID 与实测一致', () => {
  assert.equal(RC003_VENDOR_ID, '2717')
  assert.equal(RC003_PRODUCT_ID, '32b8')
})

test('encodePowerShellCommand 产出 UTF-16LE base64（避免引号转义地狱）', () => {
  const script = "$ErrorActionPreference = 'SilentlyContinue'\nGet-PnpDevice"
  const encoded = encodePowerShellCommand(script)
  const decoded = Buffer.from(encoded, 'base64').toString('utf16le')
  assert.equal(decoded, script)
  // 确认用的是 UTF-16LE 而不是 UTF-8：字节里应当有 0x00 间隔
  const raw = Buffer.from(encoded, 'base64')
  assert.equal(raw[1], 0, '第二个字节应当是 UTF-16LE 的高位 0')
  assert.match(decoded, /Get-PnpDevice/)
})

test('探测脚本按 VID/PID 两个片段同时匹配，不依赖固件版本', async () => {
  const { runner, calls } = fakeRunner('[]')
  const probe = createDeviceProbe({ runner, logger: { warn() {} } })
  await probe.probe()
  const script = Buffer.from(calls[0].args.at(-1), 'base64').toString('utf16le')
  assert.match(script, /-match '2717'/)
  assert.match(script, /-match '32b8'/)
  assert.match(script, /Get-PnpDevice/)
  assert.match(script, /ConvertTo-Json/)
})

test('探测脚本强制把 stdout 设成 UTF-8（否则中文设备名会变乱码）', async () => {
  // 这是一条真实的回归测试：Windows PowerShell 5.1 默认按控制台代码页输出，
  // Node 按 UTF-8 读取，实测会把"蓝牙 LE 通用属性服务"读成"???? LE ???????? ???"。
  const { runner, calls } = fakeRunner('[]')
  const probe = createDeviceProbe({ runner, logger: { warn() {} } })
  await probe.probe()
  const script = Buffer.from(calls[0].args.at(-1), 'base64').toString('utf16le')
  assert.match(script, /\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8/)
  assert.match(script, /\$OutputEncoding = \[System\.Text\.Encoding\]::UTF8/)
})

test('summariseDevices 从真实设备的 PnP 节点里认出关键接口', () => {
  // 下面的 instanceId 直接取自实测输出（真机 RC003 会展开成 10 个 PnP 节点）
  const devices = [
    { class: 'Bluetooth', instanceId: 'BTHLEDEVICE\\{0000FE59-0000-1000-8000-00805F9B34FB}_DEV_VID&012717_PID&32B8_REV&00A4_C05D39F87B33\\9&3D6D369&0&0804' },
    { class: 'Bluetooth', instanceId: 'BTHLEDEVICE\\{0000180A-0000-1000-8000-00805F9B34FB}_DEV_VID&012717_PID&32B8\\0&003A' },
    { class: 'Bluetooth', instanceId: 'BTHLEDEVICE\\{8A7A0001-2C42-C2A2-0F36-41928C259B78}_DEV_VID&012717_PID&32B8\\0&0500' },
    { class: 'Bluetooth', instanceId: 'BTHLEDEVICE\\{AB5E0001-5A21-4F05-BC7D-AF01F617B664}_DEV_VID&012717_PID&32B8\\0&0300' },
    { class: 'Bluetooth', instanceId: 'BTHLEDEVICE\\{0000180F-0000-1000-8000-00805F9B34FB}_DEV_VID&012717_PID&32B8\\0&002E' },
    { class: 'HIDClass', instanceId: 'BTHLEDEVICE\\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&012717_PID&32B8\\0&0055' },
    { class: 'Keyboard', instanceId: 'HID\\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&012717_PID&32B8\\A&2AC89AD4&0&0000' },
  ]

  const summary = summariseDevices(devices)
  assert.equal(summary.total, 7)
  assert.equal(summary.hasHogp, true, '0x1812 就是 Windows 用来建键盘的 HOGP 服务')
  assert.equal(summary.hasKeyboardInterface, true, '必须有 HID Keyboard 接口，按键才可能到页面')
  assert.equal(summary.hasAtvv, true, 'ab5e0001 是遥控器麦克风的 ATVV 通道')
  assert.equal(summary.hasVendorService, true)
  assert.equal(summary.hasBattery, true)
  assert.deepEqual(summary.classes, { Bluetooth: 5, HIDClass: 1, Keyboard: 1 })
})

test('summariseDevices 在空列表上给出全 false', () => {
  const summary = summariseDevices([])
  assert.equal(summary.total, 0)
  assert.deepEqual(summary.classes, {})
  assert.equal(summary.hasHogp, false)
  assert.equal(summary.hasKeyboardInterface, false)
  assert.equal(summary.hasAtvv, false)
})

test('只有蓝牙服务节点、没有键盘接口时 hasKeyboardInterface 为 false', () => {
  const summary = summariseDevices([
    { class: 'Bluetooth', instanceId: 'BTHLEDEVICE\\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&012717_PID&32B8' },
  ])
  assert.equal(summary.hasHogp, true)
  assert.equal(summary.hasKeyboardInterface, false, 'HOGP 服务在，但 Windows 可能还没建出键盘接口')
})

/** 造一个假的 PowerShell 执行器。 */
function fakeRunner(output) {
  const calls = []
  return {
    calls,
    runner: async (command, args, options) => {
      calls.push({ command, args, options })
      if (output instanceof Error) throw output
      return output
    },
  }
}

test('探测到设备时状态为 connected，并保留 PnP 细节', async () => {
  const payload = JSON.stringify([
    {
      status: 'OK',
      class: 'HIDClass',
      name: 'Bluetooth Low Energy GATT compliant HID device',
      instanceId: 'HID\\{00001812-0000-1000-8000-00805f9b34fb}_Dev_VID&012717_PID&32b8_REV&00a4',
    },
  ])
  const { runner, calls } = fakeRunner(payload)
  const probe = createDeviceProbe({ runner, logger: { warn() {} } })

  const result = await probe.probe()
  assert.equal(result.status, 'connected')
  assert.equal(result.cached, false)
  assert.equal(result.devices.length, 1)
  assert.match(result.devices[0].instanceId, /PID&32b8/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'powershell.exe')
  assert.ok(calls[0].args.includes('-NonInteractive'))
  assert.ok(calls[0].args.includes('-EncodedCommand'))
})

test('ConvertTo-Json 对单个对象返回对象而不是数组，也要能处理', async () => {
  const payload = JSON.stringify({
    status: 'OK',
    class: 'HIDClass',
    name: 'MI RC',
    instanceId: 'HID\\VID&012717_PID&32b8',
  })
  const { runner } = fakeRunner(payload)
  const probe = createDeviceProbe({ runner, logger: { warn() {} } })
  const result = await probe.probe()
  assert.equal(result.status, 'connected')
  assert.equal(result.devices.length, 1)
  assert.equal(result.devices[0].name, 'MI RC')
})

test('没有设备时状态为 absent', async () => {
  const { runner } = fakeRunner('[]')
  const probe = createDeviceProbe({ runner, logger: { warn() {} } })
  assert.equal((await probe.probe()).status, 'absent')
})

test('执行器抛异常时回落为 unknown，绝不向上抛', async () => {
  const warnings = []
  const { runner } = fakeRunner(new Error('powershell 不见了'))
  const probe = createDeviceProbe({ runner, logger: { warn: (m) => warnings.push(m) } })
  const result = await probe.probe()
  assert.equal(result.status, 'unknown')
  assert.match(result.reason, /powershell/)
  assert.equal(warnings.length, 1)
})

test('输出不是合法 JSON 时也回落为 unknown', async () => {
  const { runner } = fakeRunner('<html>error</html>')
  const probe = createDeviceProbe({ runner, logger: { warn() {} } })
  const result = await probe.probe()
  assert.equal(result.status, 'unknown')
})

test('结果被缓存，force 强制重探，invalidate 清缓存', async () => {
  const { runner, calls } = fakeRunner('[]')
  const probe = createDeviceProbe({ runner, cacheTtlMs: 60_000, logger: { warn() {} } })

  await probe.probe()
  const cached = await probe.probe()
  assert.equal(calls.length, 1, '第二次应命中缓存')
  assert.equal(cached.cached, true)

  await probe.probe({ force: true })
  assert.equal(calls.length, 2)

  probe.invalidate()
  await probe.probe()
  assert.equal(calls.length, 3)
})

test('并发探测只跑一次', async () => {
  let resolveRunner
  const calls = []
  const runner = () =>
    new Promise((resolve) => {
      calls.push(1)
      resolveRunner = resolve
    })
  const probe = createDeviceProbe({ runner, logger: { warn() {} } })
  const first = probe.probe()
  const second = probe.probe()
  resolveRunner('[]')
  const [a, b] = await Promise.all([first, second])
  assert.equal(calls.length, 1, '并发调用应共享同一次探测')
  assert.equal(a.status, 'absent')
  assert.equal(b.status, 'absent')
})

test('last() 在探测前返回 null，探测后返回缓存结果', async () => {
  const { runner } = fakeRunner('[]')
  const probe = createDeviceProbe({ runner, logger: { warn() {} } })
  assert.equal(probe.last(), null)
  await probe.probe()
  assert.equal(probe.last().cached, true)
  assert.equal(probe.last().status, 'absent')
})

test('last() 必须报告缓存是否过期（否则设备状态永远不会更新）', async () => {
  // 回归测试：早先的实现无条件返回缓存，于是遥控器断开重连后面板永远显示旧状态
  const { runner } = fakeRunner('[]')

  const fresh = createDeviceProbe({ runner, cacheTtlMs: 60_000, logger: { warn() {} } })
  await fresh.probe()
  assert.equal(fresh.last().stale, false, '刚探测过就不该算过期')

  const alwaysStale = createDeviceProbe({ runner, cacheTtlMs: 0, logger: { warn() {} } })
  await alwaysStale.probe()
  assert.equal(alwaysStale.last().stale, true, 'TTL 为 0 时应立刻算过期')
})

test('过期后 probe() 会重新执行，而不是一直吃旧缓存', async () => {
  const { runner, calls } = fakeRunner('[]')
  const probe = createDeviceProbe({ runner, cacheTtlMs: 0, logger: { warn() {} } })
  await probe.probe()
  assert.equal(probe.last().stale, true)
  await probe.probe()
  assert.equal(calls.length, 2, '过期之后必须真的再探一次')
})

test('非 Windows 平台明确报告 unsupported，而不是假装探测失败', async () => {
  const { runner, calls } = fakeRunner('[]')
  const probe = createDeviceProbe({ runner, platform: 'darwin', logger: { warn() {} } })
  const result = await probe.probe()
  assert.equal(result.status, 'unsupported')
  assert.match(result.reason, /Windows/)
  assert.equal(calls.length, 0, '非 Windows 不该去调用 powershell')
})
