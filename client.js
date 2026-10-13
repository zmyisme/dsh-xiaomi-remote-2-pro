/**
 * dsh-xiaomi-remote-2-pro —— 客户端半区（Client half，Module Loader 包）。
 *
 * 这是 Lane 1 形态：脚本唯一的副作用是把一个惰性工厂注册进
 * `window.__ModuleLoader__.load({ id, factory })`，`id` 必须等于包名，
 * 工厂里用 `require("react")` 拿 React，最后导出 `{ name, inject, apply, Config }`。
 *
 * ## 这一半负责什么
 *
 * - **按键接管**：`keydown` / `keyup` → 手势识别（单击 / 双击 / 长按 / 按住）
 * - **动作执行**：插入文本、发送、滚动、换行、清空、模拟快捷键、开关面板…
 * - **语音**：`getUserMedia` 录音 → 解码 → 重采样 → canonical WAV → 交给宿主转写
 * - **UI**：`shell.overlay` 上的悬浮快捷面板与录音指示、输入框左侧的按住说话按钮、
 *   `settings.section` 里的完整配置页
 *
 * ## 为什么按键与录音在浏览器侧
 *
 * 遥控器在 Windows 上就是一个标准 BLE HID 键盘，按键最终以标准键盘事件到达页面；
 * 麦克风用系统默认录音设备即可。于是本插件**零原生依赖**：不用编译、不用管理员权限、
 * 不用原生音频桥，也不必去碰 Windows 把 `0x80/0x81/0xF1` 三个 usage 丢掉的那一层。
 *
 * ## 已知的取舍（README 里也写了）
 *
 * - 页面收不到"这个键来自遥控器"的设备身份，所以只能靠"键码 → 逻辑按键"的映射 +
 *   学习模式；如果你的物理键盘也按 F5，它同样会触发语音键绑定。
 * - 页面必须处于焦点（也就是 DSH 窗口在前台）才能接管按键。这对"对着输入框说话"
 *   这个主场景是正确的，但不能用来在后台全局接管。
 */

window.__ModuleLoader__.load({
  id: 'dsh-xiaomi-remote-2-pro',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')
    const h = react.createElement

    const name = 'xiaomi-remote-2-pro'
    const inject = ['slots']

    /** 本插件 HTTP API 的前缀，与宿主半区一致。 */
    const API = '/dsh-remote2pro/api'

    /** 状态轮询间隔。 */
    const POLL_MS = 3000

    // ────────────────────────────────────────────────────────────────────────────
    // 样式：模块加载时注入一次（Lane 1 的通行做法，客户端沙箱不一定跑 effect）
    // ────────────────────────────────────────────────────────────────────────────

    const STYLE_ID = 'dsh-xiaomi-remote-2-pro/client.css'
    const CSS = `
.xr-root { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); }
.xr-muted { color: var(--dsw-alias-label-caption); }
.xr-secondary { color: var(--dsw-alias-label-secondary); }
.xr-card {
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.xr-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.xr-row + .xr-row { margin-top: 6px; }
.xr-between { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.xr-grow { flex: 1 1 auto; min-width: 0; }
.xr-title { font-size: 13px; font-weight: 600; }
.xr-label { color: var(--dsw-alias-label-secondary); min-width: 84px; }
.xr-btn {
  font: inherit; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  border-radius: 7px; padding: 3px 9px;
}
.xr-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.xr-btn:disabled { color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-caption)); cursor: default; }
.xr-btn-primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.xr-btn-danger { color: var(--dsw-alias-state-error-primary); }
.xr-btn-sm { padding: 1px 6px; font-size: 11px; }
.xr-input, .xr-select, .xr-textarea {
  font: inherit; color: inherit;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 7px; padding: 3px 7px; min-width: 0;
}
.xr-textarea { width: 100%; resize: vertical; min-height: 44px; font-family: inherit; }
.xr-select { cursor: pointer; }
.xr-badge {
  display: inline-flex; align-items: center; gap: 4px;
  border-radius: 999px; padding: 1px 7px; font-size: 11px;
  border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
}
.xr-badge-ok { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }
.xr-badge-warn { color: var(--dsw-alias-state-warn-primary); border-color: currentColor; }
.xr-badge-err { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }
.xr-badge-idle { color: var(--dsw-alias-state-idle-primary); border-color: currentColor; }
.xr-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; display: inline-block; }
.xr-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
.xr-mapKey { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 8px; margin-top: 8px; }
.xr-mapKey:first-child { border-top: none; padding-top: 0; margin-top: 0; }
.xr-gesture {
  display: grid; grid-template-columns: 78px 132px 1fr auto;
  gap: 6px; align-items: start; margin-top: 5px;
}
.xr-params { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; }
.xr-log { max-height: 190px; overflow-y: auto; }
.xr-logRow {
  display: grid; grid-template-columns: 66px 82px 74px 1fr;
  gap: 6px; padding: 2px 0;
  border-bottom: 1px dashed var(--dsw-alias-border-l1);
}
.xr-warn {
  border-left: 3px solid var(--dsw-alias-state-warn-primary);
  background: var(--dsw-alias-interactive-bg-hover);
  border-radius: 0 7px 7px 0;
  padding: 5px 9px; margin-top: 5px; color: var(--dsw-alias-label-secondary);
}
.xr-err {
  border-left: 3px solid var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-interactive-bg-hover));
  border-radius: 0 7px 7px 0;
  padding: 5px 9px; margin-top: 5px; color: var(--dsw-alias-state-error-primary);
}
.xr-hint { color: var(--dsw-alias-label-caption); font-size: 11px; margin-top: 3px; }

/* 悬浮快捷面板 */
.xr-overlay { position: fixed; z-index: 60; pointer-events: none; }
.xr-overlay > * { pointer-events: auto; }
.xr-panel {
  position: fixed; left: 16px; bottom: 16px; width: min(330px, calc(100vw - 32px));
  max-height: min(62vh, 560px); overflow-y: auto;
  border: 1px solid var(--dsw-alias-border-inverted, var(--dsw-alias-border-l2));
  background: var(--dsw-alias-bg-overlay);
  box-shadow: var(--dsw-shadow-lv3, 0 8px 24px rgb(0 0 0 / 18%));
  border-radius: 12px; padding: 10px 12px;
}
.xr-hud {
  position: fixed; left: 50%; bottom: 92px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px;
  border: 1px solid var(--dsw-alias-border-inverted, var(--dsw-alias-border-l2));
  background: var(--dsw-alias-bg-overlay);
  box-shadow: var(--dsw-shadow-lv3, 0 8px 24px rgb(0 0 0 / 18%));
  border-radius: 999px; padding: 6px 14px;
}
.xr-toast {
  position: fixed; left: 50%; bottom: 148px; transform: translateX(-50%);
  max-width: min(560px, calc(100vw - 40px));
  border: 1px solid var(--dsw-alias-border-inverted, var(--dsw-alias-border-l2));
  background: var(--dsw-alias-bg-overlay);
  box-shadow: var(--dsw-shadow-lv3, 0 8px 24px rgb(0 0 0 / 18%));
  border-radius: 9px; padding: 7px 12px;
}
.xr-rec { color: var(--dsw-alias-state-error-primary); }

/* 输入框左侧的按住说话按钮 */
.xr-mic {
  display: inline-flex; align-items: center; gap: 4px;
  height: 26px; padding: 0 7px; cursor: pointer;
  border: none; border-radius: 22px; background: 0 0;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px;
}
.xr-mic:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.xr-mic:disabled { color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-caption)); cursor: default; }
.xr-micActive { color: var(--dsw-alias-state-error-primary); }
.xr-mic svg { flex: none; }
`

    const doc = typeof document === 'undefined' ? null : document
    if (doc !== null && doc.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) === null) {
      const tag = doc.createElement('style')
      tag.dataset.plugin = 'dsh-xiaomi-remote-2-pro'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      doc.head.appendChild(tag)
    }

    // ────────────────────────────────────────────────────────────────────────────
    // 极小的外部 store：多个 slot 组件共享同一份状态
    // ────────────────────────────────────────────────────────────────────────────

    function createStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set(patch) {
          const next = typeof patch === 'function' ? patch(state) : patch
          if (next === null || next === undefined) return
          state = { ...state, ...next }
          for (const listener of Array.from(listeners)) {
            try {
              listener()
            } catch (error) {
              console.error('[xiaomi-remote-2-pro] store 订阅者抛异常', error)
            }
          }
        },
      }
    }

    const initialState = {
      ready: false,
      error: '',
      config: null,
      catalog: null,
      runtime: null,
      speech: null,
      device: null,
      warnings: [],
      fence: null,
      log: [],
      panelOpen: false,
      learningKey: null,
      recording: false,
      recordingStartedAt: 0,
      busy: false,
      toast: '',
      toastTone: 'info',
      toastAt: 0,
      lastKeyText: '',
      lastRawCode: '',
    }
    const store = createStore(initialState)

    function toast(message, tone = 'info') {
      store.set({ toast: message, toastTone: tone, toastAt: Date.now() })
    }

    /**
     * 宿主 API 调用。**注意**：配置写入会让 DSH 重新加载本插件，连接可能被掐断——
     * 这种情况下按"大概率已生效"处理，由随后的 state 轮询去确认。
     */
    async function api(path, options = {}) {
      const response = await fetch(`${API}${path}`, {
        method: options.method ?? 'GET',
        headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        cache: 'no-store',
      })
      const text = await response.text()
      let value = {}
      if (text !== '') {
        try {
          value = JSON.parse(text)
        } catch {
          value = { ok: false, error: text.slice(0, 400) }
        }
      }
      if (!response.ok && value.ok !== false) value = { ok: false, error: `HTTP ${response.status}` }
      return value
    }

    // ────────────────────────────────────────────────────────────────────────────
    // WAV / base64 工具（与宿主半区 lib/wav.js 同源的精简副本，浏览器侧只读不写）
    // ────────────────────────────────────────────────────────────────────────────

    function bytesToBase64(bytes) {
      let binary = ''
      const chunk = 0x8000
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk))
      }
      return window.btoa(binary)
    }

    function encodeWav(samples, sampleRate) {
      const dataBytes = samples.length * 2
      const buffer = new ArrayBuffer(44 + dataBytes)
      const view = new DataView(buffer)
      const ascii = (offset, text) => {
        for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index))
      }
      ascii(0, 'RIFF')
      view.setUint32(4, 36 + dataBytes, true)
      ascii(8, 'WAVE')
      ascii(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      ascii(36, 'data')
      view.setUint32(40, dataBytes, true)
      for (let index = 0; index < samples.length; index += 1) {
        const clamped = Math.max(-1, Math.min(1, samples[index]))
        view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
      }
      return new Uint8Array(buffer)
    }

    function toMono(interleaved, channels) {
      if (channels <= 1) return interleaved
      const frames = Math.floor(interleaved.length / channels)
      const out = new Float32Array(frames)
      for (let frame = 0; frame < frames; frame += 1) {
        let sum = 0
        for (let channel = 0; channel < channels; channel += 1) sum += interleaved[frame * channels + channel]
        out[frame] = sum / channels
      }
      return out
    }

    function resampleLinear(samples, sourceRate, targetRate) {
      if (sourceRate === targetRate || samples.length === 0) return samples
      const ratio = targetRate / sourceRate
      const outLength = Math.max(1, Math.round(samples.length * ratio))
      const out = new Float32Array(outLength)
      for (let index = 0; index < outLength; index += 1) {
        const position = index / ratio
        const left = Math.floor(position)
        const right = Math.min(left + 1, samples.length - 1)
        const weight = position - left
        out[index] = samples[left] * (1 - weight) + samples[right] * weight
      }
      return out
    }

    /** 峰值归一化：遥控器/耳麦的输入电平常常很低，16-bit 量化前抬一下信噪比。 */
    function normalisePeak(samples, targetPeak = 0.9) {
      let peak = 0
      for (let index = 0; index < samples.length; index += 1) {
        const value = Math.abs(samples[index])
        if (value > peak) peak = value
      }
      if (peak < 1e-4 || peak >= targetPeak) return samples
      const gain = targetPeak / peak
      const out = new Float32Array(samples.length)
      for (let index = 0; index < samples.length; index += 1) out[index] = samples[index] * gain
      return out
    }

    // ────────────────────────────────────────────────────────────────────────────
    // 按键接管：键码归一化、手势引擎
    // ────────────────────────────────────────────────────────────────────────────

    /** 逻辑按键的中文名（等宿主的目录到位前先兜底）。 */
    const FALLBACK_KEY_LABELS = {
      voice: '语音键',
      ok: '确定',
      back: '返回',
      home: '主页',
      menu: '菜单',
      up: '上',
      down: '下',
      left: '左',
      right: '右',
      volUp: '音量+',
      volDown: '音量-',
      mute: '静音',
      power: '电源',
      tv: '信号源',
      unknown: '未识别',
    }

    const GESTURE_LABELS = { tap: '单击', doubleTap: '双击', longPress: '长按', hold: '按住/松开' }
    const GESTURE_ORDER = ['tap', 'doubleTap', 'longPress', 'hold']

    const FALLBACK_CODE_MAP = {
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
    }

    /**
     * 当前生效的"键码 → 逻辑按键"表。
     *
     * 优先用宿主目录里的 `defaultCodeMap`，这样默认表只有一份事实来源（`lib/keys.js`），
     * `FALLBACK_CODE_MAP` 只在状态还没拉回来时兜底——避免两边漂移。
     */
    function activeCodeMap() {
      const state = store.getSnapshot()
      const learned = state.config?.learnedCodes ?? {}
      const defaults = state.catalog?.defaultCodeMap ?? FALLBACK_CODE_MAP
      return { ...defaults, ...learned }
    }

    /** 键盘事件 → 逻辑按键。优先 `code`，回退 `key`。 */
    function logicalKeyOf(event) {
      const map = activeCodeMap()
      const code = typeof event.code === 'string' ? event.code : ''
      if (code !== '' && Object.prototype.hasOwnProperty.call(map, code)) return map[code]
      const key = typeof event.key === 'string' ? event.key : ''
      if (key !== '' && Object.prototype.hasOwnProperty.call(map, key)) return map[key]
      return 'unknown'
    }

    function describeEvent(event) {
      const code = typeof event.code === 'string' ? event.code : ''
      const key = typeof event.key === 'string' ? event.key : ''
      if (code !== '' && key !== '' && code !== key) return `${key} (${code})`
      return code !== '' ? code : key
    }

    // ── 手势引擎（与宿主 lib/mapping.js 同一套语义，浏览器侧需要同步版本） ──

    function createGestureEngine(options) {
      const doubleTapMs = options.doubleTapMs
      const longPressMs = options.longPressMs
      const has = options.hasGesture
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
        down(logicalKey, now) {
          const state = stateOf(logicalKey)
          if (state.isDown) return [] // 忽略系统自动重复
          state.isDown = true
          state.downAt = now
          state.longPressFired = false
          return has(logicalKey, 'hold') ? [{ logicalKey, gesture: 'hold', phase: 'press' }] : []
        },
        up(logicalKey, now) {
          const state = stateOf(logicalKey)
          if (!state.isDown) return []
          state.isDown = false
          const out = []
          if (has(logicalKey, 'hold')) out.push({ logicalKey, gesture: 'hold', phase: 'release' })
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
              state.awaitingDouble = true
              state.tapDeadline = now + doubleTapMs
            }
            return out
          }
          if (wantsTap) out.push({ logicalKey, gesture: 'tap', phase: 'press' })
          return out
        },
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
        nextDeadline() {
          let deadline = null
          for (const state of states.values()) {
            const candidates = []
            if (state.isDown && !state.longPressFired) candidates.push(state.downAt + longPressMs)
            if (state.awaitingDouble) candidates.push(state.tapDeadline)
            for (const candidate of candidates) if (deadline === null || candidate < deadline) deadline = candidate
          }
          return deadline
        },
        reset() {
          states.clear()
        },
      }
    }

    // ────────────────────────────────────────────────────────────────────────────
    // 输入框 / 会话的 DOM 助手
    //
    // DSH 没有公开"向草稿写入文本"的客户端服务，因此这里只能用 DOM。这不是最优雅的
    // 做法，所以每一处都做了兜底与明确报错：拿不到输入框就退化成复制到剪贴板并提示，
    // 绝不静默失败。README 的「已知限制」里写明了这一点。
    // ────────────────────────────────────────────────────────────────────────────

    function isVisible(element) {
      if (element === null || element === undefined) return false
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      const style = window.getComputedStyle(element)
      return style.visibility !== 'hidden' && style.display !== 'none'
    }

    function isTextEntry(element) {
      if (element === null || element === undefined) return false
      const tag = element.tagName
      if (tag === 'TEXTAREA') return true
      if (tag === 'INPUT') {
        const type = String(element.getAttribute('type') ?? 'text').toLowerCase()
        return ['text', 'search', 'url', 'email', 'password', 'tel'].includes(type)
      }
      return element.isContentEditable === true
    }

    /** 找到当前会话的输入框。优先焦点元素，其次可见的多行输入。 */
    function findComposer() {
      const active = document.activeElement
      if (isTextEntry(active) && isVisible(active)) return active

      const candidates = []
      for (const element of document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')) {
        if (!isTextEntry(element) || !isVisible(element)) continue
        const rect = element.getBoundingClientRect()
        // 输入框通常在视口下半部，且有一定宽度
        let score = rect.width
        if (rect.top > window.innerHeight * 0.35) score += 2000
        if (element.tagName === 'TEXTAREA' || element.isContentEditable) score += 1000
        candidates.push({ element, score })
      }
      if (candidates.length === 0) return null
      candidates.sort((left, right) => right.score - left.score)
      return candidates[0].element
    }

    /** 在光标处插入文本。React 受控组件必须走原生 setter + input 事件。 */
    function insertTextInto(element, text) {
      if (element === null) return false
      element.focus()

      if (element.isContentEditable === true) {
        const selection = window.getSelection()
        if (selection !== null && selection.rangeCount > 0 && element.contains(selection.anchorNode)) {
          // execCommand 已标记废弃，但它是唯一能让 React 正常收到 input 的路径
          if (document.execCommand('insertText', false, text)) return true
        }
        const range = document.createRange()
        range.selectNodeContents(element)
        range.collapse(false)
        if (selection !== null) {
          selection.removeAllRanges()
          selection.addRange(range)
        }
        if (document.execCommand('insertText', false, text)) return true
        // 最后兜底：直接改 textContent 并派发 input
        element.textContent = `${element.textContent ?? ''}${text}`
        element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
        return true
      }

      const prototype = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
      const start = element.selectionStart ?? element.value.length
      const end = element.selectionEnd ?? element.value.length
      const next = `${element.value.slice(0, start)}${text}${element.value.slice(end)}`
      if (typeof setter === 'function') setter.call(element, next)
      else element.value = next
      element.selectionStart = start + text.length
      element.selectionEnd = start + text.length
      element.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }

    /** 取输入框当前文本（用于 clear / 判断是否为空）。 */
    function readComposerText(element) {
      if (element === null) return ''
      return element.isContentEditable === true ? (element.textContent ?? '') : (element.value ?? '')
    }

    function clearComposer(element) {
      if (element === null) return false
      element.focus()
      if (element.isContentEditable === true) {
        const selection = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(element)
        if (selection !== null) {
          selection.removeAllRanges()
          selection.addRange(range)
        }
        if (document.execCommand('delete')) return true
        element.textContent = ''
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
        return true
      }
      const prototype = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
      if (typeof setter === 'function') setter.call(element, '')
      else element.value = ''
      element.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }

    function dispatchKey(target, type, key, modifiers = {}) {
      const event = new KeyboardEvent(type, {
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        bubbles: true,
        cancelable: true,
        ctrlKey: modifiers.ctrl === true,
        altKey: modifiers.alt === true,
        shiftKey: modifiers.shift === true,
        metaKey: modifiers.meta === true,
      })
      target.dispatchEvent(event)
      return event
    }

    /** 提交当前草稿：优先派发 Enter，失败再找发送按钮点它。 */
    function submitComposer(element) {
      const target = element ?? findComposer()
      if (target !== null) {
        target.focus()
        dispatchKey(target, 'keydown', 'Enter')
        dispatchKey(target, 'keypress', 'Enter')
        dispatchKey(target, 'keyup', 'Enter')
        return true
      }
      // 退路：找形似"发送"的按钮
      for (const button of document.querySelectorAll('button')) {
        if (!isVisible(button)) continue
        const label = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''} ${button.textContent ?? ''}`
        if (/发送|提交|send|submit/i.test(label) && button.disabled !== true) {
          button.click()
          return true
        }
      }
      return false
    }

    /** 找到会话内容的滚动容器：可见、可滚动、且滚动余量最大。 */
    function findTranscriptScroller() {
      let best = null
      let bestOverflow = 0
      for (const element of document.querySelectorAll('div, main, section')) {
        if (!isVisible(element)) continue
        const overflow = element.scrollHeight - element.clientHeight
        if (overflow <= 40) continue
        const style = window.getComputedStyle(element)
        if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue
        if (overflow > bestOverflow) {
          bestOverflow = overflow
          best = element
        }
      }
      return best
    }

    function scrollTranscript(direction, amount) {
      const scroller = findTranscriptScroller()
      if (scroller === null) return false
      const step = Number.isFinite(amount) ? amount : 320
      if (direction === 'top') scroller.scrollTo({ top: 0, behavior: 'smooth' })
      else if (direction === 'bottom') scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
      else if (direction === 'up') scroller.scrollBy({ top: -step, behavior: 'smooth' })
      else scroller.scrollBy({ top: step, behavior: 'smooth' })
      return true
    }

    async function copyToClipboard(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        try {
          const area = document.createElement('textarea')
          area.value = text
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          const ok = document.execCommand('copy')
          document.body.removeChild(area)
          return ok
        } catch {
          return false
        }
      }
    }

    // ────────────────────────────────────────────────────────────────────────────
    // 键盘日志：本地立即显示，同时异步上报宿主（宿主保留环形缓冲给 Agent 看）
    // ────────────────────────────────────────────────────────────────────────────

    const pendingLog = []
    let logFlushTimer = 0

    function pushLog(entry) {
      const snapshot = store.getSnapshot()
      const limit = snapshot.config?.advanced?.logLimit ?? 200
      const next = [...snapshot.log, { at: Date.now(), ...entry }]
      while (next.length > limit) next.shift()
      store.set({ log: next })

      pendingLog.push({ at: Date.now(), ...entry })
      if (logFlushTimer === 0) {
        logFlushTimer = window.setTimeout(() => {
          logFlushTimer = 0
          const batch = pendingLog.splice(0, pendingLog.length)
          if (batch.length === 0) return
          api('/log', { method: 'POST', body: { entries: batch } }).catch(() => {})
        }, 500)
      }
    }

    // ────────────────────────────────────────────────────────────────────────────
    // 语音：录音 → WAV → 宿主转写 → 写入草稿
    // ────────────────────────────────────────────────────────────────────────────

    const recorder = {
      active: false,
      stream: null,
      mediaRecorder: null,
      chunks: [],
      autoStopTimer: 0,
      async start() {
        if (this.active) return { ok: true, already: true }
        const config = store.getSnapshot().config
        if (navigator.mediaDevices?.getUserMedia === undefined) {
          return { ok: false, reason: '当前环境不支持 getUserMedia，无法录音。' }
        }
        let stream
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
          })
        } catch (error) {
          return { ok: false, reason: `无法访问麦克风：${String(error?.message ?? error)}` }
        }

        const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
        const mimeType = mimeCandidates.find((candidate) => window.MediaRecorder?.isTypeSupported?.(candidate) === true)

        this.stream = stream
        this.chunks = []
        this.mediaRecorder = mimeType === undefined
          ? new window.MediaRecorder(stream)
          : new window.MediaRecorder(stream, { mimeType })
        this.mediaRecorder.ondataavailable = (event) => {
          if (event.data !== null && event.data.size > 0) this.chunks.push(event.data)
        }
        this.mediaRecorder.start()
        this.active = true
        store.set({ recording: true, recordingStartedAt: Date.now() })
        pushLog({ type: 'voice', phase: 'start' })

        const maxSeconds = config?.voice?.maxSeconds ?? 30
        this.autoStopTimer = window.setTimeout(() => {
          void stopDictationWithSubmit('达到最长录音时间')
        }, maxSeconds * 1000)

        return { ok: true }
      },

      /** 停止录音并返回一段 canonical WAV 的 base64。 */
      async stop() {
        if (!this.active || this.mediaRecorder === null) return { ok: false, reason: '当前没有在录音。' }
        const mediaRecorder = this.mediaRecorder
        const stream = this.stream
        window.clearTimeout(this.autoStopTimer)
        this.autoStopTimer = 0

        const blob = await new Promise((resolve) => {
          mediaRecorder.onstop = () => resolve(new Blob(this.chunks, { type: mediaRecorder.mimeType || 'audio/webm' }))
          try {
            mediaRecorder.stop()
          } catch {
            resolve(new Blob(this.chunks, { type: 'audio/webm' }))
          }
        })

        this.active = false
        this.mediaRecorder = null
        this.stream = null
        this.chunks = []
        store.set({ recording: false, recordingStartedAt: 0 })
        try {
          for (const track of stream?.getTracks?.() ?? []) track.stop()
        } catch {
          /* 忽略 */
        }

        if (blob.size === 0) return { ok: false, reason: '没有录到音频。' }

        const config = store.getSnapshot().config
        const targetRate = config?.voice?.sampleRate ?? 16000
        const AudioContextClass = window.AudioContext ?? window.webkitAudioContext
        if (AudioContextClass === undefined) return { ok: false, reason: '当前环境没有 AudioContext，无法解码音频。' }

        let context
        try {
          context = new AudioContextClass()
          const decoded = await context.decodeAudioData(await blob.arrayBuffer())
          const channels = decoded.numberOfChannels
          let samples = decoded.getChannelData(0)
          if (channels > 1) {
            // 多声道：逐样本平均
            const merged = new Float32Array(decoded.length)
            for (let channel = 0; channel < channels; channel += 1) {
              const data = decoded.getChannelData(channel)
              for (let index = 0; index < data.length; index += 1) merged[index] += data[index] / channels
            }
            samples = merged
          }
          const mono = toMono(samples, 1)
          const resampled = resampleLinear(mono, decoded.sampleRate, targetRate)
          const normalised = normalisePeak(resampled)
          const wav = encodeWav(normalised, targetRate)
          return { ok: true, audioBase64: bytesToBase64(wav), seconds: decoded.duration, sampleRate: targetRate }
        } catch (error) {
          return { ok: false, reason: `音频解码失败：${String(error?.message ?? error)}` }
        } finally {
          try {
            await context?.close?.()
          } catch {
            /* 忽略 */
          }
        }
      },
    }

    /** 一次完整的"按住说话"：开始录音。 */
    async function startDictation() {
      const outcome = await recorder.start()
      if (!outcome.ok) {
        toast(outcome.reason ?? '无法开始录音', 'error')
        pushLog({ type: 'voice', phase: 'failed', message: outcome.reason })
      }
      return outcome
    }

    /**
     * 结束录音 → 转写 → 写入草稿。
     * @param {string} [reason] 触发结束的原因，只用于日志
     */
    async function stopDictation(reason) {
      if (!recorder.active) return { ok: false, reason: '当前没有在录音。' }
      const config = store.getSnapshot().config
      const recorded = await recorder.stop()
      if (!recorded.ok) {
        toast(recorded.reason ?? '录音失败', 'error')
        pushLog({ type: 'voice', phase: 'failed', message: recorded.reason })
        return recorded
      }

      store.set({ busy: true })
      try {
        const result = await api('/transcribe', {
          method: 'POST',
          body: { audioBase64: recorded.audioBase64 },
        })
        if (!result.ok) {
          toast(result.error ?? '转写失败', 'error')
          pushLog({ type: 'voice', phase: 'failed', message: result.error, reason })
          return result
        }
        const text = String(result.text ?? '').trim()
        pushLog({ type: 'voice', phase: 'transcribed', text, seconds: recorded.seconds, reason })
        if (text === '') {
          toast('没有识别到内容', 'warn')
          return { ok: true, text: '' }
        }
        await deliverText(text, config?.voice?.autoSubmit === true)
        return { ok: true, text }
      } finally {
        store.set({ busy: false })
      }
    }

    /** 把一段文字送进草稿（或剪贴板）。 */
    async function deliverText(text, autoSubmit) {
      const mode = store.getSnapshot().config?.voice?.insertMode ?? 'composer'
      if (mode === 'off') {
        await copyToClipboard(text)
        toast(`已复制：${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`)
        return
      }
      if (mode === 'clipboard') {
        const ok = await copyToClipboard(text)
        toast(ok ? `已复制到剪贴板：${text.slice(0, 40)}…` : '复制失败', ok ? 'info' : 'error')
        return
      }

      const composer = findComposer()
      if (composer === null) {
        const ok = await copyToClipboard(text)
        toast(
          ok
            ? '没找到输入框，已把识别结果复制到剪贴板，请手动粘贴。'
            : '没找到输入框，且复制失败。',
          ok ? 'warn' : 'error',
        )
        return
      }

      insertTextInto(composer, text)
      if (autoSubmit) window.setTimeout(() => submitComposer(composer), 60)
    }

    // ────────────────────────────────────────────────────────────────────────────
    // 动作执行
    // ────────────────────────────────────────────────────────────────────────────

    const HOST_ACTIONS = new Set(['http', 'exec'])

    /**
     * 执行一个动作。
     *
     * @param {object} action
     * @param {'press'|'release'} phase
     * @param {{ logicalKey?: string, gesture?: string }} [context]
     */
    async function runAction(action, phase, context = {}) {
      const kind = action?.kind
      if (kind === undefined || kind === 'none') return

      // 只有 phaseAware 的动作关心 release
      const phaseAware = kind === 'dictate' || kind === 'dictateSubmit'
      if (phase === 'release' && !phaseAware) return

      pushLog({ type: 'action', kind, phase, logicalKey: context.logicalKey, gesture: context.gesture })

      switch (kind) {
        case 'dictate':
        case 'dictateSubmit': {
          if (phase === 'release') {
            await stopDictationWithSubmit(`${context.logicalKey ?? '?'}/${context.gesture ?? '?'}`)
            return
          }
          // 记录本次"按住说话"结束后是否需要提交，由 stopDictationWithSubmit 消费
          pendingSubmitAfterDictation = kind === 'dictateSubmit'
          await startDictation()
          return
        }

        case 'insertText': {
          const composer = findComposer()
          if (composer === null) {
            const ok = await copyToClipboard(action.text ?? '')
            toast(ok ? '没找到输入框，已复制文本到剪贴板。' : '没找到输入框。', ok ? 'warn' : 'error')
            return
          }
          insertTextInto(composer, action.text ?? '')
          return
        }

        case 'prompt': {
          const composer = findComposer()
          if (composer === null) {
            await copyToClipboard(action.text ?? '')
            toast('没找到输入框，提示词已复制到剪贴板。', 'warn')
            return
          }
          insertTextInto(composer, action.text ?? '')
          window.setTimeout(() => submitComposer(composer), 60)
          return
        }

        case 'submit': {
          if (!submitComposer(findComposer())) toast('没找到可发送的输入框。', 'warn')
          return
        }

        case 'newline': {
          const composer = findComposer()
          if (composer === null) return
          insertTextInto(composer, '\n')
          return
        }

        case 'clear': {
          const composer = findComposer()
          if (composer === null) return
          if (readComposerText(composer).trim() !== '') clearComposer(composer)
          return
        }

        case 'key': {
          const chord = String(action.chord ?? '')
          const parts = chord.split('+').map((part) => part.trim()).filter(Boolean)
          const modifiers = { ctrl: false, alt: false, shift: false, meta: false }
          let mainKey = ''
          for (const part of parts) {
            const lower = part.toLowerCase()
            if (lower === 'ctrl' || lower === 'control') modifiers.ctrl = true
            else if (lower === 'alt') modifiers.alt = true
            else if (lower === 'shift') modifiers.shift = true
            else if (['meta', 'cmd', 'win', 'super'].includes(lower)) modifiers.meta = true
            else mainKey = part
          }
          if (mainKey === '') return
          const target = document.activeElement ?? document.body
          dispatchKey(target, 'keydown', mainKey, modifiers)
          dispatchKey(target, 'keyup', mainKey, modifiers)
          return
        }

        case 'scroll': {
          if (!scrollTranscript(action.direction ?? 'down', action.amount)) {
            toast('没找到可滚动的会话区域。', 'warn')
          }
          return
        }

        case 'panel':
          store.set({ panelOpen: !store.getSnapshot().panelOpen })
          return

        case 'log':
          toast(`${FALLBACK_KEY_LABELS[context.logicalKey] ?? context.logicalKey ?? '按键'} / ${GESTURE_LABELS[context.gesture] ?? ''}`)
          return

        default: {
          if (HOST_ACTIONS.has(kind)) {
            const result = await api('/host-action', { method: 'POST', body: { action } }).catch((error) => ({
              ok: false,
              error: String(error?.message ?? error),
            }))
            if (!result.ok) toast(result.error ?? `${kind} 动作执行失败`, 'error')
            else toast(`${kind} 动作已执行`)
            return
          }
          toast(`未知动作 ${String(kind)}`, 'error')
        }
      }
    }

    /** `dictateSubmit` 需要在这次录音结束后提交，用一个模块级标记串起来。 */
    let pendingSubmitAfterDictation = false

    // 让 stopDictation 尊重 dictateSubmit 的意图
    const originalStopDictation = stopDictation
    async function stopDictationWithSubmit(reason) {
      const autoSubmit = pendingSubmitAfterDictation
      pendingSubmitAfterDictation = false
      const config = store.getSnapshot().config
      if (autoSubmit && config?.voice?.autoSubmit !== true) {
        // 临时把 autoSubmit 打开，跑完再恢复
        store.set({ config: { ...config, voice: { ...config.voice, autoSubmit: true } } })
        try {
          return await originalStopDictation(reason)
        } finally {
          const after = store.getSnapshot().config
          store.set({ config: { ...after, voice: { ...after.voice, autoSubmit: false } } })
        }
      }
      return originalStopDictation(reason)
    }

    // ────────────────────────────────────────────────────────────────────────────
    // 学习模式：把"下一个按下的键"绑定到某个逻辑按键
    // ────────────────────────────────────────────────────────────────────────────

    async function learnNextKey(logicalKey) {
      store.set({ learningKey: logicalKey })
      toast(`请按下遥控器上的「${FALLBACK_KEY_LABELS[logicalKey] ?? logicalKey}」键…`)
    }

    async function commitLearnedCode(code, logicalKey) {
      const learnedCodes = { ...(store.getSnapshot().config?.learnedCodes ?? {}), [code]: logicalKey }
      store.set((state) => ({
        learningKey: null,
        config: state.config === null ? null : { ...state.config, learnedCodes },
      }))
      const result = await api('/learn', { method: 'POST', body: { code, logicalKey } }).catch((error) => ({
        ok: false,
        error: String(error?.message ?? error),
      }))
      pushLog({ type: 'learn', code, logicalKey, ok: result.ok === true })
      toast(
        result.ok === true
          ? `已把 ${code} 绑定到「${FALLBACK_KEY_LABELS[logicalKey] ?? logicalKey}」`
          : `绑定失败：${result.error ?? '未知错误'}`,
        result.ok === true ? 'info' : 'error',
      )
    }

    // ────────────────────────────────────────────────────────────────────────────
    // 状态轮询
    // ────────────────────────────────────────────────────────────────────────────

    let pollTimer = 0
    let pollInFlight = false
    /** 只在第一次拿到配置时应用 `ui.panelOpenByDefault`，之后尊重用户的手动开关。 */
    let panelInitialised = false

    async function refreshState() {
      if (pollInFlight) return
      pollInFlight = true
      try {
        const state = await api('/state')
        if (state.ok !== true) {
          store.set({ ready: false, error: state.error ?? '宿主 API 不可用。' })
          return
        }
        const patch = {
          ready: true,
          error: '',
          config: state.config ?? null,
          catalog: state.catalog ?? null,
          runtime: state.runtime ?? null,
          speech: state.speech ?? null,
          device: state.device ?? null,
          warnings: state.warnings ?? [],
          fence: state.fence ?? null,
        }
        if (!panelInitialised && state.config !== null && state.config !== undefined) {
          panelInitialised = true
          patch.panelOpen = state.config.ui?.panelOpenByDefault === true
        }
        store.set(patch)
      } catch (error) {
        store.set({ ready: false, error: `无法连接宿主 API：${String(error?.message ?? error)}` })
      } finally {
        pollInFlight = false
      }
    }

    /** 写配置。写完立刻刷新（插件可能被重新加载，响应会断）。 */
    async function saveConfig(patch) {
      store.set({ busy: true })
      try {
        const result = await api('/config', { method: 'POST', body: patch }).catch((error) => ({
          ok: false,
          error: String(error?.message ?? error),
        }))
        if (result.ok) {
          if (result.config !== undefined) store.set({ config: result.config })
          if (Array.isArray(result.warnings)) store.set({ warnings: result.warnings })
          toast('配置已保存')
        } else {
          toast(result.error ?? result.reason ?? '配置保存失败', 'error')
        }
        // 写入可能触发了插件重载，稍后重新拉一次状态
        window.setTimeout(() => void refreshState(), 400)
        return result
      } finally {
        store.set({ busy: false })
      }
    }

    // ────────────────────────────────────────────────────────────────────────────
    // 组件
    // ────────────────────────────────────────────────────────────────────────────

    function useStore() {
      return react.useSyncExternalStore(store.subscribe, store.getSnapshot)
    }

    function Badge({ tone = 'idle', children }) {
      return h('span', { className: `xr-badge xr-badge-${tone}` }, h('span', { className: 'xr-dot' }), children)
    }

    /** 设备在线状态：以"最近收到按键的时间"为准，PnP 探测只作为补充。 */
    function deviceBadge(state) {
      const lastSeenAt = state.runtime?.lastSeenAt ?? 0
      const ageSeconds = lastSeenAt === 0 ? Infinity : (Date.now() - lastSeenAt) / 1000
      if (ageSeconds < 120) return h(Badge, { tone: 'ok' }, `活跃（${Math.round(ageSeconds)} 秒前）`)
      if (state.device?.status === 'connected') return h(Badge, { tone: 'ok' }, '已配对')
      if (state.device?.status === 'absent') return h(Badge, { tone: 'warn' }, '未检测到设备')
      if (state.device?.status === 'unsupported') return h(Badge, { tone: 'idle' }, '无法探测')
      return h(Badge, { tone: 'idle' }, '等待按键')
    }

    /** 输入框左侧的按住说话按钮。 */
    function MicButton() {
      const state = useStore()
      const recording = state.recording === true
      const unavailable = state.ready !== true

      const stop = () => {
        if (recorder.active) void stopDictationWithSubmit('按钮松开')
      }

      return h(
        'button',
        {
          type: 'button',
          className: recording ? 'xr-mic xr-micActive' : 'xr-mic',
          title: '按住说话（也可以按遥控器语音键，或 Ctrl+Alt+Space）',
          'aria-label': '按住说话',
          disabled: unavailable,
          onPointerDown: (event) => {
            event.preventDefault()
            if (!recorder.active) void startDictation()
          },
          onPointerUp: stop,
          onPointerLeave: stop,
          onKeyDown: (event) => {
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault()
              if (!recorder.active) void startDictation()
            }
          },
          onKeyUp: (event) => {
            if (event.key === ' ' || event.key === 'Enter') stop()
          },
        },
        h(
          'svg',
          { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
          h('path', {
            d: 'M8 1.75a2.25 2.25 0 0 1 2.25 2.25v4a2.25 2.25 0 0 1-4.5 0v-4A2.25 2.25 0 0 1 8 1.75Z',
            stroke: 'currentColor',
            strokeWidth: 1.4,
          }),
          h('path', {
            d: 'M3.75 7.5v.5a4.25 4.25 0 0 0 8.5 0v-.5M8 12.25V14.5',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
          }),
        ),
        recording ? '收音中' : '说话',
      )
    }

    /** 悬浮层：录音指示、提示条、快捷面板。 */
    function Overlay() {
      const state = useStore()
      const recording = state.recording === true
      const seconds = recording && state.recordingStartedAt > 0
        ? ((Date.now() - state.recordingStartedAt) / 1000).toFixed(0)
        : '0'
      const showToast = state.toast !== '' && Date.now() - state.toastAt < 6000

      return h(
        'div',
        { className: 'xr-root xr-overlay' },
        recording && state.config?.ui?.showIndicator !== false
          ? h(
              'div',
              { className: 'xr-hud' },
              h('span', { className: 'xr-rec' }, '●'),
              h('span', null, `正在收音 ${seconds}s`),
              h('span', { className: 'xr-muted' }, '再按一次语音键结束'),
            )
          : null,
        showToast
          ? h(
              'div',
              { className: state.toastTone === 'error' ? 'xr-toast xr-err' : 'xr-toast' },
              state.toast,
            )
          : null,
        state.panelOpen ? h(QuickPanel, { state }) : null,
      )
    }

    /** 悬浮快捷面板：显示实时状态、最近按键、以及常用开关。 */
    function QuickPanel({ state }) {
      const catalog = state.catalog
      const keys = catalog?.keys ?? []
      const lastKeyId = state.runtime?.lastKeyId ?? ''
      const label = keys.find((key) => key.id === lastKeyId)?.zh ?? FALLBACK_KEY_LABELS[lastKeyId] ?? '—'

      return h(
        'div',
        { className: 'xr-root xr-panel' },
        h(
          'div',
          { className: 'xr-between' },
          h('span', { className: 'xr-title' }, '小米遥控器 2 Pro'),
          h(
            'button',
            { type: 'button', className: 'xr-btn xr-btn-sm', onClick: () => store.set({ panelOpen: false }) },
            '收起',
          ),
        ),
        h(
          'div',
          { className: 'xr-row' },
          deviceBadge(state),
          h(
            Badge,
            { tone: state.speech?.available === true ? 'ok' : 'warn' },
            state.speech?.available === true ? '语音可用' : '语音未启用',
          ),
        ),
        h(
          'div',
          { className: 'xr-row xr-secondary' },
          h('span', null, '最近按键：'),
          h('strong', null, label),
          state.runtime?.lastGesture !== '' && state.runtime?.lastGesture !== undefined
            ? h('span', { className: 'xr-muted' }, GESTURE_LABELS[state.runtime.lastGesture] ?? state.runtime.lastGesture)
            : null,
        ),
        h(
          'div',
          { className: 'xr-row xr-muted xr-mono' },
          state.lastRawCode === '' ? '（按下遥控器任意键看看能不能被识别）' : `原始键码：${state.lastRawCode}`,
        ),
        h(
          'div',
          { className: 'xr-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'xr-btn xr-btn-primary',
              disabled: state.ready !== true,
              onPointerDown: () => {
                if (!recorder.active) void startDictation()
              },
              onPointerUp: () => {
                if (recorder.active) void stopDictationWithSubmit('面板按钮')
              },
            },
            '按住说话',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'xr-btn',
              onClick: () => void saveConfig({ capture: { enabled: state.config?.capture?.enabled !== true } }),
            },
            state.config?.capture?.enabled === true ? '暂停接管' : '开始接管',
          ),
          h(
            'button',
            { type: 'button', className: 'xr-btn', onClick: () => void refreshState() },
            '刷新',
          ),
        ),
        h(
          'div',
          { className: 'xr-hint' },
          '完整配置（按键映射、预设、语音参数）在 设置 → 小米遥控器 2 Pro 里。',
        ),
        state.error !== '' ? h('div', { className: 'xr-err' }, state.error) : null,
        ...(state.warnings ?? []).slice(0, 3).map((warning, index) =>
          h('div', { className: 'xr-warn', key: `warn-${index}` }, warning),
        ),
      )
    }

    // ── 配置页的各块 ────────────────────────────────────────────────────────────

    function Field({ label, children, hint }) {
      return h(
        'div',
        { className: 'xr-row' },
        h('span', { className: 'xr-label' }, label),
        h('span', { className: 'xr-grow xr-params' }, children),
        hint !== undefined ? h('div', { className: 'xr-hint' }, hint) : null,
      )
    }

    function Toggle({ label, checked, disabled, onChange }) {
      return h(
        'label',
        { className: 'xr-row', style: { cursor: disabled === true ? 'default' : 'pointer' } },
        h('input', {
          type: 'checkbox',
          checked: checked === true,
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', null, label),
      )
    }

    /** 单个动作的参数编辑器。 */
    function ActionParams({ action, catalog, onChange }) {
      const kind = action.kind
      const spec = (catalog?.actions ?? []).find((item) => item.kind === kind)

      const textInput = (field, placeholder, multiline) =>
        multiline === true
          ? h('textarea', {
              className: 'xr-textarea',
              value: action[field] ?? '',
              placeholder,
              onChange: (event) => onChange({ ...action, [field]: event.target.value }),
            })
          : h('input', {
              className: 'xr-input xr-grow',
              value: action[field] ?? '',
              placeholder,
              onChange: (event) => onChange({ ...action, [field]: event.target.value }),
            })

      const parts = []
      for (const param of spec?.params ?? []) {
        if (param === 'text') parts.push(h('div', { key: param, className: 'xr-grow' }, textInput('text', '要插入 / 发送的文本', true)))
        else if (param === 'chord') parts.push(textInput('chord', '例如 ctrl+k'))
        else if (param === 'direction') {
          parts.push(
            h(
              'select',
              {
                key: param,
                className: 'xr-select',
                value: action.direction ?? 'down',
                onChange: (event) => onChange({ ...action, direction: event.target.value }),
              },
              ...['up', 'down', 'top', 'bottom'].map((direction) =>
                h('option', { key: direction, value: direction }, direction),
              ),
            ),
          )
        } else if (param === 'amount') {
          parts.push(
            h('input', {
              key: param,
              className: 'xr-input',
              type: 'number',
              style: { width: 74 },
              value: action.amount ?? 320,
              onChange: (event) => onChange({ ...action, amount: Number(event.target.value) }),
            }),
          )
        } else if (param === 'url') parts.push(textInput('url', 'https://…'))
        else if (param === 'method') parts.push(textInput('method', 'POST'))
        else if (param === 'body') parts.push(textInput('body', '请求体'))
        else if (param === 'command') parts.push(textInput('command', 'exe 与参数，例如 taskkill /IM foo.exe'))
      }
      return parts.length === 0 ? h('span', { className: 'xr-muted' }, '—') : h('div', { className: 'xr-params' }, ...parts)
    }

    /** 切到某个动作时给它一份能通过校验的初始参数，否则保存时会被降级丢掉。 */
    function defaultActionFor(kind) {
      const defaults = {
        insertText: { text: '' },
        prompt: { text: '' },
        key: { chord: 'ctrl+k' },
        scroll: { direction: 'down', amount: 320 },
        http: { url: 'https://example.com/', method: 'POST' },
        exec: { command: '' },
      }
      return { kind, ...(defaults[kind] ?? {}) }
    }

    function MappingEditor({ state, onSave }) {
      const catalog = state.catalog
      const config = state.config
      if (config === null || catalog === null) return h('div', { className: 'xr-muted' }, '加载中…')

      const [draftKey, setDraftKey] = react.useState('')
      const [draftGesture, setDraftGesture] = react.useState('tap')
      const [draftKind, setDraftKind] = react.useState('insertText')
      const [localMappings, setLocalMappings] = react.useState(null)

      const mappings = localMappings ?? config.mappings ?? {}
      const actionableActions = (catalog.actions ?? []).filter((action) => action.kind !== 'none')

      const update = (logicalKey, gesture, action) => {
        const next = { ...mappings, [logicalKey]: { ...(mappings[logicalKey] ?? {}), [gesture]: action } }
        setLocalMappings(next)
      }
      const remove = (logicalKey, gesture) => {
        const next = { ...mappings }
        const perKey = { ...(next[logicalKey] ?? {}) }
        delete perKey[gesture]
        if (Object.keys(perKey).length === 0) delete next[logicalKey]
        else next[logicalKey] = perKey
        setLocalMappings(next)
      }
      const add = () => {
        if (draftKey === '') return
        update(draftKey, draftGesture, defaultActionFor(draftKind))
      }

      const entries = Object.entries(mappings)
      const dirty = localMappings !== null

      return h(
        'div',
        { className: 'xr-card' },
        h(
          'div',
          { className: 'xr-between' },
          h('span', { className: 'xr-title' }, '按键映射'),
          h(
            'span',
            { className: 'xr-params' },
            h(
              'button',
              {
                type: 'button',
                className: 'xr-btn xr-btn-primary',
                disabled: !dirty || state.busy === true,
                onClick: () => {
                  onSave({ mappings, replaceMappings: true })
                  setLocalMappings(null)
                },
              },
              '保存映射',
            ),
            dirty
              ? h(
                  'button',
                  { type: 'button', className: 'xr-btn', onClick: () => setLocalMappings(null) },
                  '放弃改动',
                )
              : null,
          ),
        ),
        h(
          'div',
          { className: 'xr-hint' },
          '手势：单击 / 双击 / 长按 在松开时判定；按住/松开 是按下即触发、松开再触发一次（给按住说话用）。',
        ),

        entries.length === 0 ? h('div', { className: 'xr-muted', style: { marginTop: 8 } }, '还没有任何映射。') : null,

        ...entries.map(([logicalKey, gestures]) => {
          const meta = (catalog.keys ?? []).find((key) => key.id === logicalKey)
          return h(
            'div',
            { className: 'xr-mapKey', key: logicalKey },
            h(
              'div',
              { className: 'xr-between' },
              h(
                'span',
                { className: 'xr-params' },
                h('strong', null, meta?.zh ?? FALLBACK_KEY_LABELS[logicalKey] ?? logicalKey),
                h('span', { className: 'xr-muted xr-mono' }, logicalKey),
                meta?.unreachable === true ? h(Badge, { tone: 'err' }, '系统丢键') : null,
              ),
              h(
                'span',
                { className: 'xr-params' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'xr-btn xr-btn-sm',
                    onClick: () => void learnNextKey(logicalKey),
                  },
                  state.learningKey === logicalKey ? '按下按键…' : '学习',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'xr-btn xr-btn-sm xr-btn-danger',
                    onClick: () => {
                      const next = { ...mappings }
                      delete next[logicalKey]
                      setLocalMappings(next)
                    },
                  },
                  '删除整键',
                ),
              ),
            ),
            ...GESTURE_ORDER.filter((gesture) => gestures[gesture] !== undefined).map((gesture) => {
              const action = gestures[gesture]
              return h(
                'div',
                { className: 'xr-gesture', key: gesture },
                h('span', { className: 'xr-secondary' }, GESTURE_LABELS[gesture]),
                h(
                  'select',
                  {
                    className: 'xr-select',
                    value: action.kind,
                    onChange: (event) => update(logicalKey, gesture, defaultActionFor(event.target.value)),
                  },
                  ...actionableActions.map((item) =>
                    h('option', { key: item.kind, value: item.kind }, item.danger === true ? `${item.zh}（高级）` : item.zh),
                  ),
                ),
                h(ActionParams, { action, catalog, onChange: (next) => update(logicalKey, gesture, next) }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'xr-btn xr-btn-sm xr-btn-danger',
                    onClick: () => remove(logicalKey, gesture),
                  },
                  '移除',
                ),
              )
            }),
          )
        }),

        h(
          'div',
          { className: 'xr-row', style: { marginTop: 10 } },
          h(
            'select',
            {
              className: 'xr-select',
              value: draftKey,
              onChange: (event) => setDraftKey(event.target.value),
            },
            h('option', { value: '' }, '选择按键…'),
            ...(catalog.keys ?? []).map((key) =>
              h('option', { key: key.id, value: key.id }, key.unreachable === true ? `${key.zh}（系统丢键）` : key.zh),
            ),
          ),
          h(
            'select',
            {
              className: 'xr-select',
              value: draftGesture,
              onChange: (event) => setDraftGesture(event.target.value),
            },
            ...GESTURE_ORDER.map((gesture) => h('option', { key: gesture, value: gesture }, GESTURE_LABELS[gesture])),
          ),
          h(
            'select',
            {
              className: 'xr-select',
              value: draftKind,
              onChange: (event) => setDraftKind(event.target.value),
            },
            ...actionableActions.map((action) => h('option', { key: action.kind, value: action.kind }, action.zh)),
          ),
          h(
            'button',
            { type: 'button', className: 'xr-btn', disabled: draftKey === '', onClick: add },
            '添加映射',
          ),
        ),
      )
    }

    function SettingsPage() {
      const state = useStore()
      const config = state.config
      const catalog = state.catalog

      react.useEffect(() => {
        if (state.ready !== true) void refreshState()
      }, [state.ready])

      if (state.ready !== true) {
        return h(
          'div',
          { className: 'xr-root xr-card' },
          h('div', { className: 'xr-title' }, '小米蓝牙遥控器 2 Pro'),
          state.error === ''
            ? h('div', { className: 'xr-muted' }, '正在连接宿主 API…')
            : h('div', { className: 'xr-err' }, state.error),
        )
      }
      if (config === null || catalog === null) {
        return h('div', { className: 'xr-root xr-card' }, '加载中…')
      }

      const speechProviders = state.speech?.providers ?? []
      const textOnly = state.speech?.available !== true

      return h(
        'div',
        { className: 'xr-root' },

        // ── 状态 ──────────────────────────────────────────────────────────────
        h(
          'div',
          { className: 'xr-card' },
          h('div', { className: 'xr-title' }, '小米蓝牙遥控器 2 Pro'),
          h(
            'div',
            { className: 'xr-row', style: { marginTop: 6 } },
            deviceBadge(state),
            h(
              Badge,
              { tone: config.capture.enabled ? 'ok' : 'idle' },
              config.capture.enabled ? '按键接管中' : '按键接管已关闭',
            ),
            h(Badge, { tone: textOnly ? 'warn' : 'ok' }, textOnly ? '语音识别未启用' : `语音：${state.speech?.selection?.language ?? 'auto'}`),
            h(Badge, { tone: state.fence?.delegated === true ? 'ok' : 'warn' }, state.fence?.delegated === true ? '宿主栅栏已启用' : '仅插件自校验'),
          ),
          h(
            'div',
            { className: 'xr-row xr-muted xr-mono' },
            `最近按键：${state.runtime?.lastKeyId || '—'} / ${state.runtime?.lastGesture || '—'}｜识别 ${state.runtime?.transcribeCount ?? 0} 次，失败 ${state.runtime?.transcribeFailures ?? 0} 次`,
          ),
          state.runtime?.lastError ? h('div', { className: 'xr-err' }, state.runtime.lastError) : null,
          ...(state.warnings ?? []).map((warning, index) =>
            h('div', { className: 'xr-warn', key: `w-${index}` }, warning),
          ),
          state.fence?.delegated !== true
            ? h(
                'div',
                { className: 'xr-warn' },
                '当前宿主未提供 ctx.connection.requestRejection，本插件只使用自带的回环 / 同源校验。若你把 DSH 暴露在非回环地址，请自行加一层鉴权。',
              )
            : null,
        ),

        // ── 预设 ──────────────────────────────────────────────────────────────
        h(
          'div',
          { className: 'xr-card' },
          h('div', { className: 'xr-title' }, '预设'),
          h(
            'div',
            { className: 'xr-row', style: { marginTop: 6 } },
            h(
              'select',
              {
                className: 'xr-select',
                value: config.preset,
                disabled: state.busy === true,
                onChange: (event) => void saveConfig({ preset: event.target.value }),
              },
              ...(catalog.presets ?? []).map((preset) => h('option', { key: preset.id, value: preset.id }, preset.zh)),
            ),
          ),
          h(
            'div',
            { className: 'xr-hint' },
            (catalog.presets ?? []).find((preset) => preset.id === config.preset)?.description ?? '',
          ),
        ),

        // ── 按键映射 ──────────────────────────────────────────────────────────
        h(MappingEditor, { state, onSave: (patch) => void saveConfig(patch) }),

        // ── 接管行为 ──────────────────────────────────────────────────────────
        h(
          'div',
          { className: 'xr-card' },
          h('div', { className: 'xr-title' }, '接管行为'),
          h(Toggle, {
            label: '启用按键接管',
            checked: config.capture.enabled,
            onChange: (value) => void saveConfig({ capture: { enabled: value } }),
          }),
          h(Toggle, {
            label: '拦截已映射按键的浏览器默认行为（F5 刷新必须开，否则按语音键会重载页面）',
            checked: config.capture.preventDefault,
            onChange: (value) => void saveConfig({ capture: { preventDefault: value } }),
          }),
          h(Toggle, {
            label: '焦点在输入框时，方向键等仍交给 DSH（推荐开）',
            checked: config.capture.skipWhileTyping,
            onChange: (value) => void saveConfig({ capture: { skipWhileTyping: value } }),
          }),
          h(Toggle, {
            label: '只在面板打开时接管按键',
            checked: config.capture.onlyWhenPanelOpen,
            onChange: (value) => void saveConfig({ capture: { onlyWhenPanelOpen: value } }),
          }),
          h(
            Field,
            { label: '双击窗口' },
            h('input', {
              className: 'xr-input',
              type: 'number',
              style: { width: 84 },
              value: config.capture.doubleTapMs,
              onChange: (event) => void saveConfig({ capture: { doubleTapMs: Number(event.target.value) } }),
            }),
            h('span', { className: 'xr-muted' }, '毫秒'),
          ),
          h(
            Field,
            { label: '长按阈值' },
            h('input', {
              className: 'xr-input',
              type: 'number',
              style: { width: 84 },
              value: config.capture.longPressMs,
              onChange: (event) => void saveConfig({ capture: { longPressMs: Number(event.target.value) } }),
            }),
            h('span', { className: 'xr-muted' }, '毫秒'),
          ),
        ),

        // ── 语音 ──────────────────────────────────────────────────────────────
        h(
          'div',
          { className: 'xr-card' },
          h('div', { className: 'xr-title' }, '语音输入'),
          textOnly
            ? h(
                'div',
                { className: 'xr-warn' },
                'DSH 的语音识别没有启用。请到「设置 → 插件」启用实验性的语音输入（experimental voice input）后重试；本插件复用它的本地 SenseVoice 模型，不自己联网、不上传音频。',
              )
            : null,
          h(
            Field,
            { label: '识别器' },
            h(
              'select',
              {
                className: 'xr-select',
                value: config.voice.providerId,
                onChange: (event) => void saveConfig({ voice: { providerId: event.target.value } }),
              },
              h('option', { value: '' }, '跟随 DSH 当前选择'),
              ...speechProviders.map((provider) =>
                h('option', { key: provider.id, value: provider.id }, `${provider.name}（${provider.location}）`),
              ),
            ),
          ),
          h(
            Field,
            { label: '语言' },
            h(
              'select',
              {
                className: 'xr-select',
                value: config.voice.language,
                onChange: (event) => void saveConfig({ voice: { language: event.target.value } }),
              },
              ...['auto', 'zh', 'en', 'ja', 'ko', 'yue'].map((language) =>
                h('option', { key: language, value: language }, language),
              ),
            ),
          ),
          h(
            Field,
            { label: '识别结果' },
            h(
              'select',
              {
                className: 'xr-select',
                value: config.voice.insertMode,
                onChange: (event) => void saveConfig({ voice: { insertMode: event.target.value } }),
              },
              h('option', { value: 'composer' }, '写入输入框'),
              h('option', { value: 'clipboard' }, '复制到剪贴板'),
              h('option', { value: 'off' }, '只复制并提示'),
            ),
          ),
          h(Toggle, {
            label: '识别完成后直接发送',
            checked: config.voice.autoSubmit,
            onChange: (value) => void saveConfig({ voice: { autoSubmit: value } }),
          }),
          h(
            Field,
            { label: '最长录音' },
            h('input', {
              className: 'xr-input',
              type: 'number',
              style: { width: 84 },
              value: config.voice.maxSeconds,
              onChange: (event) => void saveConfig({ voice: { maxSeconds: Number(event.target.value) } }),
            }),
            h('span', { className: 'xr-muted' }, '秒'),
          ),
          h(
            Field,
            { label: '录音快捷键' },
            h('input', {
              className: 'xr-input xr-grow',
              value: config.voice.shortcut,
              placeholder: 'ctrl+alt+space',
              onChange: (event) => void saveConfig({ voice: { shortcut: event.target.value } }),
            }),
            h('span', { className: 'xr-muted' }, '按住开始录音，松开结束'),
          ),
          speechProviders.some((provider) => provider.preparation?.phase === 'unprepared')
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'xr-btn',
                  onClick: () => {
                    const providerId = config.voice.providerId || state.speech?.selection?.providerId
                    if (typeof providerId === 'string' && providerId !== '') {
                      void api('/prepare', { method: 'POST', body: { providerId } }).then(() => void refreshState())
                    }
                  },
                },
                '预下载 / 加载识别模型',
              )
            : null,
        ),

        // ── 按键日志 ──────────────────────────────────────────────────────────
        state.config?.ui?.showKeyLog !== false
          ? h(
              'div',
              { className: 'xr-card' },
              h(
                'div',
                { className: 'xr-between' },
                h('span', { className: 'xr-title' }, '按键日志'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'xr-btn xr-btn-sm',
                    onClick: () => {
                      store.set({ log: [] })
                      void api('/log', { method: 'POST', body: { clear: true } })
                    },
                  },
                  '清空',
                ),
              ),
              h(
                'div',
                { className: 'xr-hint' },
                '按下遥控器任意键，这里会显示收到的原始键码。没有任何反应说明系统把这个键丢了（见下方说明）。',
              ),
              h(
                'div',
                { className: 'xr-log', style: { marginTop: 6 } },
                (state.log ?? []).length === 0
                  ? h('div', { className: 'xr-muted' }, '（还没有记录）')
                  : (state.log ?? []).slice().reverse().map((entry, index) =>
                      h(
                        'div',
                        { className: 'xr-logRow xr-mono', key: `${entry.at}-${index}` },
                        h('span', { className: 'xr-muted' }, new Date(entry.at).toLocaleTimeString()),
                        h('span', null, entry.type ?? ''),
                        h('span', { className: 'xr-secondary' }, entry.logicalKey ?? entry.kind ?? entry.phase ?? ''),
                        h('span', null, entry.rawCode ?? entry.text ?? entry.message ?? ''),
                      ),
                    ),
              ),
            )
          : null,

        // ── 高级 ──────────────────────────────────────────────────────────────
        h(
          'div',
          { className: 'xr-card' },
          h('div', { className: 'xr-title' }, '高级'),
          h(Toggle, {
            label: '允许 exec 动作在宿主机执行命令（危险）',
            checked: config.advanced.allowExec,
            onChange: (value) => void saveConfig({ advanced: { allowExec: value } }),
          }),
          h(
            Field,
            { label: 'exec 白名单' },
            h('input', {
              className: 'xr-input xr-grow',
              value: (config.advanced.execAllowlist ?? []).join(', '),
              placeholder: '例如 git, npm, node',
              onChange: (event) =>
                void saveConfig({
                  advanced: {
                    execAllowlist: event.target.value
                      .split(',')
                      .map((item) => item.trim())
                      .filter((item) => item !== ''),
                  },
                }),
            }),
            h('span', { className: 'xr-muted' }, '逗号分隔的命令前缀'),
          ),
          h(Toggle, {
            label: '允许 http 动作由宿主机发起请求',
            checked: config.advanced.allowHttp,
            onChange: (value) => void saveConfig({ advanced: { allowHttp: value } }),
          }),
          h(Toggle, {
            label: '用 PowerShell 探测遥控器配对状态',
            checked: config.advanced.deviceProbe,
            onChange: (value) => void saveConfig({ advanced: { deviceProbe: value } }),
          }),
        ),

        // ── 说明 ──────────────────────────────────────────────────────────────
        h(
          'div',
          { className: 'xr-card' },
          h('div', { className: 'xr-title' }, '为什么有些键没有反应'),
          h(
            'p',
            { className: 'xr-secondary', style: { margin: '6px 0 0' } },
            'RC003 的返回键与音量键上报的是 HID Keyboard 页里的 0xF1 / 0x80 / 0x81。Windows 自带的蓝牙键盘驱动 kbdhid.sys 不会为这几个用法生成扫描码，事件在到达任何用户态程序之前就被丢掉了——低级键盘钩子、Raw Input、页面事件都收不到。',
          ),
          h(
            'p',
            { className: 'xr-secondary', style: { margin: '6px 0 0' } },
            '因此本插件不提供"看起来能用、实际永远不触发"的映射。可行的替代：用 OK / 方向键 / 菜单 / 主页 / 语音键（F5）组合出手势，或者选一套外接的红外/2.4G 遥控器。仍然想要这三个键，需要安装按设备过滤的内核驱动，代价是关闭安全启动并使用测试签名，本插件不走这条路。',
          ),
        ),
      )
    }

    // ────────────────────────────────────────────────────────────────────────────
    // apply：注册 slot、安装按键接管、启动轮询
    // ────────────────────────────────────────────────────────────────────────────

    function apply(ctx) {
      const disposers = []

      // ── 状态轮询 ─────────────────────────────────────────────────────────────
      void refreshState()
      pollTimer = window.setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        void refreshState()
      }, POLL_MS)

      // ── 按键接管 ─────────────────────────────────────────────────────────────
      let engine = null
      let engineSignature = ''
      let tickTimer = 0

      function currentConfig() {
        return store.getSnapshot().config
      }

      function ensureEngine() {
        const config = currentConfig()
        const doubleTapMs = config?.capture?.doubleTapMs ?? 280
        const longPressMs = config?.capture?.longPressMs ?? 500
        const signature = `${doubleTapMs}/${longPressMs}`
        if (engine !== null && engineSignature === signature) return engine
        engine = createGestureEngine({
          doubleTapMs,
          longPressMs,
          hasGesture: (logicalKey, gesture) => {
            const mappings = currentConfig()?.mappings ?? {}
            const action = mappings[logicalKey]?.[gesture]
            return action !== undefined && action !== null && action.kind !== undefined && action.kind !== 'none'
          },
        })
        engineSignature = signature
        return engine
      }

      function scheduleTick() {
        if (engine === null) return
        const deadline = engine.nextDeadline()
        window.clearTimeout(tickTimer)
        if (deadline === null) return
        const delay = Math.max(0, Math.min(deadline - Date.now(), 1000))
        tickTimer = window.setTimeout(() => {
          const now = Date.now()
          for (const event of engine.tick(now)) handleGesture(event)
          scheduleTick()
        }, delay)
      }

      function resolveAction(logicalKey, gesture) {
        const mappings = currentConfig()?.mappings ?? {}
        const action = mappings[logicalKey]?.[gesture]
        if (action === null || action === undefined || action.kind === undefined || action.kind === 'none') return null
        return action
      }

      function handleGesture(event) {
        const action = resolveAction(event.logicalKey, event.gesture)
        store.set({ lastKeyText: `${event.logicalKey}/${event.gesture}` })
        pushLog({
          type: 'key',
          logicalKey: event.logicalKey,
          gesture: event.gesture,
          phase: event.phase,
        })
        if (action === null) return
        void runAction(action, event.phase ?? 'press', { logicalKey: event.logicalKey, gesture: event.gesture })
      }

      function shouldIgnore(event) {
        const config = currentConfig()
        if (config === null || config.capture.enabled !== true) return true
        if (config.capture.onlyWhenPanelOpen === true && store.getSnapshot().panelOpen !== true) return true

        const target = event.target
        const typing = target !== null && target !== undefined && (isTextEntry(target) || target.isContentEditable === true)
        if (typing && config.capture.skipWhileTyping === true) {
          // 输入框里只放行语音手势（按住说话），方向键等一律交还 DSH
          const logicalKey = logicalKeyOf(event)
          const mapping = config.mappings?.[logicalKey] ?? {}
          const voiceOnly = Object.values(mapping).every(
            (action) => action.kind === 'dictate' || action.kind === 'dictateSubmit',
          )
          if (!voiceOnly) return true
        }
        return false
      }

      function onKeyDown(event) {
        // 学习模式优先：把下一个键绑到目标逻辑按键（Esc 取消）
        const learningKey = store.getSnapshot().learningKey
        if (learningKey !== null && learningKey !== undefined && event.repeat !== true) {
          event.preventDefault()
          event.stopPropagation()
          if (event.key === 'Escape') {
            store.set({ learningKey: null })
            toast('已取消学习')
            return
          }
          void commitLearnedCode(event.code !== '' ? event.code : event.key, learningKey)
          return
        }

        store.set({ lastRawCode: describeEvent(event) })

        const config = currentConfig()
        if (config?.voice?.shortcut && matchShortcut(event, config.voice.shortcut)) {
          event.preventDefault()
          event.stopPropagation()
          if (!recorder.active) void startDictation()
          return
        }

        if (shouldIgnore(event)) return

        const logicalKey = logicalKeyOf(event)
        if (logicalKey === 'unknown') {
          // 记下来但不管：日志里能看到，方便用学习模式绑定
          store.set({ lastRawCode: describeEvent(event) })
          return
        }
        if (event.repeat === true) return

        const gestures = config?.mappings?.[logicalKey] ?? {}
        const mapped = Object.keys(gestures)
        if (mapped.length === 0) return

        if (config.capture.preventDefault === true) {
          event.preventDefault()
          event.stopPropagation()
        }

        engine = ensureEngine()
        for (const gestureEvent of engine.down(logicalKey, Date.now())) handleGesture(gestureEvent)
        scheduleTick()
      }

      function onKeyUp(event) {
        const learningKey = store.getSnapshot().learningKey
        if (learningKey !== null && learningKey !== undefined) return

        const config = currentConfig()
        if (config?.voice?.shortcut && matchShortcut(event, config.voice.shortcut) && recorder.active) {
          event.preventDefault()
          event.stopPropagation()
          void stopDictationWithSubmit('快捷键')
          return
        }

        const logicalKey = logicalKeyOf(event)
        if (logicalKey === 'unknown') return
        if (engine === null) return
        for (const gestureEvent of engine.up(logicalKey, Date.now())) handleGesture(gestureEvent)
        scheduleTick()
      }

      function matchShortcut(event, chord) {
        if (typeof chord !== 'string' || chord.trim() === '') return false
        const parts = chord.split('+').map((part) => part.trim().toLowerCase()).filter(Boolean)
        const modifiers = { ctrl: false, alt: false, shift: false, meta: false }
        let mainKey = ''
        for (const part of parts) {
          if (part === 'ctrl' || part === 'control') modifiers.ctrl = true
          else if (part === 'alt') modifiers.alt = true
          else if (part === 'shift') modifiers.shift = true
          else if (['meta', 'cmd', 'win', 'super'].includes(part)) modifiers.meta = true
          else mainKey = part
        }
        if (mainKey === '') return false
        if (Boolean(event.ctrlKey) !== modifiers.ctrl) return false
        if (Boolean(event.altKey) !== modifiers.alt) return false
        if (Boolean(event.shiftKey) !== modifiers.shift) return false
        if (Boolean(event.metaKey) !== modifiers.meta) return false
        const code = String(event.code ?? '').toLowerCase()
        const key = String(event.key ?? '').toLowerCase()
        return code === mainKey || key === mainKey || code === `key${mainKey}` || key === mainKey
      }

      // 捕获阶段安装，保证比 DSH 自己的快捷键处理更早看到事件
      window.addEventListener('keydown', onKeyDown, true)
      window.addEventListener('keyup', onKeyUp, true)
      disposers.push(() => window.removeEventListener('keydown', onKeyDown, true))
      disposers.push(() => window.removeEventListener('keyup', onKeyUp, true))

      // ── slot 注册 ────────────────────────────────────────────────────────────
      const registrations = [
        { slot: 'shell.overlay', options: { id: 'xiaomi-remote-2-pro-overlay', order: 40, label: '小米遥控器 2 Pro' }, component: Overlay },
        { slot: 'conversation.input.left', options: { id: 'xiaomi-remote-2-pro-mic', order: 25, label: '按住说话' }, component: MicButton },
        { slot: 'settings.section', options: { id: 'xiaomi-remote-2-pro', order: 60, label: '小米遥控器 2 Pro' }, component: SettingsPage },
      ]

      ctx.inject(['slots'], (scope) => {
        const slots = scope.get('slots')
        if (slots === undefined || slots === null) {
          console.error('[xiaomi-remote-2-pro] 拿不到 slots 服务，界面未注册')
          return
        }
        for (const registration of registrations) {
          try {
            const dispose = slots.inject(registration.slot, () =>
              slots.register({ name: registration.slot, ...registration.options }, registration.component),
            )
            disposers.push(dispose)
          } catch (error) {
            console.error(`[xiaomi-remote-2-pro] 注册 slot ${registration.slot} 失败`, error)
          }
        }
      })

      ctx.effect(() => () => {
        window.clearInterval(pollTimer)
        window.clearTimeout(tickTimer)
        window.clearTimeout(logFlushTimer)
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 卸载期异常忽略 */
          }
        }
        if (recorder.active) void recorder.stop()
      })
    }

    /**
     * 客户端半区的 Config：与宿主半区用同一套策略——只有"整份配置不是对象"才报错，
     * 其余一律放行。真正的归一化在宿主侧完成。
     */
    const Config = {
      '~standard': {
        version: 1,
        vendor: 'dsh-xiaomi-remote-2-pro',
        validate(config) {
          if (config === undefined || config === null) return { value: {} }
          if (typeof config !== 'object' || Array.isArray(config)) {
            return { issues: [{ message: 'plugin config must be an object' }] }
          }
          return { value: config }
        },
      },
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    exports.Config = Config
    return module.exports
  },
})
