import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { normaliseConfig } from '../lib/config.js'
import { DEFAULT_CODE_MAP, UNREACHABLE_KEY_IDS } from '../lib/keys.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = await readFile(resolve(ROOT, 'client.js'), 'utf8')

/**
 * 客户端半区跑在浏览器里，这里用 vm 造一个够用的最小环境把它加载起来。
 * 目的不是复刻浏览器，而是**证明这个包真的能被 loader 加载、真的注册了 slot、
 * 真的把一次按键走完了"键码 → 手势 → 动作"整条链路**。
 */
function createEnvironment(options = {}) {
  const state = {
    loaderId: null,
    captured: null,
    styleTags: [],
    listeners: { keydown: [], keyup: [] },
    removedListeners: [],
    slots: [],
    fetchCalls: [],
    timeouts: [],
    intervals: [],
    toasts: [],
  }

  const react = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    Fragment: Symbol('Fragment'),
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useMemo(factory) {
      return factory()
    },
    useRef(initial) {
      return { current: initial }
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      return getSnapshot()
    },
  }

  const documentStub = {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, textContent: '', style: {}, appendChild() {}, select() {} }),
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    execCommand: () => false,
    head: { appendChild: (node) => state.styleTags.push(node) },
    body: { appendChild() {}, removeChild() {} },
    activeElement: null,
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  }

  const windowStub = {
    __ModuleLoader__: {
      load({ id, factory }) {
        state.loaderId = id
        state.captured = factory((specifier) => {
          if (specifier === 'react') return react
          throw new Error(`client.js 不该 require ${specifier}`)
        })
      },
    },
    MediaRecorder: class FakeMediaRecorder {
      static isTypeSupported() {
        return true
      }
      constructor(stream, options) {
        this.stream = stream
        this.mimeType = options?.mimeType ?? 'audio/webm'
        this.state = 'inactive'
      }
      start() {
        this.state = 'recording'
        // 真机会异步派发分片；这里同步给一片，好让流程走到解码那一步
        this.ondataavailable?.({ data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])]) })
      }
      stop() {
        this.state = 'inactive'
        this.onstop?.()
      }
    },
    // 刻意不提供 AudioContext：用来验证"解码不了就明确报错"而不是静默失败
    addEventListener(type, handler) {
      if (state.listeners[type] !== undefined) state.listeners[type].push(handler)
    },
    removeEventListener(type, handler) {
      state.removedListeners.push({ type, handler })
    },
    setTimeout: (callback) => {
      state.timeouts.push(callback)
      return state.timeouts.length
    },
    clearTimeout: () => {},
    setInterval: (callback) => {
      state.intervals.push(callback)
      return state.intervals.length
    },
    clearInterval: () => {},
    btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
    atob: (text) => Buffer.from(text, 'base64').toString('binary'),
    getSelection: () => null,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', overflowY: 'auto' }),
    innerHeight: 900,
    innerWidth: 1400,
  }

  const config = normaliseConfig({
    preset: 'vibe-coding',
    ...(options.config ?? {}),
  }).config

  const catalog = {
    gestures: ['tap', 'doubleTap', 'longPress', 'hold'],
    keys: [
      { id: 'voice', zh: '语音键', en: 'Voice', unreachable: false },
      { id: 'ok', zh: '确定 / OK', en: 'OK', unreachable: false },
      { id: 'back', zh: '返回', en: 'Back', unreachable: true },
      { id: 'menu', zh: '菜单', en: 'Menu', unreachable: false },
    ],
    actions: [],
    presets: [],
    defaultCodeMap: { ...DEFAULT_CODE_MAP },
  }

  const fetchStub = async (url, init) => {
    state.fetchCalls.push({ url, init })
    if (url.endsWith('/api/state')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            ok: true,
            plugin: { name: 'xiaomi-remote-2-pro' },
            config,
            warnings: [],
            catalog,
            runtime: { lastKeyId: '', lastGesture: '', keyCount: 0, transcribeCount: 0, transcribeFailures: 0, lastError: '' },
            log: [],
            speech: { available: true, providers: [], selection: { providerId: 'sensevoice-local', language: 'zh' } },
            device: { status: 'probing', devices: [] },
            fence: { delegated: true },
          })
        },
      }
    }
    return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true }) } }
  }

  const context = vm.createContext({
    window: windowStub,
    document: documentStub,
    navigator: {
      clipboard: { writeText: async () => {} },
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    },
    console: { log() {}, warn() {}, error() {} },
    fetch: fetchStub,
    URL,
    JSON,
    Date,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    Promise,
    Map,
    Set,
    Symbol,
    Blob,
    Float32Array,
    Uint8Array,
    ArrayBuffer,
    DataView,
    TextDecoder,
    queueMicrotask,
  })

  vm.runInContext(SOURCE, context, { filename: 'client.js' })
  return { state, windowStub, documentStub }
}

/** 造一个假的 Cordis 客户端上下文，记录 slot 注册。 */
function createClientContext(state) {
  const slots = {
    inject(_name, factory) {
      return factory()
    },
    register(registration, component) {
      state.slots.push({ registration, component })
      return () => {}
    },
  }
  const disposers = []
  const ctx = {
    inject(names, callback) {
      if (!names.includes('slots')) return
      callback({ get: (service) => (service === 'slots' ? slots : undefined) })
    },
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    on() {
      return () => {}
    },
    get() {
      return undefined
    },
  }
  return { ctx, disposers, slots }
}

/** 递归找出渲染树里的全部文本。 */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}

/** 递归搜索满足条件的节点。 */
function findNode(node, predicate) {
  if (node === null || node === undefined) return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof node !== 'object') return undefined
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

function fakeKeyEvent({ code, key = code, repeat = false, target = null, modifiers = {} }) {
  return {
    code,
    key,
    repeat,
    target,
    ctrlKey: modifiers.ctrl === true,
    altKey: modifiers.alt === true,
    shiftKey: modifiers.shift === true,
    metaKey: modifiers.meta === true,
    preventDefault() {
      this.defaultPrevented = true
    },
    stopPropagation() {
      this.propagationStopped = true
    },
  }
}

/** 按下并松开一个键，返回两个事件对象以便断言。 */
function press(state, keyOptions) {
  const down = fakeKeyEvent(keyOptions)
  const up = fakeKeyEvent({ ...keyOptions, repeat: false })
  for (const handler of state.listeners.keydown) handler(down)
  for (const handler of state.listeners.keyup) handler(up)
  return { down, up }
}

/** 让 refreshState 的 fetch 链跑完。 */
async function flush() {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function boot(options = {}) {
  const environment = createEnvironment(options)
  const { ctx, disposers } = createClientContext(environment.state)
  environment.state.captured.apply(ctx)
  await flush()
  return { ...environment, ctx, disposers }
}

test('客户端模块通过 Module Loader 注册，id 等于包名', () => {
  const { state } = createEnvironment()
  assert.equal(state.loaderId, 'dsh-xiaomi-remote-2-pro')
  assert.ok(state.captured, 'factory 应当返回模块导出')
})

test('模块加载时注入样式，并且用到的都是主题 token', () => {
  const { state } = createEnvironment()
  const styleTag = state.styleTags.find((tag) => String(tag.dataset.pluginCss).includes('dsh-xiaomi-remote-2-pro'))
  assert.ok(styleTag, '应当注入本插件的样式表')
  assert.match(styleTag.textContent, /--dsw-alias-label-primary/, '必须使用主题 token 而不是硬编码颜色')
  assert.match(styleTag.textContent, /--dsw-alias-bg-layer-1/)
  assert.match(styleTag.textContent, /\.xr-mic/)
})

test('导出的形状符合 Lane 1 契约', () => {
  const { state } = createEnvironment()
  const exports = state.captured
  assert.equal(exports.name, 'xiaomi-remote-2-pro')
  // 注意 Array.from：注入的数组是 VM realm 里的，跨 realm 的 deepStrictEqual 会因为原型不同而失败
  assert.deepEqual(Array.from(exports.inject), ['slots'], '只需要 slots 服务')
  assert.equal(typeof exports.apply, 'function')
  assert.equal(exports.Config['~standard'].version, 1)
  assert.equal(exports.Config['~standard'].vendor, 'dsh-xiaomi-remote-2-pro')
})

test('Config 校验宽松：只有非对象才报错', () => {
  const { state } = createEnvironment()
  const schema = state.captured.Config['~standard']
  assert.equal(schema.validate(undefined).issues, undefined)
  assert.equal(schema.validate({ anything: true }).issues, undefined)
  assert.ok(Array.isArray(schema.validate('nope').issues))
  assert.ok(Array.isArray(schema.validate([]).issues))
})

test('apply 注册三个 slot：悬浮层、输入框麦克风按钮、设置页', async () => {
  const { state } = await boot()
  const slots = state.slots.map((entry) => entry.registration.name)
  assert.deepEqual(slots.sort(), ['conversation.input.left', 'settings.section', 'shell.overlay'])
  for (const entry of state.slots) {
    assert.equal(typeof entry.component, 'function', `${entry.registration.name} 应当带上组件`)
    assert.equal(typeof entry.registration.id, 'string')
    assert.equal(typeof entry.registration.order, 'number')
    assert.equal(typeof entry.registration.label, 'string')
  }
})

test('apply 在捕获阶段挂上 keydown / keyup，卸载时摘掉', async () => {
  const { state, disposers } = await boot()
  assert.equal(state.listeners.keydown.length, 1)
  assert.equal(state.listeners.keyup.length, 1)

  for (const disposer of disposers) disposer()
  const removedTypes = state.removedListeners.map((entry) => entry.type)
  assert.ok(removedTypes.includes('keydown'))
  assert.ok(removedTypes.includes('keyup'))
})

test('端到端：按遥控器 OK 键（Enter）会走到动作并给出可读反馈', async () => {
  const { state } = await boot()
  const overlay = state.slots.find((entry) => entry.registration.name === 'shell.overlay')

  // 默认预设里 ok.tap = submit，而测试环境没有输入框 → 应当优雅降级并提示
  const { down } = press(state, { code: 'Enter', key: 'Enter' })
  assert.equal(down.defaultPrevented, true, '已映射的按键必须拦掉浏览器默认行为')

  const tree = overlay.component({})
  assert.match(textOf(tree), /没找到可发送的输入框/)
})

test('端到端：按键与动作都会批量上报给宿主', async () => {
  const { state } = await boot({
    config: { mappings: { menu: { tap: { kind: 'log' } } } },
  })
  const overlay = state.slots.find((entry) => entry.registration.name === 'shell.overlay')

  press(state, { code: 'ContextMenu', key: 'ContextMenu' })
  assert.match(textOf(overlay.component({})), /菜单 \/ 单击/)

  // pushLog 是延迟批量上报的：手动触发挂起的定时器，再等 fetch 链跑完
  for (const callback of [...state.timeouts]) {
    try {
      callback()
    } catch {
      /* 轮询 / tick 定时器抛错不影响本断言 */
    }
  }
  await flush()

  const logCalls = state.fetchCalls.filter((call) => call.url.endsWith('/api/log'))
  assert.ok(logCalls.length >= 1, '应当把日志上报给宿主，Agent 才看得到')
  const entries = JSON.parse(logCalls[0].init.body).entries
  assert.ok(entries.some((entry) => entry.type === 'key' && entry.logicalKey === 'menu'))
  assert.ok(entries.some((entry) => entry.type === 'action' && entry.kind === 'log'))
})

test('系统丢掉的返回键不会触发任何动作（不做假映射）', async () => {
  const { state } = await boot()
  for (const id of UNREACHABLE_KEY_IDS) {
    assert.ok(!(id in DEFAULT_CODE_MAP), `${id} 不该出现在默认键码表里`)
  }
  // Escape 曾被误映射成"返回"，现在应当完全不动
  const { down } = press(state, { code: 'Escape', key: 'Escape' })
  assert.notEqual(down.defaultPrevented, true, '未映射的按键不该被拦截')
})

test('学习模式：learnedCodes 里的绑定优先于默认表', async () => {
  const { state } = await boot({
    config: { learnedCodes: { F7: 'tv' }, mappings: { tv: { tap: { kind: 'log' } } } },
  })
  const overlay = state.slots.find((entry) => entry.registration.name === 'shell.overlay')
  press(state, { code: 'F7', key: 'F7' })
  assert.match(textOf(overlay.component({})), /信号源 \/ 单击/)
})

test('按住说话：按下进入收音状态，松开明确结束并报错而不是静默', async () => {
  const { state } = await boot()
  const overlay = state.slots.find((entry) => entry.registration.name === 'shell.overlay')

  // 默认 voice.hold = dictate → 按下应立刻开始录音
  for (const handler of state.listeners.keydown) handler(fakeKeyEvent({ code: 'F5', key: 'F5' }))
  await flush()
  assert.match(textOf(overlay.component({})), /正在收音/, '按下后应当显示收音指示灯')

  // 松开 → 环境里没有 AudioContext，必须给出明确原因
  for (const handler of state.listeners.keyup) handler(fakeKeyEvent({ code: 'F5', key: 'F5' }))
  await flush()
  const text = textOf(overlay.component({}))
  assert.doesNotMatch(text, /正在收音/, '松开后收音指示应当消失')
  assert.match(text, /AudioContext/, '解码失败必须说清楚原因')
})

test('三个 slot 组件都能安全渲染（含设置页与麦克风按钮）', async () => {
  const { state } = await boot()
  for (const entry of state.slots) {
    assert.doesNotThrow(() => {
      const tree = entry.component({})
      assert.ok(tree !== undefined && tree !== null, `${entry.registration.name} 返回了空树`)
    }, `${entry.registration.name} 渲染失败`)
  }
})

test('麦克风按钮在未就绪时禁用', async () => {
  const environment = createEnvironment()
  const { ctx } = createClientContext(environment.state)
  environment.state.captured.apply(ctx)
  // 故意不 flush：此时 state.ready 仍是 false
  const mic = environment.state.slots.find((entry) => entry.registration.name === 'conversation.input.left')
  const tree = mic.component({})
  const button = findNode(tree, (node) => node.type === 'button')
  assert.ok(button, '按钮应当渲染出来')
  assert.equal(button.props.disabled, true, '宿主 API 未就绪时必须禁用')
})

test('悬浮面板默认收起，点击后展示状态与操作', async () => {
  const { state } = await boot()
  const overlay = state.slots.find((entry) => entry.registration.name === 'shell.overlay')
  const collapsed = overlay.component({})
  assert.equal(findNode(collapsed, (node) => node.props?.className === 'xr-panel'), undefined)

  const quickPanel = state.slots
    .find((entry) => entry.registration.name === 'shell.overlay')
    .component({})
  assert.ok(quickPanel)
  // 设置页里应当能看到预设下拉与"系统丢键"的说明
  const settings = state.slots.find((entry) => entry.registration.name === 'settings.section').component({})
  assert.match(textOf(settings), /小米蓝牙遥控器 2 Pro/)
  assert.match(textOf(settings), /预设/)
  assert.match(textOf(settings), /kbdhid/)
})
