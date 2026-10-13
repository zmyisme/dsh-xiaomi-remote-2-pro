/**
 * 小米蓝牙遥控器 2 Pro（RC003）按键模型。
 *
 * 本模块是**纯数据 + 纯函数**，不依赖 DSH、不依赖浏览器、不依赖 Node，
 * 因此可以被宿主机半区、客户端半区与单元测试同时复用。
 *
 * ## 设计前提（重要）
 *
 * 遥控器在 Windows 上以 BLE HID（HOGP）设备身份出现，系统把它当作普通键盘 /
 * 消费类控制设备。浏览器因此只能看到**标准 HID 用法被 Windows 映射后的键码**，
 * 拿不到"这是遥控器发出来的"这一设备身份信息。
 *
 * 结论：
 * 1. 我们没有设备级过滤能力，所以采用**逻辑按键 + 学习模式**：默认给出一张
 *    实测可用的映射表（`DEFAULT_CODE_MAP`），其余按键（尤其是语音键）由用户
 *    在面板里"学习"一次即可绑定。
 * 2. 键码优先取 `KeyboardEvent.code`（物理位置，不受输入法与键盘布局影响），
 *    取不到时回退 `KeyboardEvent.key`。
 *
 * 已知限制（诚实声明，详见 README「已知限制」）：
 * - 音量键通常被 Windows / 系统音量接管，页面收不到；
 * - 语音键在多数 Windows 版本下**不产生任何标准键码**（社区称"三键失效"之一），
 *   因此默认的按住说话由面板按钮 / 快捷键触发，遥控器语音键需学习或走原生后端。
 */

/** 遥控器逻辑按键表。`id` 是配置里的稳定键名，不要随意改名。 */
export const REMOTE_KEYS = Object.freeze([
  { id: 'voice', zh: '语音键', en: 'Voice', hint: '多数机型在 Windows 上不产生标准键码，需学习' },
  { id: 'ok', zh: '确定 / OK', en: 'OK' },
  { id: 'back', zh: '返回', en: 'Back' },
  { id: 'home', zh: '主页', en: 'Home' },
  { id: 'menu', zh: '菜单', en: 'Menu' },
  { id: 'up', zh: '方向 上', en: 'D-pad up' },
  { id: 'down', zh: '方向 下', en: 'D-pad down' },
  { id: 'left', zh: '方向 左', en: 'D-pad left' },
  { id: 'right', zh: '方向 右', en: 'D-pad right' },
  { id: 'volUp', zh: '音量 +', en: 'Volume up', hint: '通常被系统音量接管，页面收不到' },
  { id: 'volDown', zh: '音量 -', en: 'Volume down', hint: '通常被系统音量接管，页面收不到' },
  { id: 'mute', zh: '静音', en: 'Mute', hint: '通常被系统接管' },
  { id: 'power', zh: '电源', en: 'Power' },
  { id: 'tv', zh: '信号源 / TV', en: 'TV / Input', hint: '默认未映射，请用学习模式绑定' },
  { id: 'unknown', zh: '未识别按键', en: 'Unrecognised' },
])

/** 逻辑按键 id 集合，用于校验。 */
export const REMOTE_KEY_IDS = Object.freeze(REMOTE_KEYS.map((key) => key.id))

/** 逻辑按键 id → 展示名。 */
export const REMOTE_KEY_LABEL = Object.freeze(
  Object.fromEntries(REMOTE_KEYS.map((key) => [key.id, key.zh])),
)

/**
 * RC003 在各平台上的 HID 用法（Keyboard / Keypad 页 0x07）。
 *
 * 这张表是**实测取证**的结果，不是猜测：它来自多个独立项目的生产代码与内核诊断
 * （见 README「技术依据」）。左边是物理按键，右边是设备实际上报的 usage。
 *
 * 关键事实：Windows 的 `kbdhid.sys` 只为**能翻译成扫描码/VK 的标准用法**生成按键
 * 事件。因此 `0x80 / 0x81 / 0xF1` 三个用法虽然被设备声明、也确实到达了 HID 栈，
 * 却在进入任何用户态 API（低级键盘钩子、Raw Input、页面事件）之前就被丢掉了。
 */
export const RC003_USAGES = Object.freeze({
  voice: 0x003e,
  ok: 0x0028,
  up: 0x0052,
  down: 0x0051,
  left: 0x0050,
  right: 0x004f,
  home: 0x004a,
  menu: 0x0065,
  tv: 0x0035,
  power: 0x0066,
  back: 0x00f1,
  volUp: 0x0080,
  volDown: 0x0081,
  mute: 0x007f,
})

/**
 * 在 Windows 用户态**收不到**的物理按键。
 *
 * 它们的 usage 被 `kbdhid.sys` 丢弃，任何浏览器 / 用户态程序都拿不到事件。
 * 面板会把这些按键标注为"系统丢键"，并在 README 里给出可行替代方案，
 * 而不会提供一个看起来能用、实际永远不触发的映射。
 */
export const UNREACHABLE_KEY_IDS = Object.freeze(['back', 'volUp', 'volDown', 'mute'])

/**
 * 默认键码映射：`KeyboardEvent.code` → 逻辑按键 id。
 *
 * **只收录实测能在 Windows 上收到的按键**，避免写出好看但跑不通的表。
 * 特别注意 `F5`：RC003 的语音键上报 usage `0x3E`，Windows 把它翻译成 F5，
 * 所以"按住说话"可以直接绑在遥控器自己的语音键上。
 *
 * 未收录的按键（含被系统丢弃的 back / 音量键）通过面板的学习模式绑定。
 */
export const DEFAULT_CODE_MAP = Object.freeze({
  F5: 'voice',
  Enter: 'ok',
  NumpadEnter: 'ok',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  ContextMenu: 'menu',
  Backquote: 'tv',
})

/**
 * 默认键名映射：`KeyboardEvent.key` → 逻辑按键 id。
 * 仅在 `event.code` 缺失或为空时作为回退使用。
 */
export const DEFAULT_KEY_MAP = Object.freeze({
  F5: 'voice',
  Enter: 'ok',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  ContextMenu: 'menu',
  '`': 'tv',
})

/** 已知的按键 id 列表，用于配置校验。 */
export const KNOWN_KEY_IDS = Object.freeze([...REMOTE_KEY_IDS, 'unknown'])

/**
 * 把一个键盘事件归一化成 `{ logicalKey, code, key, display }`。
 *
 * @param {{ code?: string, key?: string }} event 键盘事件或等价对象。
 * @param {Record<string, string>} [codeMap] 覆盖默认表（用户学习结果）。
 * @param {Record<string, string>} [keyMap] 覆盖默认回退表。
 * @returns {{ logicalKey: string, code: string, key: string, display: string, source: 'code'|'key'|'none', known: boolean }}
 */
export function normaliseKeyEvent(event, codeMap, keyMap) {
  const code = typeof event?.code === 'string' ? event.code : ''
  const key = typeof event?.key === 'string' ? event.key : ''
  const codes = codeMap === undefined ? DEFAULT_CODE_MAP : codeMap
  const keys = keyMap === undefined ? DEFAULT_KEY_MAP : keyMap

  let logicalKey = ''
  let source = 'none'

  if (code !== '' && Object.hasOwn(codes, code)) {
    logicalKey = codes[code]
    source = 'code'
  } else if (code !== '' && Object.hasOwn(keys, code)) {
    // 用户可能把绑定写进了回退表
    logicalKey = keys[code]
    source = 'key'
  } else if (key !== '' && Object.hasOwn(keys, key)) {
    logicalKey = keys[key]
    source = 'key'
  }

  if (logicalKey === '') logicalKey = 'unknown'

  return {
    logicalKey,
    code,
    key,
    display: describeKeyEvent({ code, key }),
    source,
    known: logicalKey !== 'unknown',
  }
}

/** 人类可读的按键描述，用于面板与日志。 */
export function describeKeyEvent(event) {
  const code = typeof event?.code === 'string' ? event.code : ''
  const key = typeof event?.key === 'string' ? event.key : ''
  if (code !== '' && key !== '' && code !== key) return `${key} (${code})`
  if (code !== '') return code
  if (key !== '') return key
  return '(空)'
}

/**
 * 解析快捷键字符串，例如 `ctrl+alt+space`。
 *
 * 语法：`[ctrl+][alt+][shift+][meta+]<code|key>`，大小写不敏感，
 * 分隔符支持 `+`。修饰键名支持 ctrl/control、alt/option、shift、meta/cmd/win。
 * 部件可以是 `KeyboardEvent.code`（如 `KeyK`、`Space`、`F5`、`Digit1`），
 * 也可以是 `KeyboardEvent.key`（如 `k`、`Enter`）。
 *
 * @param {string} chord
 * @returns {{ ctrl: boolean, alt: boolean, shift: boolean, meta: boolean, part: string } | null}
 */
export function parseChord(chord) {
  if (typeof chord !== 'string' || chord.trim() === '') return null
  const parts = chord
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length === 0) return null

  const result = { ctrl: false, alt: false, shift: false, meta: false, part: '' }
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'ctrl' || lower === 'control') result.ctrl = true
    else if (lower === 'alt' || lower === 'option') result.alt = true
    else if (lower === 'shift') result.shift = true
    else if (lower === 'meta' || lower === 'cmd' || lower === 'win' || lower === 'super') {
      result.meta = true
    } else result.part = part
  }

  if (result.part === '') return null
  return result
}

/**
 * 判断键盘事件是否匹配快捷键字符串。
 *
 * @param {{ code?: string, key?: string, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, metaKey?: boolean }} event
 * @param {string} chord
 */
export function matchChord(event, chord) {
  const parsed = parseChord(chord)
  if (parsed === null) return false
  if (Boolean(event?.ctrlKey) !== parsed.ctrl) return false
  if (Boolean(event?.altKey) !== parsed.alt) return false
  if (Boolean(event?.shiftKey) !== parsed.shift) return false
  if (Boolean(event?.metaKey) !== parsed.meta) return false

  const code = typeof event?.code === 'string' ? event.code : ''
  const key = typeof event?.key === 'string' ? event.key : ''
  const part = parsed.part
  const lowerPart = part.toLowerCase()
  // 两边都小写比较：这样 ctrl+space、ctrl+Space 与 code "Space" 都能对上
  if (code.toLowerCase() === lowerPart) return true
  if (key.toLowerCase() === lowerPart) return true
  // 允许 chord 写单字母去匹配 `KeyK` 这类 code
  if (part.length === 1 && code === `Key${part.toUpperCase()}`) return true
  return false
}

/**
 * 把逻辑按键 id 翻译成配置里的键名。
 * 不认识的 id 原样返回，保证向前兼容。
 */
export function keyIdOf(value) {
  if (typeof value !== 'string') return 'unknown'
  return KNOWN_KEY_IDS.includes(value) ? value : 'unknown'
}
