/**
 * 手势识别与动作模型。
 *
 * 这一层同样是**纯逻辑**：时间由调用方注入（`now`），事件由调用方喂进来，
 * 因此可以在 Node 里直接跑单元测试，不需要真实的键盘或浏览器。
 *
 * ## 手势
 *
 * - `tap` 单击
 * - `doubleTap` 双击
 * - `longPress` 长按（按住超过 `longPressMs`，在按住期间就触发一次）
 * - `hold` 按住 / 松开（`phase: 'press'` 在按下瞬间触发，`phase: 'release'` 在松开时触发）
 *
 * `hold` 是给"按住说话"准备的：按下即开始录音，松开即结束并转写。
 * 其余动作只响应 `press`，`release` 会被忽略。
 *
 * ## 双击与单击的互斥
 *
 * 同一个按键同时配了 `tap` 与 `doubleTap` 时，单击必须等双击窗口
 * （`doubleTapMs`）过去才能确定，否则每次单击都会被误判成双击的前半段。
 * 引擎因此会把单击**延迟**到窗口结束（由 `tick()` 兑现）。只配 `tap` 时无延迟。
 */

import { REMOTE_KEY_IDS } from './keys.js'

/** 合法手势列表。 */
export const GESTURES = Object.freeze(['tap', 'doubleTap', 'longPress', 'hold'])

/**
 * 动作目录。`phaseAware` 为 true 的动作会同时收到 `press` 与 `release`，
 * 其余动作只收到 `press`。`danger` 为 true 的动作默认被配置开关禁用。
 */
export const ACTIONS = Object.freeze({
  none: {
    zh: '无操作',
    en: 'Nothing',
    description: '明确地什么都不做（可用来屏蔽某个按键）。',
    params: [],
  },
  dictate: {
    zh: '按住说话（转写后插入）',
    en: 'Push-to-talk (insert)',
    description: '按住开始录音，松开转写并把文字插入输入框光标处。',
    params: [],
    phaseAware: true,
    voice: true,
  },
  dictateSubmit: {
    zh: '按住说话（转写后发送）',
    en: 'Push-to-talk (submit)',
    description: '按住开始录音，松开转写、插入并直接发送给 Agent。',
    params: [],
    phaseAware: true,
    voice: true,
  },
  insertText: {
    zh: '插入文本',
    en: 'Insert text',
    description: '把固定文本插入输入框光标处。',
    params: ['text'],
  },
  prompt: {
    zh: '发送提示词',
    en: 'Send prompt',
    description: '把固定文本写入输入框并直接发送，用于一键下达常用指令。',
    params: ['text'],
  },
  submit: {
    zh: '发送当前输入',
    en: 'Submit',
    description: '等价于在输入框里按回车发送。',
    params: [],
  },
  newline: {
    zh: '换行',
    en: 'Newline',
    description: '在输入框里插入一个换行，不发送。',
    params: [],
  },
  clear: {
    zh: '清空输入框',
    en: 'Clear composer',
    description: '清空当前草稿。',
    params: [],
  },
  key: {
    zh: '模拟快捷键',
    en: 'Send shortcut',
    description: '向页面派发一个真实按键事件，例如 ctrl+k。',
    params: ['chord'],
  },
  scroll: {
    zh: '滚动对话',
    en: 'Scroll transcript',
    description: '滚动会话内容；方向可选 up / down / top / bottom。',
    params: ['direction', 'amount'],
  },
  panel: {
    zh: '开关控制面板',
    en: 'Toggle panel',
    description: '显示或隐藏本插件的遥控器面板。',
    params: [],
  },
  log: {
    zh: '记录日志',
    en: 'Log only',
    description: '只往按键日志里写一条记录，便于调试映射。',
    params: [],
  },
  http: {
    zh: '请求 URL（宿主机发起）',
    en: 'Host HTTP request',
    description: '由宿主机半区发起一次 HTTP 请求，用于接自己的自动化。默认关闭。',
    params: ['url', 'method', 'body'],
    danger: true,
  },
  exec: {
    zh: '执行命令（宿主机）',
    en: 'Host command',
    description: '在宿主机上执行一条命令。默认关闭，且受白名单限制。',
    params: ['command'],
    danger: true,
  },
})

/** 动作 kind 列表。 */
export const ACTION_KINDS = Object.freeze(Object.keys(ACTIONS))

/** 滚动方向。 */
export const SCROLL_DIRECTIONS = Object.freeze(['up', 'down', 'top', 'bottom'])

/** 快捷键字符串（动作 `key`）的粗略校验，真正的解析在 keys.js。 */
const CHORD_PATTERN = /^[A-Za-z0-9+ ]+$/

/**
 * 校验单个动作对象。
 *
 * @param {unknown} action
 * @returns {{ ok: true, action: object } | { ok: false, reason: string }}
 */
export function validateAction(action) {
  if (action === null || typeof action !== 'object' || Array.isArray(action)) {
    return { ok: false, reason: '动作必须是一个对象' }
  }
  const kind = action.kind
  if (typeof kind !== 'string' || !Object.hasOwn(ACTIONS, kind)) {
    return { ok: false, reason: `未知动作 kind：${String(kind)}` }
  }
  const spec = ACTIONS[kind]

  if (spec.params.includes('text') && typeof action.text !== 'string') {
    return { ok: false, reason: `动作 ${kind} 需要字符串字段 text` }
  }
  if (spec.params.includes('chord')) {
    if (typeof action.chord !== 'string' || !CHORD_PATTERN.test(action.chord)) {
      return { ok: false, reason: `动作 ${kind} 的 chord 不合法` }
    }
  }
  if (spec.params.includes('direction')) {
    if (action.direction !== undefined && !SCROLL_DIRECTIONS.includes(action.direction)) {
      return { ok: false, reason: `动作 ${kind} 的 direction 必须是 ${SCROLL_DIRECTIONS.join(' / ')}` }
    }
  }
  if (spec.params.includes('url')) {
    if (typeof action.url !== 'string' || !/^https?:\/\//i.test(action.url)) {
      return { ok: false, reason: `动作 ${kind} 的 url 必须是 http(s) 地址` }
    }
  }
  if (spec.params.includes('command') && typeof action.command !== 'string') {
    return { ok: false, reason: `动作 ${kind} 需要字符串字段 command` }
  }

  return { ok: true, action }
}

/**
 * 在配置里取出某个逻辑按键某个手势对应的动作。
 *
 * @param {object} config 已归一化的配置
 * @param {string} logicalKey
 * @param {string} gesture
 * @returns {object | undefined}
 */
export function resolveAction(config, logicalKey, gesture) {
  const perKey = config?.mappings?.[logicalKey]
  if (perKey === null || typeof perKey !== 'object') return undefined
  const action = perKey[gesture]
  if (action === null || typeof action !== 'object') return undefined
  if (action.kind === undefined || action.kind === 'none') return undefined
  return action
}

/** 该按键是否配了某个手势（`none` 不算配）。 */
export function hasMapping(config, logicalKey, gesture) {
  return resolveAction(config, logicalKey, gesture) !== undefined
}

/**
 * 创建手势引擎。
 *
 * 引擎不持有定时器，只暴露 `nextDeadline()`；调用方据此安排一次 `tick()`，
 * 于是"单击延迟兑现"与"长按触发"都由注入的时间驱动，行为完全可测。
 *
 * @param {{
 *   doubleTapMs?: number,
 *   longPressMs?: number,
 *   hasGesture?: (logicalKey: string, gesture: string) => boolean,
 * }} [options]
 */
export function createGestureEngine(options = {}) {
  const doubleTapMs = Number.isFinite(options.doubleTapMs) ? Number(options.doubleTapMs) : 280
  const longPressMs = Number.isFinite(options.longPressMs) ? Number(options.longPressMs) : 500
  const hasGestureFn =
    typeof options.hasGesture === 'function' ? options.hasGesture : () => true
  const has = (key, gesture) => Boolean(hasGestureFn(key, gesture))

  /** @type {Map<string, { downAt: number, isDown: boolean, longPressFired: boolean, awaitingDouble: boolean, tapDeadline: number }>} */
  const states = new Map()

  function stateOf(key) {
    let state = states.get(key)
    if (state === undefined) {
      state = { downAt: 0, isDown: false, longPressFired: false, awaitingDouble: false, tapDeadline: 0 }
      states.set(key, state)
    }
    return state
  }

  return {
    /**
     * 按键按下。
     * @returns {Array<{ logicalKey: string, gesture: string, phase: 'press' }>}
     */
    down(logicalKey, now) {
      const state = stateOf(logicalKey)
      // 忽略系统自动重复（按住不放会连续派发 keydown）
      if (state.isDown) return []

      state.isDown = true
      state.downAt = now
      state.longPressFired = false

      const out = []
      if (has(logicalKey, 'hold')) {
        out.push({ logicalKey, gesture: 'hold', phase: 'press' })
      }
      return out
    },

    /**
     * 按键松开。
     * @returns {Array<{ logicalKey: string, gesture: string, phase: 'press'|'release' }>}
     */
    up(logicalKey, now) {
      const state = stateOf(logicalKey)
      if (!state.isDown) return []

      state.isDown = false
      const out = []
      if (has(logicalKey, 'hold')) {
        out.push({ logicalKey, gesture: 'hold', phase: 'release' })
      }
      if (state.longPressFired) {
        state.longPressFired = false
        return out
      }

      const wantsDouble = has(logicalKey, 'doubleTap')
      const wantsTap = has(logicalKey, 'tap')

      if (wantsDouble) {
        if (state.awaitingDouble && now - state.tapDeadline <= doubleTapMs) {
          state.awaitingDouble = false
          out.push({ logicalKey, gesture: 'doubleTap', phase: 'press' })
        } else {
          // 等一个双击窗口；窗口内没有第二击就兑现为单击
          state.awaitingDouble = true
          state.tapDeadline = now + doubleTapMs
        }
        return out
      }

      if (wantsTap) out.push({ logicalKey, gesture: 'tap', phase: 'press' })
      return out
    },

    /**
     * 推进时间：兑现到期的单击与长按。
     * @returns {Array<{ logicalKey: string, gesture: string, phase: 'press' }>}
     */
    tick(now) {
      const out = []
      for (const [logicalKey, state] of states) {
        if (state.isDown && !state.longPressFired && has(logicalKey, 'longPress') && now - state.downAt >= longPressMs) {
          state.longPressFired = true
          out.push({ logicalKey, gesture: 'longPress', phase: 'press' })
        }
        if (state.awaitingDouble && now >= state.tapDeadline) {
          state.awaitingDouble = false
          if (has(logicalKey, 'tap')) out.push({ logicalKey, gesture: 'tap', phase: 'press' })
        }
      }
      return out
    },

    /** 下一个需要被处理的时刻；返回 `null` 表示没有待处理的时间点。 */
    nextDeadline() {
      let deadline = null
      for (const state of states.values()) {
        const candidates = []
        if (state.isDown && !state.longPressFired) candidates.push(state.downAt + longPressMs)
        if (state.awaitingDouble) candidates.push(state.tapDeadline)
        for (const candidate of candidates) {
          if (deadline === null || candidate < deadline) deadline = candidate
        }
      }
      return deadline
    },

    /** 该按键当前是否处于按下状态（面板指示灯用）。 */
    isDown(logicalKey) {
      return stateOf(logicalKey).isDown
    },

    /** 正在等待双击窗口的按键列表。 */
    pendingKeys() {
      const out = []
      for (const [logicalKey, state] of states) {
        if (state.awaitingDouble) out.push(logicalKey)
      }
      return out
    },

    /** 复位全部状态（配置变化或面板关闭时调用）。 */
    reset() {
      states.clear()
    },
  }
}

/**
 * 判断一个逻辑按键 id 是否在遥控器按键表内（`unknown` 允许出现）。
 * @param {string} logicalKey
 */
export function isRemoteKey(logicalKey) {
  return REMOTE_KEY_IDS.includes(logicalKey) || logicalKey === 'unknown'
}
