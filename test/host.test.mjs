import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { apply, name } from '../host.js'
import { encodeWav, bytesToBase64 } from '../lib/wav.js'
import { PRESET_IDS } from '../lib/config.js'

/** 造一个迷你 Cordis 上下文，记录插件注册了什么。 */
function createHarness(services = {}) {
  const routes = []
  const tools = []
  const commands = []
  const effects = []

  const webServer = {
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }

  const all = {
    webServer,
    tools: { register: (definition) => (tools.push(definition), () => {}) },
    commands: { register: (definition) => (commands.push(definition), () => {}) },
    ...services,
  }

  const ctx = {
    logger: { info() {}, warn() {} },
    inject(names, callback) {
      // 真实 Cordis 会等所有服务就绪；缺一个就整块推迟
      if (names.some((service) => all[service] === undefined)) return
      const scope = { get: (service) => all[service] }
      for (const service of names) scope[service] = all[service]
      callback(scope)
    },
    effect(callback) {
      const disposer = callback()
      effects.push(disposer)
      return disposer
    },
  }

  return { ctx, routes, tools, commands, effects }
}

function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      this.headersSent = true
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk
    },
  }
}

function makeReq({ url = '/', method = 'GET', headers = {}, body } = {}) {
  const request = new EventEmitter()
  request.url = url
  request.method = method
  request.headers = { host: '127.0.0.1:19387', ...headers }
  queueMicrotask(() => {
    if (body !== undefined) request.emit('data', Buffer.from(JSON.stringify(body)))
    request.emit('end')
  })
  return request
}

/** 调用某条路由并取回解析后的响应。 */
async function call(routes, path, options = {}) {
  const route = routes.find((candidate) => candidate.path === path)
  assert.ok(route, `路由 ${path} 没有注册`)
  const res = makeRes()
  await route.handler(makeReq({ url: path, ...options }), res)
  let value = null
  if (res.body !== '') {
    try {
      value = JSON.parse(res.body)
    } catch {
      value = res.body
    }
  }
  return { status: res.statusCode, value, headers: res.headers }
}

function fakeSpeechController() {
  const calls = { prepare: [], transcribe: [] }
  return {
    calls,
    service: {
      async catalog() {
        return {
          providers: [
            {
              id: 'sensevoice-local',
              name: 'SenseVoice',
              location: 'host-local',
              languages: ['zh', 'en'],
              preparation: { phase: 'ready' },
            },
          ],
          selection: { providerId: 'sensevoice-local', language: 'zh' },
          maxAudioBytes: 8 * 1024 * 1024,
          maxDurationSeconds: 60,
        }
      },
      prepare(providerId) {
        calls.prepare.push(providerId)
      },
      async transcribe(request) {
        calls.transcribe.push(request)
        return { text: '你好，世界', audioSeconds: 1, inferenceSeconds: 0.2 }
      },
    },
  }
}

function fakeConfigEditor() {
  const edits = []
  return {
    edits,
    service: {
      entries: () => [{ name: 'dsh-xiaomi-remote-2-pro' }],
      configuration: () => [{ entry: { name: 'dsh-xiaomi-remote-2-pro' }, override: { preset: 'custom' } }],
      async edit(entry, change) {
        edits.push({ entry, next: change({}, {}) })
      },
    },
  }
}

const PATHS = [
  '/dsh-remote2pro/api/health',
  '/dsh-remote2pro/api/state',
  '/dsh-remote2pro/api/device',
  '/dsh-remote2pro/api/config',
  '/dsh-remote2pro/api/learn',
  '/dsh-remote2pro/api/log',
  '/dsh-remote2pro/api/prepare',
  '/dsh-remote2pro/api/transcribe',
  '/dsh-remote2pro/api/host-action',
]

test('插件名与 patch id 一致', () => {
  assert.equal(name, 'xiaomi-remote-2-pro')
})

test('apply 注册全部 API 路由、一个 Tool 与一个命令', () => {
  const harness = createHarness()
  apply(harness.ctx, { advanced: { deviceProbe: false } })

  for (const path of PATHS) {
    const route = harness.routes.find((candidate) => candidate.path === path)
    assert.ok(route, `缺少路由 ${path}`)
    assert.equal(route.kind, 'exact')
  }
  assert.equal(harness.routes.length, PATHS.length, '不应注册多余路由')

  assert.equal(harness.tools.length, 1)
  assert.equal(harness.tools[0].name, 'remote_2_pro')
  assert.ok(harness.tools[0].output, 'ToolDefinition 的 output 是必填的')
  assert.equal(typeof harness.tools[0].output.render, 'function')
  assert.equal(harness.tools[0].output.schema.type, 'object')

  assert.equal(harness.commands.length, 1)
  assert.equal(harness.commands[0].name, 'remote2pro')
  assert.equal(typeof harness.commands[0].handler, 'function')
})

test('apply 在缺少 webServer 的 profile 里安静地不注册路由', () => {
  const harness = createHarness()
  // 把所有服务都摘掉，只留 tools / commands 也不行——它们同样缺席
  const bare = {
    logger: { info() {}, warn() {} },
    inject() {},
    effect(callback) {
      callback()
    },
  }
  assert.doesNotThrow(() => apply(bare, undefined))
  assert.equal(harness.routes.length, 0)
})

test('GET /api/health 返回插件身份', async () => {
  const harness = createHarness()
  apply(harness.ctx, { advanced: { deviceProbe: false } })
  const result = await call(harness.routes, '/dsh-remote2pro/api/health')
  assert.equal(result.status, 200)
  assert.equal(result.value.ok, true)
  assert.equal(result.value.plugin, 'xiaomi-remote-2-pro')
})

test('GET /api/state 返回面板需要的完整目录', async () => {
  const { service } = fakeSpeechController()
  const harness = createHarness({ speechController: service })
  apply(harness.ctx, { advanced: { deviceProbe: false } })

  const result = await call(harness.routes, '/dsh-remote2pro/api/state')
  assert.equal(result.status, 200)
  const value = result.value

  assert.equal(value.ok, true)
  assert.equal(value.config.preset, 'vibe-coding')

  // 静态目录是面板的唯一事实来源
  assert.ok(Array.isArray(value.catalog.gestures))
  assert.deepEqual(value.catalog.gestures, ['tap', 'doubleTap', 'longPress', 'hold'])
  const voice = value.catalog.keys.find((key) => key.id === 'voice')
  assert.equal(voice.zh, '语音键')
  assert.equal(voice.unreachable, false)
  const back = value.catalog.keys.find((key) => key.id === 'back')
  assert.equal(back.unreachable, true, '返回键必须标记为系统丢键')

  const dictate = value.catalog.actions.find((action) => action.kind === 'dictate')
  assert.equal(dictate.phaseAware, true)
  assert.equal(value.catalog.actions.find((action) => action.kind === 'exec').danger, true)

  assert.deepEqual(
    value.catalog.presets.map((preset) => preset.id),
    [...PRESET_IDS],
  )
  assert.equal(value.catalog.defaultCodeMap.F5, 'voice')

  assert.equal(value.speech.available, true)
  assert.equal(value.speech.selection.language, 'zh')
  assert.equal(value.fence.delegated, false)
  assert.ok(Array.isArray(value.log))
  assert.equal(typeof value.runtime.keyCount, 'number')
})

test('信任栅栏在路由层生效：跨站请求被 403 拦下', async () => {
  const harness = createHarness()
  apply(harness.ctx, { advanced: { deviceProbe: false } })

  const blocked = await call(harness.routes, '/dsh-remote2pro/api/state', {
    headers: { 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(blocked.status, 403)
  assert.equal(blocked.value.ok, false)

  const badHost = await call(harness.routes, '/dsh-remote2pro/api/state', { headers: { host: 'evil.com' } })
  assert.equal(badHost.status, 403)

  const badOrigin = await call(harness.routes, '/dsh-remote2pro/api/state', {
    headers: { origin: 'http://evil.com' },
  })
  assert.equal(badOrigin.status, 403)
})

test('POST /api/config 深合并并写回 profile', async () => {
  const editor = fakeConfigEditor()
  const harness = createHarness({ configEditor: editor.service })
  apply(harness.ctx, { advanced: { deviceProbe: false } })

  const result = await call(harness.routes, '/dsh-remote2pro/api/config', {
    method: 'POST',
    body: { capture: { longPressMs: 700 } },
  })
  assert.equal(result.status, 200)
  assert.equal(result.value.ok, true)
  assert.equal(result.value.persisted, true)
  assert.equal(result.value.config.capture.longPressMs, 700)
  // 没被 patch 的字段必须保留
  assert.equal(result.value.config.capture.doubleTapMs, 280)
  assert.equal(result.value.config.voice.sampleRate, 16000)
  assert.equal(editor.edits.length, 1, '必须走一次 configEditor.edit')

  // 后续读状态要能看到新值（防止出现两份会漂移的配置副本）
  const state = await call(harness.routes, '/dsh-remote2pro/api/state')
  assert.equal(state.value.config.capture.longPressMs, 700)
})

test('POST /api/config 拒绝非对象请求体', async () => {
  const harness = createHarness()
  apply(harness.ctx, { advanced: { deviceProbe: false } })
  const request = new EventEmitter()
  request.url = '/dsh-remote2pro/api/config'
  request.method = 'POST'
  request.headers = { host: '127.0.0.1:1' }
  const res = makeRes()
  const route = harness.routes.find((candidate) => candidate.path === '/dsh-remote2pro/api/config')
  const promise = route.handler(request, res)
  queueMicrotask(() => {
    request.emit('data', Buffer.from('[1,2,3]'))
    request.emit('end')
  })
  await promise
  assert.equal(res.statusCode, 400)
})

test('POST /api/config 在没有 configEditor 时仍生效但明确标注未持久化', async () => {
  const harness = createHarness()
  apply(harness.ctx, { advanced: { deviceProbe: false } })
  const result = await call(harness.routes, '/dsh-remote2pro/api/config', {
    method: 'POST',
    body: { voice: { language: 'en' } },
  })
  assert.equal(result.value.ok, true)
  assert.equal(result.value.persisted, false)
  assert.match(result.value.reason, /configEditor/)
  assert.equal(result.value.config.voice.language, 'en')
})

test('POST /api/learn 保存与删除学习绑定', async () => {
  const editor = fakeConfigEditor()
  const harness = createHarness({ configEditor: editor.service })
  apply(harness.ctx, { advanced: { deviceProbe: false } })

  const learned = await call(harness.routes, '/dsh-remote2pro/api/learn', {
    method: 'POST',
    body: { code: 'F7', logicalKey: 'tv' },
  })
  assert.equal(learned.value.ok, true)
  assert.equal(learned.value.learnedCodes.F7, 'tv')

  const removed = await call(harness.routes, '/dsh-remote2pro/api/learn', {
    method: 'POST',
    body: { code: 'F7' },
  })
  assert.equal(removed.value.learnedCodes.F7, undefined)

  const missing = await call(harness.routes, '/dsh-remote2pro/api/learn', { method: 'POST', body: {} })
  assert.equal(missing.status, 400)
})

test('POST /api/transcribe 在没有语音服务时给出可执行的提示', async () => {
  const harness = createHarness()
  apply(harness.ctx, { advanced: { deviceProbe: false } })
  const wav = encodeWav({ samples: new Float32Array(16000), sampleRate: 16000 })
  const result = await call(harness.routes, '/dsh-remote2pro/api/transcribe', {
    method: 'POST',
    body: { audioBase64: bytesToBase64(wav) },
  })
  assert.equal(result.status, 500)
  assert.equal(result.value.ok, false)
  assert.match(result.value.error, /语音服务未启用/)
})

test('POST /api/transcribe 在音频非法时返回 400 且不调用识别器', async () => {
  const speech = fakeSpeechController()
  const harness = createHarness({ speechController: speech.service })
  apply(harness.ctx, { advanced: { deviceProbe: false } })

  const result = await call(harness.routes, '/dsh-remote2pro/api/transcribe', {
    method: 'POST',
    body: { audioBase64: 'bm90LWEtd2F2' },
  })
  assert.equal(result.status, 400)
  assert.equal(result.value.ok, false)
  assert.equal(speech.calls.transcribe.length, 0, '坏音频不该送到识别器')
})

test('POST /api/transcribe 成功时透传 provider 与语言选择', async () => {
  const speech = fakeSpeechController()
  const editor = fakeConfigEditor()
  const harness = createHarness({ speechController: speech.service, configEditor: editor.service })
  apply(harness.ctx, { advanced: { deviceProbe: false } })

  await call(harness.routes, '/dsh-remote2pro/api/config', {
    method: 'POST',
    body: { voice: { language: 'en', providerId: 'sensevoice-local' } },
  })

  const wav = encodeWav({ samples: new Float32Array(16000), sampleRate: 16000 })
  const result = await call(harness.routes, '/dsh-remote2pro/api/transcribe', {
    method: 'POST',
    body: { audioBase64: bytesToBase64(wav) },
  })

  assert.equal(result.status, 200)
  assert.equal(result.value.ok, true)
  assert.equal(result.value.text, '你好，世界')
  assert.equal(speech.calls.transcribe.length, 1)
  assert.equal(speech.calls.transcribe[0].language, 'en')
  assert.equal(speech.calls.transcribe[0].providerId, 'sensevoice-local')
  // 语音调用不得激活或提交给 Agent——这里只是断言它没有别的副作用面
  assert.equal(typeof speech.calls.transcribe[0].audioBase64, 'string')
})

test('POST /api/transcribe 把 auto 语言翻译成"不指定"', async () => {
  const speech = fakeSpeechController()
  const harness = createHarness({ speechController: speech.service })
  apply(harness.ctx, { advanced: { deviceProbe: false } })
  const wav = encodeWav({ samples: new Float32Array(16000), sampleRate: 16000 })
  await call(harness.routes, '/dsh-remote2pro/api/transcribe', {
    method: 'POST',
    body: { audioBase64: bytesToBase64(wav) },
  })
  assert.equal(speech.calls.transcribe[0].language, undefined)
  assert.equal(speech.calls.transcribe[0].providerId, undefined)
})

test('POST /api/prepare 预热识别器，缺 providerId 时报 400', async () => {
  const speech = fakeSpeechController()
  const harness = createHarness({ speechController: speech.service })
  apply(harness.ctx, { advanced: { deviceProbe: false } })

  const ok = await call(harness.routes, '/dsh-remote2pro/api/prepare', {
    method: 'POST',
    body: { providerId: 'sensevoice-local' },
  })
  assert.equal(ok.status, 200)
  assert.deepEqual(speech.calls.prepare, ['sensevoice-local'])

  const bad = await call(harness.routes, '/dsh-remote2pro/api/prepare', { method: 'POST', body: {} })
  assert.equal(bad.status, 400)
})

test('POST /api/log 收集按键日志、支持清空、并维护最近活动', async () => {
  const harness = createHarness()
  apply(harness.ctx, { advanced: { deviceProbe: false } })

  const pushed = await call(harness.routes, '/dsh-remote2pro/api/log', {
    method: 'POST',
    body: { type: 'key', logicalKey: 'voice', gesture: 'hold' },
  })
  assert.equal(pushed.value.ok, true)
  assert.equal(pushed.value.size, 1)

  const state = await call(harness.routes, '/dsh-remote2pro/api/state')
  assert.equal(state.value.runtime.lastKeyId, 'voice')
  assert.equal(state.value.runtime.lastGesture, 'hold')
  assert.equal(state.value.runtime.keyCount, 1)
  assert.ok(state.value.runtime.lastSeenAt > 0)
  assert.equal(state.value.log[0].logicalKey, 'voice')

  const cleared = await call(harness.routes, '/dsh-remote2pro/api/log', {
    method: 'POST',
    body: { clear: true },
  })
  assert.equal(cleared.value.cleared, true)
  const after = await call(harness.routes, '/dsh-remote2pro/api/state')
  assert.equal(after.value.log.length, 0)
})

test('POST /api/host-action 默认拒绝 http 与 exec', async () => {
  const harness = createHarness()
  apply(harness.ctx, { advanced: { deviceProbe: false } })

  const http = await call(harness.routes, '/dsh-remote2pro/api/host-action', {
    method: 'POST',
    body: { action: { kind: 'http', url: 'https://example.com' } },
  })
  assert.equal(http.status, 403)
  assert.match(http.value.error, /allowHttp/)

  const exec = await call(harness.routes, '/dsh-remote2pro/api/host-action', {
    method: 'POST',
    body: { action: { kind: 'exec', command: 'whoami' } },
  })
  assert.equal(exec.status, 403)
  assert.match(exec.value.error, /allowExec/)

  const unknown = await call(harness.routes, '/dsh-remote2pro/api/host-action', {
    method: 'POST',
    body: { action: { kind: 'nope' } },
  })
  assert.equal(unknown.status, 400)
})

test('exec 即便开启也必须命中非空白名单', async () => {
  const editor = fakeConfigEditor()
  const harness = createHarness({ configEditor: editor.service })
  apply(harness.ctx, { advanced: { deviceProbe: false } })

  await call(harness.routes, '/dsh-remote2pro/api/config', {
    method: 'POST',
    body: { advanced: { allowExec: true } },
  })

  const emptyAllowlist = await call(harness.routes, '/dsh-remote2pro/api/host-action', {
    method: 'POST',
    body: { action: { kind: 'exec', command: 'whoami' } },
  })
  assert.equal(emptyAllowlist.status, 403)
  assert.match(emptyAllowlist.value.error, /白名单为空/)

  await call(harness.routes, '/dsh-remote2pro/api/config', {
    method: 'POST',
    body: { advanced: { allowExec: true, execAllowlist: ['git'] } },
  })
  const outside = await call(harness.routes, '/dsh-remote2pro/api/host-action', {
    method: 'POST',
    body: { action: { kind: 'exec', command: 'whoami' } },
  })
  assert.equal(outside.status, 403)
  assert.match(outside.value.error, /不在白名单/)
})

test('GET /api/device 在关闭探测时明确说明', async () => {
  const harness = createHarness()
  apply(harness.ctx, { advanced: { deviceProbe: false } })
  const result = await call(harness.routes, '/dsh-remote2pro/api/device')
  assert.equal(result.value.disabled, true)
  assert.equal(result.value.status, 'disabled')
})

test('Tool remote_2_pro：status / get_config / set_preset / set_mapping / clear_mapping / recent_log', async () => {
  const editor = fakeConfigEditor()
  const harness = createHarness({ configEditor: editor.service })
  apply(harness.ctx, { advanced: { deviceProbe: false } })
  const tool = harness.tools[0]

  const status = await tool.execute({ action: 'status' })
  assert.equal(status.ok, true)
  assert.equal(status.config.preset, 'vibe-coding')
  assert.deepEqual(status.unreachableKeys.includes('back'), true)
  assert.equal(status.speech.available, false)

  const config = await tool.execute({ action: 'get_config' })
  assert.equal(config.config.capture.doubleTapMs, 280)

  const preset = await tool.execute({ action: 'set_preset', preset: 'dictation' })
  assert.equal(preset.ok, true)
  assert.equal(preset.preset, 'dictation')

  const badPreset = await tool.execute({ action: 'set_preset', preset: 'nope' })
  assert.equal(badPreset.ok, false)
  assert.match(badPreset.error, /未知预设/)

  const mapped = await tool.execute({
    action: 'set_mapping',
    logicalKey: 'menu',
    gesture: 'doubleTap',
    actionDefinition: { kind: 'scroll', direction: 'top' },
  })
  assert.equal(mapped.ok, true)
  assert.deepEqual(mapped.mappings.menu.doubleTap, { kind: 'scroll', direction: 'top' })

  const badGesture = await tool.execute({ action: 'set_mapping', logicalKey: 'menu', gesture: 'wiggle' })
  assert.equal(badGesture.ok, false)

  const cleared = await tool.execute({ action: 'clear_mapping', logicalKey: 'menu', gesture: 'doubleTap' })
  assert.equal(cleared.ok, true)
  assert.equal(cleared.mappings.menu?.doubleTap, undefined)

  const log = await tool.execute({ action: 'recent_log', limit: 5 })
  assert.equal(log.ok, true)
  assert.ok(Array.isArray(log.entries))

  const unknown = await tool.execute({ action: 'nope' })
  assert.equal(unknown.ok, false)
})

test('Tool 的 set_config 深合并并校验', async () => {
  const harness = createHarness()
  apply(harness.ctx, { advanced: { deviceProbe: false } })
  const tool = harness.tools[0]

  const result = await tool.execute({
    action: 'set_config',
    patch: { capture: { doubleTapMs: 350 }, voice: { insertMode: 'clipboard' } },
  })
  assert.equal(result.ok, true)
  assert.equal(result.config.capture.doubleTapMs, 350)
  assert.equal(result.config.voice.insertMode, 'clipboard')
  assert.equal(result.config.capture.longPressMs, 500, '未 patch 的字段保留')
})

test('Tool 的 output.render 返回文本内容块', async () => {
  const harness = createHarness()
  apply(harness.ctx, { advanced: { deviceProbe: false } })
  const blocks = harness.tools[0].output.render({}, { ok: true, hello: '世界' })
  assert.ok(Array.isArray(blocks))
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /世界/)
})

test('Tool 的每个返回值都必须是无损 JSON', async () => {
  // DSH 会校验工具的返回值能否无损地 JSON 往返；带 undefined 属性的对象会被判为
  // "value is not lossless JSON" 并直接把这次工具调用判为失败。实测踩过一次
  // （set_config 成功时 reason 是 undefined），所以这里把每个 action 都钉住。
  const editor = fakeConfigEditor()
  const speech = fakeSpeechController()
  const harness = createHarness({ configEditor: editor.service, speechController: speech.service })
  apply(harness.ctx, { advanced: { deviceProbe: false } })
  const tool = harness.tools[0]

  const invocations = [
    { action: 'status' },
    { action: 'get_config' },
    { action: 'set_config', patch: { capture: { doubleTapMs: 320 } } },
    { action: 'set_preset', preset: 'dictation' },
    { action: 'set_mapping', logicalKey: 'menu', gesture: 'tap', actionDefinition: { kind: 'panel' } },
    { action: 'clear_mapping', logicalKey: 'menu' },
    { action: 'recent_log' },
    { action: 'recent_log', limit: 3 },
    { action: 'bogus-action' },
  ]

  for (const args of invocations) {
    const value = await tool.execute(args)
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(value)),
      value,
      `${args.action} 的返回值不是无损 JSON —— 多半是某个字段为 undefined`,
    )
  }
})

test('成功的写入不能把 reason: undefined 漏进返回值', async () => {
  const editor = fakeConfigEditor()
  const harness = createHarness({ configEditor: editor.service })
  apply(harness.ctx, { advanced: { deviceProbe: false } })
  const tool = harness.tools[0]

  const written = await tool.execute({ action: 'set_config', patch: { voice: { language: 'en' } } })
  assert.equal(written.persisted, true)
  assert.ok('reason' in written, 'reason 字段应当存在（成功时为 null）')
  assert.equal(written.reason, null)
})

test('命令 /remote2pro 输出中文状态摘要', async () => {
  const { service } = fakeSpeechController()
  const harness = createHarness({ speechController: service })
  apply(harness.ctx, { advanced: { deviceProbe: false } })

  const result = await harness.commands[0].handler({})
  assert.equal(result.kind, 'success')
  assert.match(result.text, /预设/)
  assert.match(result.text, /vibe-coding/)
  assert.match(result.text, /语音/)
  assert.match(result.text, /系统丢键/)
  assert.match(result.text, /back/)
})

test('卸载时释放全部路由（重载不会撞重复路径）', () => {
  const harness = createHarness()
  apply(harness.ctx, { advanced: { deviceProbe: false } })
  assert.equal(harness.routes.length, PATHS.length)

  for (const disposer of harness.effects) {
    if (typeof disposer === 'function') disposer()
  }
  assert.equal(harness.routes.length, 0, '所有路由都应被释放')
})

test('配置里的非法映射在加载时降级而不是让插件激活失败', () => {
  const harness = createHarness()
  assert.doesNotThrow(() =>
    apply(harness.ctx, {
      preset: 'nope',
      mappings: { ok: { tap: { kind: 'bogus' } }, KeyZ: { tap: { kind: 'submit' } } },
      advanced: { deviceProbe: false },
    }),
  )
  assert.equal(harness.routes.length, PATHS.length)
})
