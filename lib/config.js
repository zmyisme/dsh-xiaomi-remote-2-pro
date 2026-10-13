/**
 * 配置模型：默认值、预设、归一化与 Standard Schema 校验。
 *
 * ## 为什么要"容错式归一化"而不是"严格校验"
 *
 * DSH 在加载插件时会用 `Config` 校验 profile 里的 `config`。如果校验直接报错，
 * 这个插件会在 profile 里激活失败——用户看到的是一片空白和一条看不懂的堆栈。
 * 因此这里的策略是：
 *
 * - 只有"整份配置根本不是对象"才返回 `issues`（与官方插件的做法一致）；
 * - 其余情况一律**归一化并降级**：非法字段回落到默认值，问题写进 `warnings`，
 *   面板里能直接看到，profile 永远能正常加载。
 *
 * 配置是 **Standard Schema v1** 对象（`{"~standard": {...}}`），不是 zod，
 * 也不是裸 JSON Schema。同时额外导出 `CONFIG_JSON_SCHEMA` 纯文档用途。
 */

import { ACTION_KINDS, GESTURES, SCROLL_DIRECTIONS, validateAction } from './mapping.js'
import { KNOWN_KEY_IDS } from './keys.js'

/** 预设 id 列表。 `custom` 表示"用户完全自定义，不套用任何预设"。 */
export const PRESET_IDS = Object.freeze(['vibe-coding', 'navigation', 'dictation', 'custom'])

/** 预设的可读说明，面板直接用它渲染。 */
export const PRESETS = Object.freeze({
  'vibe-coding': {
    zh: 'Vibe Coding（推荐）',
    en: 'Vibe Coding',
    description:
      '语音键按住说话并插入草稿，OK 发送，方向键滚动会话，菜单换行，主页/语音键切换面板。被系统丢键的按键保持未映射。',
    mappings: {
      voice: { hold: { kind: 'dictate' }, tap: { kind: 'panel' } },
      ok: { tap: { kind: 'submit' } },
      up: { tap: { kind: 'scroll', direction: 'up', amount: 320 } },
      down: { tap: { kind: 'scroll', direction: 'down', amount: 320 } },
      left: { tap: { kind: 'scroll', direction: 'top' } },
      right: { tap: { kind: 'scroll', direction: 'bottom' } },
      home: { tap: { kind: 'panel' } },
      menu: { tap: { kind: 'newline' } },
      tv: { tap: { kind: 'insertText', text: '请先复述我的需求，再给出最小改动方案。' } },
    },
  },
  navigation: {
    zh: '纯导航（不拦截）',
    en: 'Navigation pass-through',
    description:
      '只有语音键按住说话会被接管，其余按键全部原样交给 DSH 与系统，适合把遥控器当无线方向键用。',
    mappings: {
      voice: { hold: { kind: 'dictate' } },
    },
  },
  dictation: {
    zh: '纯听写',
    en: 'Dictation only',
    description: '语音键按住说话，长按切换面板，OK 发送，菜单清空草稿，其余按键不接管。',
    mappings: {
      voice: { hold: { kind: 'dictate' }, longPress: { kind: 'panel' } },
      ok: { tap: { kind: 'submit' } },
      menu: { tap: { kind: 'clear' } },
    },
  },
  custom: {
    zh: '自定义',
    en: 'Custom',
    description: '完全保留当前配置，不套用任何预设。',
    mappings: {},
  },
})

/** 默认配置。任何字段缺失都会回落到这里。 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  preset: 'vibe-coding',

  capture: {
    enabled: true,
    /** 只在面板打开时接管按键，默认关闭（关掉才能"合上页面也能按住说话"）。 */
    onlyWhenPanelOpen: false,
    /** 焦点在输入框里时是否仍然接管。方向键建议放行。 */
    skipWhileTyping: true,
    /** 命中映射时是否阻止浏览器默认行为（F5 刷新必须拦，否则会重载页面）。 */
    preventDefault: true,
    doubleTapMs: 280,
    longPressMs: 500,
  },

  voice: {
    /** `auto` 交给 DSH 语音服务决定；也可以写 `zh` / `en` 等。 */
    language: 'auto',
    /** 空字符串表示沿用 DSH 当前的识别 provider。 */
    providerId: '',
    /** 转写完成后是否自动发送。 */
    autoSubmit: false,
    /** `composer` 写入输入框；`clipboard` 只复制到剪贴板；`off` 只显示文本。 */
    insertMode: 'composer',
    /** 单次录音上限（秒）。RC003 的按住说话上限由设备控制，约 60 秒。 */
    maxSeconds: 30,
    /** 面板上的按住说话快捷键，避免遥控器语音键被系统吞掉时无法触发。 */
    shortcut: 'ctrl+alt+space',
    /** 客户端把音频重采样到的采样率；DSH 侧要求 canonical WAV。 */
    sampleRate: 16000,
  },

  /** 学习模式的额外绑定：KeyboardEvent.code → 逻辑按键 id。 */
  learnedCodes: {},

  /** 按键 → 手势 → 动作。缺省手势即"不接管"。 */
  mappings: PRESETS['vibe-coding'].mappings,

  advanced: {
    /** 允许 `http` 动作（由宿主机发起请求）。 */
    allowHttp: false,
    /** 允许 `exec` 动作（在宿主机执行命令）。默认关闭。 */
    allowExec: false,
    /** `exec` 动作的允许前缀白名单。 */
    execAllowlist: [],
    /** 面板里保留多少条按键日志。 */
    logLimit: 200,
    /** 是否用 PowerShell 探测遥控器的 PnP 连接状态。 */
    deviceProbe: true,
  },

  ui: {
    showIndicator: true,
    showKeyLog: true,
    panelOpenByDefault: false,
  },
})

/** 深拷贝（只处理 JSON 可表达的值，配置里不会有别的）。 */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = clone(item)
    return out
  }
  return value
}

/** 递归合并：普通对象逐键合并，数组与标量整体覆盖。 */
function merge(base, patch) {
  if (patch === undefined) return clone(base)
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return clone(patch)
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return clone(patch)
  const out = clone(base)
  for (const [key, item] of Object.entries(patch)) {
    out[key] = key in out ? merge(out[key], item) : clone(item)
  }
  return out
}

function clampNumber(value, fallback, min, max) {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.round(num)))
}

/** 去掉对象里值为 `undefined` 的键，便于比较与持久化。 */
function compact(object) {
  const out = {}
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * 归一化用户配置。
 *
 * 过程：`默认值` ← `预设 mappings`（preset 不为 custom 时） ← `用户覆盖`，
 * 然后逐字段做类型收敛并把问题收集到 `warnings`。
 *
 * @param {unknown} raw profile 里写的 `config`
 * @returns {{ config: object, warnings: string[] }}
 */
export function normaliseConfig(raw) {
  const warnings = []
  const user = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    warnings.push('配置不是一个对象，已整体回落到默认值。')
  }

  const presetId = PRESET_IDS.includes(user.preset) ? user.preset : DEFAULT_CONFIG.preset
  if (user.preset !== undefined && !PRESET_IDS.includes(user.preset)) {
    warnings.push(`未知预设 ${JSON.stringify(user.preset)}，已回落到 ${DEFAULT_CONFIG.preset}。`)
  }

  // 预设提供的是 mappings 的**基底**；用户显式写了 mappings 就在其上覆盖。
  const presetMappings = presetId === 'custom' ? {} : PRESETS[presetId].mappings
  const base = clone(DEFAULT_CONFIG)
  base.preset = presetId
  base.mappings = merge(presetMappings, user.mappings ?? {})

  const merged = merge(base, { ...user, mappings: base.mappings })
  const config = clone(DEFAULT_CONFIG)
  config.preset = presetId
  config.enabled = merged.enabled !== false

  config.capture = {
    enabled: merged.capture?.enabled !== false,
    onlyWhenPanelOpen: merged.capture?.onlyWhenPanelOpen === true,
    skipWhileTyping: merged.capture?.skipWhileTyping !== false,
    preventDefault: merged.capture?.preventDefault !== false,
    doubleTapMs: clampNumber(merged.capture?.doubleTapMs, DEFAULT_CONFIG.capture.doubleTapMs, 80, 2000),
    longPressMs: clampNumber(merged.capture?.longPressMs, DEFAULT_CONFIG.capture.longPressMs, 150, 5000),
  }

  const language = typeof merged.voice?.language === 'string' && merged.voice.language !== ''
    ? merged.voice.language
    : DEFAULT_CONFIG.voice.language
  const insertMode = ['composer', 'clipboard', 'off'].includes(merged.voice?.insertMode)
    ? merged.voice.insertMode
    : DEFAULT_CONFIG.voice.insertMode
  if (merged.voice?.insertMode !== undefined && insertMode !== merged.voice.insertMode) {
    warnings.push(`未知 insertMode ${JSON.stringify(merged.voice.insertMode)}，已回落到 composer。`)
  }
  config.voice = {
    language,
    providerId: typeof merged.voice?.providerId === 'string' ? merged.voice.providerId : '',
    autoSubmit: merged.voice?.autoSubmit === true,
    insertMode,
    maxSeconds: clampNumber(merged.voice?.maxSeconds, DEFAULT_CONFIG.voice.maxSeconds, 3, 120),
    shortcut: typeof merged.voice?.shortcut === 'string' ? merged.voice.shortcut : DEFAULT_CONFIG.voice.shortcut,
    sampleRate: clampNumber(merged.voice?.sampleRate, DEFAULT_CONFIG.voice.sampleRate, 8000, 48000),
  }

  config.learnedCodes = {}
  if (merged.learnedCodes !== null && typeof merged.learnedCodes === 'object' && !Array.isArray(merged.learnedCodes)) {
    for (const [code, logicalKey] of Object.entries(merged.learnedCodes)) {
      if (typeof code !== 'string' || code === '') continue
      if (!KNOWN_KEY_IDS.includes(logicalKey)) {
        warnings.push(`学习绑定 ${code} → ${JSON.stringify(logicalKey)} 的按键名无效，已忽略。`)
        continue
      }
      config.learnedCodes[code] = logicalKey
    }
  }

  config.mappings = {}
  const sourceMappings = base.mappings
  for (const [logicalKey, gestures] of Object.entries(sourceMappings)) {
    if (!KNOWN_KEY_IDS.includes(logicalKey)) {
      warnings.push(`映射里的按键名 ${JSON.stringify(logicalKey)} 无效，已忽略。`)
      continue
    }
    if (gestures === null || typeof gestures !== 'object' || Array.isArray(gestures)) {
      warnings.push(`按键 ${logicalKey} 的映射不是对象，已忽略。`)
      continue
    }
    const accepted = {}
    for (const [gesture, action] of Object.entries(gestures)) {
      if (!GESTURES.includes(gesture)) {
        warnings.push(`按键 ${logicalKey} 上的手势 ${JSON.stringify(gesture)} 无效，已忽略。`)
        continue
      }
      if (action === null || action === undefined) continue
      const verdict = validateAction(action)
      if (!verdict.ok) {
        warnings.push(`按键 ${logicalKey} 的 ${gesture} 动作无效：${verdict.reason}`)
        continue
      }
      if (verdict.action.kind === 'none') continue
      accepted[gesture] = compact(verdict.action)
    }
    if (Object.keys(accepted).length > 0) config.mappings[logicalKey] = accepted
  }

  config.advanced = {
    allowHttp: merged.advanced?.allowHttp === true,
    allowExec: merged.advanced?.allowExec === true,
    execAllowlist: Array.isArray(merged.advanced?.execAllowlist)
      ? merged.advanced.execAllowlist.filter((item) => typeof item === 'string' && item !== '')
      : [],
    logLimit: clampNumber(merged.advanced?.logLimit, DEFAULT_CONFIG.advanced.logLimit, 20, 2000),
    deviceProbe: merged.advanced?.deviceProbe !== false,
  }

  config.ui = {
    showIndicator: merged.ui?.showIndicator !== false,
    showKeyLog: merged.ui?.showKeyLog !== false,
    panelOpenByDefault: merged.ui?.panelOpenByDefault === true,
  }

  return { config, warnings }
}

/**
 * Standard Schema v1 校验器。
 *
 * 只有"整份配置不是对象"才产生 `issues`；其余情况一律归一化并降级。
 * 兼容传入 `undefined`（profile 里没写 `config`）。
 */
export const Config = Object.freeze({
  '~standard': {
    version: 1,
    vendor: 'dsh-xiaomi-remote-2-pro',
    validate(value) {
      if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) {
        return { issues: [{ message: '配置必须是一个对象（或省略不写）。' }] }
      }
      const { config, warnings } = normaliseConfig(value)
      // 归一化后的完整配置就是 `value`：DSH 把它交给插件，插件不必自己做兜底。
      return { value: warnings.length === 0 ? config : { ...config, warnings } }
    },
  },
})

/**
 * 配置的 JSON Schema 描述，纯文档/面板用途。
 *
 * 注意：DSH 读的是上面的 Standard Schema，这里不参与加载。
 */
export const CONFIG_JSON_SCHEMA = Object.freeze({
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'dsh-xiaomi-remote-2-pro 配置',
  type: 'object',
  additionalProperties: true,
  properties: {
    enabled: { type: 'boolean', default: true, description: '总开关。' },
    preset: { type: 'string', enum: [...PRESET_IDS], default: 'vibe-coding', description: '按键预设。' },
    capture: {
      type: 'object',
      description: '按键接管行为。',
      properties: {
        enabled: { type: 'boolean', default: true },
        onlyWhenPanelOpen: { type: 'boolean', default: false },
        skipWhileTyping: { type: 'boolean', default: true },
        preventDefault: { type: 'boolean', default: true },
        doubleTapMs: { type: 'integer', minimum: 80, maximum: 2000, default: 280 },
        longPressMs: { type: 'integer', minimum: 150, maximum: 5000, default: 500 },
      },
    },
    voice: {
      type: 'object',
      description: '语音输入行为。',
      properties: {
        language: { type: 'string', default: 'auto' },
        providerId: { type: 'string', default: '' },
        autoSubmit: { type: 'boolean', default: false },
        insertMode: { type: 'string', enum: ['composer', 'clipboard', 'off'], default: 'composer' },
        maxSeconds: { type: 'integer', minimum: 3, maximum: 120, default: 30 },
        shortcut: { type: 'string', default: 'ctrl+alt+space' },
        sampleRate: { type: 'integer', minimum: 8000, maximum: 48000, default: 16000 },
      },
    },
    learnedCodes: {
      type: 'object',
      description: '学习模式得到的额外绑定：KeyboardEvent.code → 逻辑按键 id。',
      additionalProperties: { type: 'string', enum: [...KNOWN_KEY_IDS] },
    },
    mappings: {
      type: 'object',
      description: '按键 → 手势 → 动作。手势：' + GESTURES.join(' / '),
      additionalProperties: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: [...ACTION_KINDS] },
            text: { type: 'string' },
            chord: { type: 'string' },
            direction: { type: 'string', enum: [...SCROLL_DIRECTIONS] },
            amount: { type: 'integer' },
            url: { type: 'string' },
            method: { type: 'string' },
            body: { type: 'string' },
            command: { type: 'string' },
          },
        },
      },
    },
    advanced: {
      type: 'object',
      description: '高级开关，默认全部关闭。',
      properties: {
        allowHttp: { type: 'boolean', default: false },
        allowExec: { type: 'boolean', default: false },
        execAllowlist: { type: 'array', items: { type: 'string' }, default: [] },
        logLimit: { type: 'integer', minimum: 20, maximum: 2000, default: 200 },
        deviceProbe: { type: 'boolean', default: true },
      },
    },
    ui: {
      type: 'object',
      properties: {
        showIndicator: { type: 'boolean', default: true },
        showKeyLog: { type: 'boolean', default: true },
        panelOpenByDefault: { type: 'boolean', default: false },
      },
    },
  },
})
