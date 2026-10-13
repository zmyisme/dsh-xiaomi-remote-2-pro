/**
 * 宿主半区的运行期状态：日志环形缓冲、语音桥、配置存储。
 *
 * 与 `host.js`（纯装配）分开，是为了让这三块各自可测。
 */

import { base64ToBytes } from './wav.js'

/**
 * 定长环形缓冲。按键日志会持续写入，必须硬上限，否则长会话会吃内存。
 *
 * @param {number} limit
 */
export function createLogBuffer(limit) {
  const capacity = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200
  /** @type {object[]} */
  let items = []
  let dropped = 0

  return {
    /**
     * @param {object} entry
     */
    push(entry) {
      items.push(entry)
      while (items.length > capacity) {
        items.shift()
        dropped += 1
      }
    },
    /** 最新的在前。 */
    list(limit) {
      const count = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : items.length
      return items.slice(-count).reverse()
    },
    clear() {
      items = []
      dropped = 0
    },
    get size() {
      return items.length
    },
    get dropped() {
      return dropped
    },
    get capacity() {
      return capacity
    },
  }
}

/**
 * 语音桥：把"一段 base64 WAV"变成文字。
 *
 * 优先用 `speechController`（`@Remote` 门面，带 provider 目录与录音上限），
 * 退化到 `speechToText`（注册表本体）。两个都没有时明确报告不可用，
 * 而不是抛一个用户看不懂的异常。
 */
export function createSpeechBridge() {
  /** @type {{ kind: 'controller'|'registry', service: object } | null} */
  let adopted = null

  return {
    /**
     * 采纳一个可用的语音服务。`controller` 优先级高于 `registry`。
     * @param {'controller'|'registry'} kind
     * @param {object} service
     */
    adopt(kind, service) {
      if (kind === 'controller') {
        adopted = { kind, service }
        return
      }
      if (adopted === null || adopted.kind !== 'controller') adopted = { kind, service }
    },
    /** 是否拿到了可用的语音服务。 */
    get available() {
      return adopted !== null
    },
    get kind() {
      return adopted === null ? null : adopted.kind
    },

    /**
     * 读取 provider 目录与录音上限。
     * @returns {Promise<object>}
     */
    async catalog() {
      if (adopted === null) {
        return { available: false, providers: [], selection: null, reason: 'DSH 语音服务未启用。' }
      }
      try {
        if (adopted.kind === 'controller') {
          const catalog = await adopted.service.catalog()
          return {
            available: true,
            providers: catalog.providers ?? [],
            selection: catalog.selection ?? null,
            maxAudioBytes: catalog.maxAudioBytes,
            maxDurationSeconds: catalog.maxDurationSeconds,
          }
        }
        const snapshot = adopted.service.snapshot()
        return {
          available: true,
          providers: snapshot.providers ?? [],
          selection: snapshot.selection ?? null,
          maxAudioBytes: undefined,
          maxDurationSeconds: undefined,
        }
      } catch (error) {
        return { available: false, providers: [], selection: null, reason: String(error?.message ?? error) }
      }
    },

    /**
     * 预热一个识别器（本地模型首次使用需要下载 / 加载）。
     * @param {string} providerId
     */
    prepare(providerId) {
      if (adopted === null) return { ok: false, reason: 'DSH 语音服务未启用。' }
      try {
        adopted.service.prepare(providerId)
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: String(error?.message ?? error) }
      }
    },

    /**
     * 转写一段 base64 WAV。
     * @param {{ audioBase64: string, language?: string, providerId?: string }} request
     * @param {AbortSignal} [signal]
     * @returns {Promise<{ text: string, audioSeconds?: number, inferenceSeconds?: number }>}
     */
    async transcribe(request, signal) {
      if (adopted === null) {
        throw new Error('DSH 语音服务未启用：请在「设置 → 插件」里启用语音输入（experimental voice input）后再试。')
      }

      const language = request.language === undefined || request.language === '' || request.language === 'auto'
        ? undefined
        : request.language
      const providerId = request.providerId === undefined || request.providerId === '' ? undefined : request.providerId

      if (adopted.kind === 'controller') {
        const transcript = await adopted.service.transcribe(
          { audioBase64: request.audioBase64, providerId, language },
          signal,
        )
        return {
          text: transcript?.text ?? '',
          audioSeconds: transcript?.audioSeconds,
          inferenceSeconds: transcript?.inferenceSeconds,
        }
      }

      const spec = adopted.service.resolve({
        audio: base64ToBytes(request.audioBase64),
        providerId,
        language,
      })
      const transcript = await adopted.service.transcribe(spec, signal)
      return {
        text: transcript?.text ?? '',
        audioSeconds: transcript?.audioSeconds,
        inferenceSeconds: transcript?.inferenceSeconds,
      }
    },
  }
}

/**
 * 配置存储：优先把改动写回 profile（走 DSH 自己的 `configEditor`），
 * 拿不到 `configEditor` 时退化为**仅本次进程有效**的内存覆盖，并向用户明说。
 *
 * `configEditor` 是**惰性解析**的：Cordis 的服务就绪顺序不确定，如果在这里把服务
 * 快照下来，早于 `configEditor` 就绪的插件实例会永远拿不到它。因此用
 * `getConfigEditor` 每次现取。
 *
 * @param {{
 *   getConfigEditor?: () => object | undefined,
 *   configEditor?: { entries?: Function, edit?: Function },
 *   packageName: string,
 *   initial: object,
 *   logger?: { warn?: Function },
 * }} options
 */
export function createConfigStore(options) {
  const logger = options.logger ?? console
  let current = options.initial
  const notes = []

  /** 每次用到时现取服务，避免把"服务还没就绪"永久固化。 */
  function resolveEditor() {
    const editor = typeof options.getConfigEditor === 'function' ? options.getConfigEditor() : options.configEditor
    return editor === null || editor === undefined ? undefined : editor
  }

  function findEntry() {
    const editor = resolveEditor()
    if (editor === undefined || typeof editor.entries !== 'function') return undefined
    try {
      const entries = editor.entries()
      if (!Array.isArray(entries)) return undefined
      return entries.find((entry) => {
        const name = entry?.name ?? entry?.moduleName ?? entry?.options?.name
        return name === options.packageName
      })
    } catch (error) {
      logger.warn?.(`[xiaomi-remote-2-pro] 读取 loader 条目失败：${String(error)}`)
      return undefined
    }
  }

  return {
    /** 当前生效的配置。 */
    current() {
      return current
    },
    /** 用新的完整配置替换内存副本（归一化后的完整配置）。 */
    replace(next) {
      current = next
    },
    /** 面向用户的提示（例如"改动只在本次会话有效"）。 */
    notes() {
      return notes.slice()
    },
    /**
     * 读取 profile 里保存的原始 config。
     * @returns {{ ok: boolean, raw?: unknown, reason?: string }}
     */
    readRaw() {
      const editor = resolveEditor()
      if (editor === undefined || typeof editor.configuration !== 'function') {
        return { ok: false, reason: '当前宿主没有提供 configEditor，无法读取已保存的配置。' }
      }
      try {
        const rows = editor.configuration()
        if (!Array.isArray(rows)) return { ok: false, reason: 'configEditor.configuration() 返回了非数组。' }
        const row = rows.find((item) => {
          const name = item?.entry?.name ?? item?.entry?.moduleName
          return name === options.packageName
        })
        if (row === undefined) return { ok: false, reason: '找不到本插件在 profile 里的配置行。' }
        return { ok: true, raw: row.override ?? row.inherited ?? {} }
      } catch (error) {
        return { ok: false, reason: String(error?.message ?? error) }
      }
    },
    /**
     * 把配置写回 profile。
     *
     * @param {object} nextConfig 归一化后的完整配置
     * @returns {Promise<{ ok: boolean, persisted: boolean, reason?: string }>}
     */
    async write(nextConfig) {
      current = nextConfig

      const editor = resolveEditor()
      if (editor === undefined || typeof editor.edit !== 'function') {
        if (!notes.includes('changes-are-ephemeral')) {
          notes.push('changes-are-ephemeral')
          logger.warn?.(
            '[xiaomi-remote-2-pro] 宿主没有提供 configEditor，配置改动只在本次进程内有效；' +
              '重启 DSH 后会回到 profile 里保存的值。',
          )
        }
        return { ok: true, persisted: false, reason: '宿主没有 configEditor，改动未写入 profile。' }
      }

      const entry = findEntry()
      if (entry === undefined) {
        return { ok: false, persisted: false, reason: '找不到本插件的 loader 条目，无法写入 profile。' }
      }

      try {
        await editor.edit(entry, () => nextConfig)
        return { ok: true, persisted: true }
      } catch (error) {
        return { ok: false, persisted: false, reason: String(error?.message ?? error) }
      }
    },
  }
}

/**
 * 运行期统计与"最近一次活动"。面板用它显示设备在线状态与实时指标。
 */
export function createRuntimeState() {
  const startedAt = Date.now()
  return {
    startedAt,
    lastSeenAt: 0,
    lastKeyId: '',
    lastGesture: '',
    lastAction: '',
    keyCount: 0,
    actionCount: 0,
    transcribeCount: 0,
    transcribeFailures: 0,
    lastTranscript: '',
    lastError: '',
    voice: { active: false, startedAt: 0 },

    noteKey(logicalKey, gesture) {
      this.lastSeenAt = Date.now()
      this.lastKeyId = logicalKey
      this.lastGesture = gesture
      this.keyCount += 1
    },
    noteAction(kind) {
      this.lastAction = kind
      this.actionCount += 1
    },
    noteTranscript(text) {
      this.transcribeCount += 1
      this.lastTranscript = text
      this.lastError = ''
    },
    noteFailure(message) {
      this.transcribeFailures += 1
      this.lastError = message
    },
  }
}
