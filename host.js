/**
 * dsh-xiaomi-remote-2-pro —— 宿主半区（Host half）。
 *
 * ## 职责边界
 *
 * - **宿主半区（本文件）**：HTTP API、配置持久化、设备探测、调用 DSH 语音识别、
 *   面向 Agent 的 Tool 与人类命令。**它不碰键盘、不碰麦克风。**
 * - **客户端半区（`client.js`）**：按键接管、手势识别、面板 UI、录音。
 *
 * 按键与录音留在浏览器侧是有意的：遥控器的按键最终是标准键盘事件，麦克风就是系统
 * 默认录音设备——两者在页面里直接可用，因此本插件**零原生依赖、不需要管理员权限、
 * 不需要编译**。
 *
 * ## 客户端 ↔ 宿主
 *
 * 只走本插件自己的 HTTP 路由（`fetch`）。不使用 `host.call`：其宿主侧注册入口
 * （`harness.handle`）对第三方包是否开放尚未验证，而 HTTP 路由是已被真实第三方插件
 * 验证过的通道。所有写路由都过一遍 `lib/fence.js` 的信任栅栏。
 */

import { DEFAULT_CODE_MAP, REMOTE_KEYS, UNREACHABLE_KEY_IDS } from './lib/keys.js'
import { ACTIONS, GESTURES } from './lib/mapping.js'
import { Config, PRESETS, PRESET_IDS, normaliseConfig } from './lib/config.js'
import { RC003_PRODUCT_ID, RC003_VENDOR_ID, createDeviceProbe } from './lib/device.js'
import { createFence, readJsonBody, sendJson } from './lib/fence.js'
import { createConfigStore, createLogBuffer, createRuntimeState, createSpeechBridge } from './lib/runtime.js'
import { validateTranscriptionAudio } from './lib/wav.js'

/** 插件对外声明的名字，必须与 `cordis.patch.yml` 里的 id 一致。 */
export const name = 'xiaomi-remote-2-pro'

/** npm 包名，用于在 loader 条目里定位本插件自己的配置行。 */
const PACKAGE_NAME = 'dsh-xiaomi-remote-2-pro'

/**
 * 宿主半区版本，同时出现在 `/api/state` 与 `remote_2_pro` 的 status 输出里。
 *
 * 用途是回答一个很实际的问题："现在跑的是哪一份代码？"——因为 bundle 重新挂载时
 * Node 的 ES 模块缓存不会失效，改了 `lib/*` 之后光切换启用状态是看不到新代码的，
 * 必须完整重启 DSH。带上版本号就能一眼确认。
 *
 * `test/package.test.mjs` 会断言它与 package.json 的版本一致。
 */
export const PLUGIN_VERSION = '0.1.0'

/** 本插件全部路由的前缀。 */
const ROUTE_PREFIX = '/dsh-remote2pro'

/** 语音目录缓存时长：面板会轮询 `/api/state`，不能每次都去问识别器。 */
const SPEECH_CACHE_MS = 3000

/** `exec` 动作的输出上限。 */
const EXEC_MAX_BUFFER = 1024 * 1024

/** `http` / `exec` 动作的超时。 */
const HOST_ACTION_TIMEOUT_MS = 10000

export { Config }

/**
 * 面板与 Agent 共用的静态目录。
 *
 * 放在宿主侧是为了**单一事实来源**：面板不再自己抄一份按键表 / 动作表，
 * 以后加动作只改 `lib/mapping.js` 一处。
 */
function buildCatalog() {
  return {
    gestures: [...GESTURES],
    keys: REMOTE_KEYS.map((key) => ({
      id: key.id,
      zh: key.zh,
      en: key.en,
      hint: key.hint,
      unreachable: UNREACHABLE_KEY_IDS.includes(key.id),
    })),
    actions: Object.entries(ACTIONS).map(([kind, spec]) => ({
      kind,
      zh: spec.zh,
      en: spec.en,
      description: spec.description,
      params: [...spec.params],
      danger: spec.danger === true,
      phaseAware: spec.phaseAware === true,
      voice: spec.voice === true,
    })),
    presets: PRESET_IDS.map((id) => ({
      id,
      zh: PRESETS[id].zh,
      en: PRESETS[id].en,
      description: PRESETS[id].description,
      mappings: PRESETS[id].mappings,
    })),
    defaultCodeMap: { ...DEFAULT_CODE_MAP },
  }
}

/**
 * 宿主半区入口。
 *
 * @param {object} ctx Cordis 上下文
 * @param {unknown} [rawConfig] loader 行里的 `config`（已由 `Config` 处理）
 */
export function apply(ctx, rawConfig) {
  const logger = ctx?.logger ?? console
  const incoming = rawConfig === undefined ? ctx?.config : rawConfig
  const { config: initialConfig, warnings: configWarnings } = normaliseConfig(incoming)

  const runtime = createRuntimeState()
  // 注意：环形缓冲容量在创建时固定；运行期改 logLimit 需要重载插件才生效。
  const log = createLogBuffer(initialConfig.advanced.logLimit)
  const speech = createSpeechBridge()
  const deviceProbe = createDeviceProbe({ logger })
  const catalog = buildCatalog()

  // 这两个服务可能晚于本插件就绪，因此**惰性取值**，不在这里快照。
  let configEditorService
  let connectionService

  const store = createConfigStore({
    getConfigEditor: () => configEditorService,
    packageName: PACKAGE_NAME,
    initial: initialConfig,
    logger,
  })

  /** 当前生效配置。所有读写都经过同一个 store，避免出现两份会漂移的副本。 */
  const activeConfig = () => store.current()

  ctx.inject(['configEditor'], (scope) => {
    configEditorService = scope.configEditor
  })

  ctx.inject(['connection'], (scope) => {
    connectionService = scope.connection
  })

  ctx.inject(['speechController'], (scope) => {
    speech.adopt('controller', scope.speechController)
  })

  ctx.inject(['speechToText'], (scope) => {
    speech.adopt('registry', scope.speechToText)
  })

  // ── webServer：面板与 API 的载体 ─────────────────────────────────────────────
  ctx.inject(['webServer'], (scope) => {
    const fence = createFence({ getConnection: () => connectionService, logger })

    /**
     * 注册一条路由，统一做栅栏校验与异常兜底。
     * @param {'exact'|'prefix'} kind
     * @param {string} path
     * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => unknown} handler
     */
    const route = (kind, path, handler) => {
      const dispose = scope.webServer.register({
        kind,
        path,
        handler: async (req, res) => {
          try {
            const rejection = fence.check(req)
            if (rejection !== null) {
              sendJson(res, rejection, { ok: false, error: `请求被信任栅栏拒绝（${rejection}）。` })
              return
            }
            await handler(req, res)
          } catch (error) {
            const message = String(error?.stack ?? error)
            runtime.lastError = message
            log.push({ at: Date.now(), type: 'host-error', message })
            if (!res.headersSent) sendJson(res, 500, { ok: false, error: message })
            else res.end()
          }
        },
      })
      // 路由必须随插件卸载一起释放，否则重载后会撞 "duplicate (kind, path)"
      ctx.effect(() => () => {
        try {
          dispose()
        } catch {
          /* 卸载期重复释放是无害的 */
        }
      })
      return dispose
    }

    let speechCache = { at: 0, value: null }

    /** 带缓存的语音目录。 */
    async function speechCatalog() {
      const now = Date.now()
      if (speechCache.value !== null && now - speechCache.at < SPEECH_CACHE_MS) return speechCache.value
      const value = await speech.catalog()
      speechCache = { at: Date.now(), value }
      return value
    }

    /**
     * 设备状态：先给缓存；缓存过期或还没有结果时在后台补一次，
     * **绝不让面板请求卡在探测上**（实测一次 PnP 探测要 1.3–4 秒）。
     *
     * 真正的"在线"判据是客户端最近一次收到按键的时间（`runtime.lastSeenAt`），
     * PnP 探测只是补充信息，所以允许它短暂过期。
     */
    function deviceSnapshot() {
      const last = deviceProbe.last()
      const enabled = activeConfig().advanced.deviceProbe
      if (last === null) {
        if (enabled) deviceProbe.probe().catch(() => {})
        return { status: 'probing', devices: [], probedAt: 0 }
      }
      if (last.stale === true && enabled) {
        // 先返回旧值，面板下一次轮询就能拿到新的
        deviceProbe.probe().catch(() => {})
      }
      return last
    }

    // ── GET /api/health ─────────────────────────────────────────────────────
    route('exact', `${ROUTE_PREFIX}/api/health`, (req, res) => {
      sendJson(res, 200, { ok: true, plugin: name, startedAt: runtime.startedAt })
    })

    // ── GET /api/state ──────────────────────────────────────────────────────
    route('exact', `${ROUTE_PREFIX}/api/state`, async (req, res) => {
      sendJson(res, 200, {
        ok: true,
        plugin: { name, packageName: PACKAGE_NAME, version: PLUGIN_VERSION },
        config: store.current(),
        warnings: [...configWarnings, ...store.notes()],
        catalog,
        runtime: {
          startedAt: runtime.startedAt,
          lastSeenAt: runtime.lastSeenAt,
          lastKeyId: runtime.lastKeyId,
          lastGesture: runtime.lastGesture,
          lastAction: runtime.lastAction,
          keyCount: runtime.keyCount,
          actionCount: runtime.actionCount,
          transcribeCount: runtime.transcribeCount,
          transcribeFailures: runtime.transcribeFailures,
          lastTranscript: runtime.lastTranscript,
          lastError: runtime.lastError,
          voice: { ...runtime.voice },
        },
        log: log.list(60),
        logMeta: { size: log.size, capacity: log.capacity, dropped: log.dropped },
        speech: await speechCatalog(),
        device: deviceSnapshot(),
        fence: { delegated: fence.delegated },
      })
    })

    // ── GET /api/device ─────────────────────────────────────────────────────
    route('exact', `${ROUTE_PREFIX}/api/device`, async (req, res) => {
      if (!activeConfig().advanced.deviceProbe) {
        sendJson(res, 200, { ok: true, disabled: true, status: 'disabled', devices: [] })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const result = await deviceProbe.probe({ force: url.searchParams.get('force') === '1' })
      sendJson(res, 200, {
        ok: true,
        expected: { vendorId: RC003_VENDOR_ID, productId: RC003_PRODUCT_ID },
        ...result,
      })
    })

    // ── POST /api/config ────────────────────────────────────────────────────
    route('exact', `${ROUTE_PREFIX}/api/config`, async (req, res) => {
      const body = await readJsonBody(req)
      if (!body.ok) {
        sendJson(res, body.status, { ok: false, error: body.reason })
        return
      }
      const patch = body.value
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        sendJson(res, 400, { ok: false, error: '请求体必须是一个对象。' })
        return
      }

      const current = store.current()
      const replaceMappings = patch.replaceMappings === true
      const merged = {
        ...current,
        ...patch,
        capture: { ...current.capture, ...(patch.capture ?? {}) },
        voice: { ...current.voice, ...(patch.voice ?? {}) },
        advanced: { ...current.advanced, ...(patch.advanced ?? {}) },
        ui: { ...current.ui, ...(patch.ui ?? {}) },
        learnedCodes: { ...current.learnedCodes, ...(patch.learnedCodes ?? {}) },
        mappings: replaceMappings ? (patch.mappings ?? {}) : (patch.mappings ?? current.mappings),
      }
      delete merged.replaceMappings

      const { config: next, warnings } = normaliseConfig(merged)
      const outcome = await store.write(next)
      runtime.lastError = outcome.ok ? '' : String(outcome.reason ?? '')

      sendJson(res, outcome.ok ? 200 : 500, {
        ok: outcome.ok,
        persisted: outcome.persisted,
        reason: outcome.reason ?? null,
        config: next,
        warnings: [...warnings, ...store.notes()],
      })
    })

    // ── POST /api/learn ─────────────────────────────────────────────────────
    route('exact', `${ROUTE_PREFIX}/api/learn`, async (req, res) => {
      const body = await readJsonBody(req)
      if (!body.ok) {
        sendJson(res, body.status, { ok: false, error: body.reason })
        return
      }
      const { code, logicalKey } = body.value ?? {}
      if (typeof code !== 'string' || code === '') {
        sendJson(res, 400, { ok: false, error: '缺少 code 字段。' })
        return
      }
      const current = store.current()
      const learnedCodes = { ...current.learnedCodes }
      if (logicalKey === null || logicalKey === undefined) delete learnedCodes[code]
      else learnedCodes[code] = logicalKey

      const { config: next } = normaliseConfig({ ...current, learnedCodes })
      const outcome = await store.write(next)
      sendJson(res, outcome.ok ? 200 : 500, {
        ok: outcome.ok,
        persisted: outcome.persisted,
        reason: outcome.reason ?? null,
        learnedCodes: next.learnedCodes,
      })
    })

    // ── POST /api/log ───────────────────────────────────────────────────────
    route('exact', `${ROUTE_PREFIX}/api/log`, async (req, res) => {
      const body = await readJsonBody(req, 256 * 1024)
      if (!body.ok) {
        sendJson(res, body.status, { ok: false, error: body.reason })
        return
      }
      const payload = body.value ?? {}
      if (payload.clear === true) {
        log.clear()
        sendJson(res, 200, { ok: true, cleared: true })
        return
      }
      const entries = Array.isArray(payload.entries) ? payload.entries : [payload]
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue
        log.push({ at: Date.now(), ...entry })
        if (entry.type === 'key' && typeof entry.logicalKey === 'string') {
          runtime.noteKey(entry.logicalKey, String(entry.gesture ?? ''))
        }
        if (entry.type === 'action' && typeof entry.kind === 'string') runtime.noteAction(entry.kind)
        if (entry.type === 'voice') {
          runtime.voice = entry.phase === 'start'
            ? { active: true, startedAt: Date.now() }
            : { active: false, startedAt: 0 }
        }
      }
      sendJson(res, 200, { ok: true, size: log.size })
    })

    // ── POST /api/prepare ───────────────────────────────────────────────────
    route('exact', `${ROUTE_PREFIX}/api/prepare`, async (req, res) => {
      const body = await readJsonBody(req)
      if (!body.ok) {
        sendJson(res, body.status, { ok: false, error: body.reason })
        return
      }
      const providerId = body.value?.providerId
      if (typeof providerId !== 'string' || providerId === '') {
        sendJson(res, 400, { ok: false, error: '缺少 providerId。' })
        return
      }
      const outcome = speech.prepare(providerId)
      speechCache = { at: 0, value: null }
      sendJson(res, outcome.ok ? 200 : 400, outcome)
    })

    // ── POST /api/transcribe ────────────────────────────────────────────────
    route('exact', `${ROUTE_PREFIX}/api/transcribe`, async (req, res) => {
      const body = await readJsonBody(req)
      if (!body.ok) {
        sendJson(res, body.status, { ok: false, error: body.reason })
        return
      }
      const payload = body.value ?? {}
      const current = store.current()
      const catalogValue = await speechCatalog()

      const check = validateTranscriptionAudio(payload.audioBase64, {
        maxBytes: Number.isFinite(catalogValue?.maxAudioBytes) ? catalogValue.maxAudioBytes : 8 * 1024 * 1024,
        maxSeconds: Number.isFinite(catalogValue?.maxDurationSeconds)
          ? catalogValue.maxDurationSeconds
          : Math.max(current.voice.maxSeconds, 60),
      })
      if (!check.ok) {
        runtime.noteFailure(check.reason ?? '音频校验失败。')
        log.push({ at: Date.now(), type: 'voice', phase: 'rejected', message: check.reason })
        sendJson(res, 400, { ok: false, error: check.reason })
        return
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), Math.max(15000, check.durationSeconds * 8000))
      req.on('close', () => controller.abort())

      try {
        const startedAt = Date.now()
        const transcript = await speech.transcribe(
          {
            audioBase64: payload.audioBase64,
            language: payload.language ?? current.voice.language,
            providerId: payload.providerId ?? current.voice.providerId,
          },
          controller.signal,
        )
        runtime.noteTranscript(transcript.text)
        log.push({
          at: Date.now(),
          type: 'voice',
          phase: 'done',
          durationSeconds: Number(check.durationSeconds.toFixed(2)),
          textLength: transcript.text.length,
          elapsedMs: Date.now() - startedAt,
        })
        sendJson(res, 200, {
          ok: true,
          text: transcript.text,
          audioSeconds: transcript.audioSeconds ?? check.durationSeconds,
          inferenceSeconds: transcript.inferenceSeconds,
          elapsedMs: Date.now() - startedAt,
        })
      } catch (error) {
        const message = String(error?.message ?? error)
        runtime.noteFailure(message)
        log.push({ at: Date.now(), type: 'voice', phase: 'failed', message })
        sendJson(res, 500, { ok: false, error: message })
      } finally {
        clearTimeout(timeout)
      }
    })

    // ── POST /api/host-action ───────────────────────────────────────────────
    route('exact', `${ROUTE_PREFIX}/api/host-action`, async (req, res) => {
      const body = await readJsonBody(req, 256 * 1024)
      if (!body.ok) {
        sendJson(res, body.status, { ok: false, error: body.reason })
        return
      }
      const action = body.value?.action ?? {}
      const current = store.current()

      if (action.kind === 'http') {
        if (!current.advanced.allowHttp) {
          sendJson(res, 403, { ok: false, error: 'http 动作已在配置里关闭（advanced.allowHttp）。' })
          return
        }
        if (typeof action.url !== 'string' || !/^https?:\/\//i.test(action.url)) {
          sendJson(res, 400, { ok: false, error: 'url 必须是 http(s) 地址。' })
          return
        }
        try {
          const response = await fetch(action.url, {
            method: typeof action.method === 'string' && action.method !== '' ? action.method.toUpperCase() : 'POST',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            body: typeof action.body === 'string' ? action.body : undefined,
            signal: AbortSignal.timeout(HOST_ACTION_TIMEOUT_MS),
          })
          const text = await response.text()
          log.push({ at: Date.now(), type: 'action', kind: 'http', url: action.url, status: response.status })
          sendJson(res, 200, { ok: true, status: response.status, body: text.slice(0, 4096) })
        } catch (error) {
          sendJson(res, 502, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }

      if (action.kind === 'exec') {
        if (!current.advanced.allowExec) {
          sendJson(res, 403, { ok: false, error: 'exec 动作已在配置里关闭（advanced.allowExec）。' })
          return
        }
        const command = typeof action.command === 'string' ? action.command.trim() : ''
        if (command === '') {
          sendJson(res, 400, { ok: false, error: '缺少 command。' })
          return
        }
        const allowlist = current.advanced.execAllowlist ?? []
        if (allowlist.length === 0) {
          sendJson(res, 403, {
            ok: false,
            error: 'exec 白名单为空，已拒绝。请先在配置里声明 advanced.execAllowlist。',
          })
          return
        }
        if (!allowlist.some((prefix) => command.startsWith(prefix))) {
          sendJson(res, 403, { ok: false, error: '命令不在白名单内，已拒绝。' })
          return
        }
        // 刻意不走 shell：按空白切分后直接 execFile，从根上避免命令注入与管道
        const [program, ...args] = command.split(/\s+/)
        try {
          const { execFile } = await import('node:child_process')
          const stdout = await new Promise((resolve, reject) => {
            execFile(
              program,
              args,
              { timeout: HOST_ACTION_TIMEOUT_MS, windowsHide: true, maxBuffer: EXEC_MAX_BUFFER },
              (error, out, err) => {
                if (error) reject(new Error(`${error.message}\n${String(err ?? '')}`))
                else resolve(String(out ?? ''))
              },
            )
          })
          log.push({ at: Date.now(), type: 'action', kind: 'exec', program, ok: true })
          sendJson(res, 200, { ok: true, stdout: stdout.slice(0, 8192) })
        } catch (error) {
          log.push({ at: Date.now(), type: 'action', kind: 'exec', program, ok: false, message: String(error) })
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }

      sendJson(res, 400, { ok: false, error: `未知的宿主动作 ${String(action.kind)}。` })
    })
  })

  // ── tools：让 Agent 自己也能读写遥控器配置 ───────────────────────────────────
  ctx.inject(['tools'], (scope) => {
    scope.tools.register({
      name: 'remote_2_pro',
      description:
        'Inspect and reconfigure the DSH Xiaomi Bluetooth Remote 2 Pro plugin (buttons, gestures, voice). ' +
        'Actions: status | get_config | set_config | set_preset | set_mapping | clear_mapping | recent_log.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'get_config', 'set_config', 'set_preset', 'set_mapping', 'clear_mapping', 'recent_log'],
            description: 'Which operation to run.',
          },
          logicalKey: {
            type: 'string',
            description: 'Remote key id: voice / ok / up / down / left / right / home / menu / tv.',
          },
          gesture: { type: 'string', enum: [...GESTURES], description: 'Gesture to bind.' },
          actionDefinition: {
            type: 'object',
            description:
              'Action for set_mapping, e.g. { "kind": "insertText", "text": "..." } or { "kind": "scroll", "direction": "down", "amount": 320 }.',
            additionalProperties: true,
          },
          preset: { type: 'string', enum: [...PRESET_IDS], description: 'Preset id for set_preset.' },
          patch: {
            type: 'object',
            description: 'Partial config for set_config (deep-merged, then validated).',
            additionalProperties: true,
          },
          limit: { type: 'integer', description: 'Log entries to return (default 20).' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(args) {
        const request = args !== null && typeof args === 'object' ? args : {}
        const current = store.current()

        switch (request.action) {
          case 'status':
            return {
              ok: true,
              version: PLUGIN_VERSION,
              config: current,
              warnings: store.notes(),
              runtime: {
                lastSeenAt: runtime.lastSeenAt,
                lastKeyId: runtime.lastKeyId,
                lastGesture: runtime.lastGesture,
                keyCount: runtime.keyCount,
                transcribeCount: runtime.transcribeCount,
                transcribeFailures: runtime.transcribeFailures,
                lastError: runtime.lastError,
              },
              speech: { available: speech.available, kind: speech.kind },
              device: deviceProbe.last(),
              unreachableKeys: UNREACHABLE_KEY_IDS,
            }

          case 'get_config':
            return { ok: true, config: current }

          case 'set_config': {
            const patch = request.patch !== null && typeof request.patch === 'object' ? request.patch : {}
            const merged = {
              ...current,
              ...patch,
              capture: { ...current.capture, ...(patch.capture ?? {}) },
              voice: { ...current.voice, ...(patch.voice ?? {}) },
              advanced: { ...current.advanced, ...(patch.advanced ?? {}) },
              ui: { ...current.ui, ...(patch.ui ?? {}) },
              learnedCodes: { ...current.learnedCodes, ...(patch.learnedCodes ?? {}) },
              mappings: patch.mappings ?? current.mappings,
            }
            const { config: next, warnings } = normaliseConfig(merged)
            const outcome = await store.write(next)
            return { ok: outcome.ok, persisted: outcome.persisted, reason: outcome.reason ?? null, config: next, warnings }
          }

          case 'set_preset': {
            if (!PRESET_IDS.includes(request.preset)) {
              return { ok: false, error: `未知预设 ${String(request.preset)}。可选：${PRESET_IDS.join(', ')}。` }
            }
            const { config: next } = normaliseConfig({ ...current, preset: request.preset })
            const outcome = await store.write(next)
            return { ok: outcome.ok, persisted: outcome.persisted, reason: outcome.reason ?? null, preset: next.preset }
          }

          case 'set_mapping': {
            const { logicalKey, gesture, actionDefinition } = request
            if (typeof logicalKey !== 'string' || logicalKey === '') {
              return { ok: false, error: '缺少 logicalKey。' }
            }
            if (!GESTURES.includes(gesture)) {
              return { ok: false, error: `gesture 必须是 ${GESTURES.join(' / ')} 之一。` }
            }
            const mappings = { ...current.mappings }
            mappings[logicalKey] = { ...(mappings[logicalKey] ?? {}), [gesture]: actionDefinition ?? { kind: 'none' } }
            const { config: next, warnings } = normaliseConfig({ ...current, mappings })
            const outcome = await store.write(next)
            return { ok: outcome.ok, persisted: outcome.persisted, reason: outcome.reason ?? null, mappings: next.mappings, warnings }
          }

          case 'clear_mapping': {
            const { logicalKey, gesture } = request
            if (typeof logicalKey !== 'string' || logicalKey === '') {
              return { ok: false, error: '缺少 logicalKey。' }
            }
            const mappings = { ...current.mappings }
            if (gesture === undefined) {
              delete mappings[logicalKey]
            } else {
              const perKey = { ...(mappings[logicalKey] ?? {}) }
              delete perKey[gesture]
              if (Object.keys(perKey).length === 0) delete mappings[logicalKey]
              else mappings[logicalKey] = perKey
            }
            const { config: next } = normaliseConfig({ ...current, mappings })
            const outcome = await store.write(next)
            return { ok: outcome.ok, persisted: outcome.persisted, reason: outcome.reason ?? null, mappings: next.mappings }
          }

          case 'recent_log':
            return { ok: true, entries: log.list(Number.isFinite(request.limit) ? request.limit : 20) }

          default:
            return { ok: false, error: `未知 action ${String(request.action)}。` }
        }
      },
    })
  })

  // ── commands：人类在输入框里敲 /remote2pro ───────────────────────────────────
  ctx.inject(['commands'], (scope) => {
    scope.commands.register({
      name: 'remote2pro',
      description: '查看小米蓝牙遥控器 2 Pro 插件的连接状态与当前按键映射。',
      async handler() {
        const current = store.current()
        const lines = [
          `预设：${current.preset}（${PRESETS[current.preset]?.zh ?? '未知'}）`,
          `接管：${current.capture.enabled ? '开' : '关'}｜跳过输入框：${current.capture.skipWhileTyping ? '是' : '否'}`,
          `语音：provider=${current.voice.providerId || '跟随 DSH'}｜语言=${current.voice.language}｜插入=${current.voice.insertMode}`,
          `识别服务：${speech.available ? `可用（${speech.kind}）` : '未启用'}`,
          `最近按键：${runtime.lastKeyId === '' ? '（还没有收到）' : `${runtime.lastKeyId} / ${runtime.lastGesture}`}`,
          `最近转写：${runtime.transcribeCount} 次成功，${runtime.transcribeFailures} 次失败`,
        ]
        const mappings = Object.entries(current.mappings)
        if (mappings.length > 0) {
          lines.push('映射：')
          for (const [logicalKey, gestures] of mappings) {
            const parts = Object.entries(gestures).map(([gesture, action]) => `${gesture}→${action.kind}`)
            lines.push(`  ${logicalKey}: ${parts.join(', ')}`)
          }
        }
        if (UNREACHABLE_KEY_IDS.length > 0) {
          lines.push(`系统丢键（无法映射）：${UNREACHABLE_KEY_IDS.join(', ')}`)
        }
        return { kind: 'success', text: lines.join('\n') }
      },
    })
  })

  logger.info?.(
    `[xiaomi-remote-2-pro] 已加载：预设=${initialConfig.preset}，接管=${
      initialConfig.capture.enabled ? '开' : '关'
    }${configWarnings.length > 0 ? `，配置警告 ${configWarnings.length} 条` : ''}`,
  )
}

export default { name, Config, apply }
