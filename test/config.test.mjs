import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONFIG_JSON_SCHEMA,
  Config,
  DEFAULT_CONFIG,
  PRESETS,
  PRESET_IDS,
  normaliseConfig,
} from '../lib/config.js'

test('空配置得到完整默认值', () => {
  const { config, warnings } = normaliseConfig(undefined)
  assert.deepEqual(warnings, [])
  assert.equal(config.enabled, true)
  assert.equal(config.preset, 'vibe-coding')
  assert.equal(config.capture.enabled, true)
  assert.equal(config.capture.doubleTapMs, 280)
  assert.equal(config.voice.language, 'auto')
  assert.equal(config.voice.insertMode, 'composer')
  assert.equal(config.voice.sampleRate, 16000)
  assert.equal(config.advanced.allowExec, false, '危险功能默认必须关闭')
  assert.equal(config.advanced.allowHttp, false)
  assert.deepEqual(config.advanced.execAllowlist, [])
  assert.deepEqual(config.learnedCodes, {})
})

test('默认预设给出可用的语音与导航映射', () => {
  const { config } = normaliseConfig(undefined)
  assert.deepEqual(config.mappings.voice.hold, { kind: 'dictate' })
  assert.deepEqual(config.mappings.ok.tap, { kind: 'submit' })
  assert.deepEqual(config.mappings.up.tap, { kind: 'scroll', direction: 'up', amount: 320 })
  assert.deepEqual(config.mappings.left.tap, { kind: 'scroll', direction: 'top' })
  assert.equal(config.mappings.right.tap.direction, 'bottom')
  assert.equal(config.mappings.tv.tap.kind, 'insertText')
})

test('切换预设会替换映射基底', () => {
  const { config } = normaliseConfig({ preset: 'navigation' })
  assert.equal(config.preset, 'navigation')
  assert.deepEqual(config.mappings.voice.hold, { kind: 'dictate' })
  assert.equal(config.mappings.ok, undefined, '纯导航预设不该接管 OK')

  const dictation = normaliseConfig({ preset: 'dictation' }).config
  assert.equal(dictation.mappings.menu.tap.kind, 'clear')
  assert.equal(dictation.mappings.up, undefined)
})

test('用户 mappings 覆盖在预设之上', () => {
  const { config } = normaliseConfig({
    preset: 'vibe-coding',
    mappings: { ok: { tap: { kind: 'clear' } }, home: { tap: { kind: 'none' } } },
  })
  assert.deepEqual(config.mappings.ok.tap, { kind: 'clear' })
  assert.equal(config.mappings.home, undefined, 'none 应当被丢掉')
  // 预设里的其它键还在
  assert.deepEqual(config.mappings.voice.hold, { kind: 'dictate' })
})

test('custom 预设不套用任何基底', () => {
  const { config } = normaliseConfig({ preset: 'custom' })
  assert.equal(config.preset, 'custom')
  assert.deepEqual(config.mappings, {})
})

test('未知预设回落并给出警告', () => {
  const { config, warnings } = normaliseConfig({ preset: 'nope' })
  assert.equal(config.preset, DEFAULT_CONFIG.preset)
  assert.ok(warnings.some((warning) => warning.includes('未知预设')))
})

test('非法动作被丢掉并记录警告，合法动作保留', () => {
  const { config, warnings } = normaliseConfig({
    mappings: {
      ok: { tap: { kind: 'insertText' }, doubleTap: { kind: 'bogus' }, longPress: { kind: 'submit' } },
    },
  })
  assert.equal(config.mappings.ok.tap, undefined, '缺 text 的 insertText 必须被丢掉')
  assert.equal(config.mappings.ok.doubleTap, undefined)
  assert.deepEqual(config.mappings.ok.longPress, { kind: 'submit' })
  assert.equal(warnings.filter((warning) => warning.includes('动作无效')).length, 2)
})

test('未知按键名与未知手势被丢掉，但预设里其它手势保留', () => {
  const { config, warnings } = normaliseConfig({
    mappings: { KeyZ: { tap: { kind: 'submit' } }, ok: { wiggle: { kind: 'submit' } } },
  })
  assert.equal(config.mappings.KeyZ, undefined, '未知按键名整条丢掉')
  assert.equal(config.mappings.ok.wiggle, undefined, '未知手势丢掉')
  assert.deepEqual(config.mappings.ok.tap, { kind: 'submit' }, '预设里的 tap 要保留（深合并语义）')
  assert.ok(warnings.some((warning) => warning.includes('按键名')))
  assert.ok(warnings.some((warning) => warning.includes('手势')))
})

test('custom 预设下只写 none 的按键会整条消失', () => {
  const { config } = normaliseConfig({
    preset: 'custom',
    mappings: { ok: { tap: { kind: 'none' } }, voice: { hold: { kind: 'dictate' } } },
  })
  assert.equal(config.mappings.ok, undefined)
  assert.deepEqual(config.mappings.voice.hold, { kind: 'dictate' })
})

test('学习绑定只接受合法按键名', () => {
  const { config, warnings } = normaliseConfig({
    learnedCodes: { F7: 'tv', F8: 'nope', '': 'voice' },
  })
  assert.deepEqual(config.learnedCodes, { F7: 'tv' })
  assert.equal(warnings.filter((warning) => warning.includes('学习绑定')).length, 1)
})

test('数值字段被夹到合法区间', () => {
  const { config } = normaliseConfig({
    capture: { doubleTapMs: 5, longPressMs: 999_999 },
    voice: { maxSeconds: 0, sampleRate: 400 },
    advanced: { logLimit: 1 },
  })
  assert.equal(config.capture.doubleTapMs, 80)
  assert.equal(config.capture.longPressMs, 5000)
  assert.equal(config.voice.maxSeconds, 3)
  assert.equal(config.voice.sampleRate, 8000)
  assert.equal(config.advanced.logLimit, 20)
})

test('布尔开关只认 true，其余一律回落', () => {
  const { config } = normaliseConfig({
    enabled: 'yes',
    capture: { enabled: 0, preventDefault: false },
    advanced: { allowExec: 'true' },
    voice: { autoSubmit: 1 },
  })
  assert.equal(config.enabled, true, '非 false 视为开')
  assert.equal(config.capture.enabled, true, '只有显式 false 才关')
  assert.equal(config.capture.preventDefault, false)
  assert.equal(config.advanced.allowExec, false, '只有显式 true 才开')
  assert.equal(config.voice.autoSubmit, false)
})

test('未知 insertMode 回落并警告', () => {
  const { config, warnings } = normaliseConfig({ voice: { insertMode: 'teleport' } })
  assert.equal(config.voice.insertMode, 'composer')
  assert.ok(warnings.some((warning) => warning.includes('insertMode')))
})

test('exec 白名单过滤掉非字符串', () => {
  const { config } = normaliseConfig({ advanced: { execAllowlist: ['git', 42, '', null, 'npm'] } })
  assert.deepEqual(config.advanced.execAllowlist, ['git', 'npm'])
})

test('Config（Standard Schema v1）只在完全不是对象时报错', () => {
  const schema = Config['~standard']
  assert.equal(schema.version, 1)
  assert.equal(schema.vendor, 'dsh-xiaomi-remote-2-pro')

  const empty = schema.validate(undefined)
  assert.equal(empty.issues, undefined)
  assert.equal(empty.value.preset, 'vibe-coding', '归一化后的完整配置就是 value')

  const arrayInput = schema.validate([])
  assert.ok(Array.isArray(arrayInput.issues))

  const bad = schema.validate('nope')
  assert.ok(Array.isArray(bad.issues))
  assert.ok(bad.issues[0].message.length > 0)
})

test('Config.validate 把 warnings 挂在 value 上而不是拒绝加载', () => {
  const result = Config['~standard'].validate({ preset: 'nope' })
  assert.equal(result.issues, undefined, '有警告也不能让 profile 加载失败')
  assert.ok(Array.isArray(result.value.warnings))
  assert.ok(result.value.warnings.length > 0)
  assert.equal(result.value.preset, 'vibe-coding')
})

test('预设元数据齐全', () => {
  for (const id of PRESET_IDS) {
    assert.ok(PRESETS[id], `缺少预设 ${id}`)
    assert.ok(PRESETS[id].zh.length > 0)
    assert.ok(PRESETS[id].en.length > 0)
    assert.ok(PRESETS[id].description.length > 0)
    assert.equal(typeof PRESETS[id].mappings, 'object')
  }
})

test('文档用的 JSON Schema 与预设枚举一致', () => {
  assert.deepEqual(CONFIG_JSON_SCHEMA.properties.preset.enum, [...PRESET_IDS])
  assert.deepEqual(CONFIG_JSON_SCHEMA.properties.voice.properties.insertMode.enum, [
    'composer',
    'clipboard',
    'off',
  ])
})

test('归一化不会修改传入对象', () => {
  const input = { preset: 'dictation', mappings: { ok: { tap: { kind: 'submit' } } } }
  const snapshot = JSON.stringify(input)
  normaliseConfig(input)
  assert.equal(JSON.stringify(input), snapshot)
})
