import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_CODE_MAP,
  DEFAULT_KEY_MAP,
  KNOWN_KEY_IDS,
  RC003_USAGES,
  REMOTE_KEYS,
  UNREACHABLE_KEY_IDS,
  describeKeyEvent,
  keyIdOf,
  matchChord,
  normaliseKeyEvent,
  parseChord,
} from '../lib/keys.js'

test('遥控器按键表本身是自洽的', () => {
  const ids = REMOTE_KEYS.map((key) => key.id)
  assert.equal(new Set(ids).size, ids.length, '按键 id 不能重复')
  for (const key of REMOTE_KEYS) {
    assert.equal(typeof key.zh, 'string')
    assert.equal(typeof key.en, 'string')
    assert.ok(key.zh.length > 0)
  }
  assert.ok(ids.includes('voice'))
  assert.ok(ids.includes('ok'))
})

test('被 kbdhid.sys 丢弃的三个键 + 静音键在不可达清单里', () => {
  // 这是本插件最重要的一条事实：不提供永远不触发的映射
  for (const id of ['back', 'volUp', 'volDown', 'mute']) {
    assert.ok(UNREACHABLE_KEY_IDS.includes(id), `${id} 应当在不可达清单里`)
  }
  assert.equal(RC003_USAGES.back, 0x00f1)
  assert.equal(RC003_USAGES.volUp, 0x0080)
  assert.equal(RC003_USAGES.volDown, 0x0081)
  assert.equal(RC003_USAGES.voice, 0x003e, '语音键是 usage 0x3E（Windows 上是 F5）')
})

test('默认映射只包含实测可达的键码', () => {
  assert.equal(DEFAULT_CODE_MAP.F5, 'voice', '语音键在 Windows 上就是 F5')
  assert.equal(DEFAULT_CODE_MAP.Enter, 'ok')
  assert.equal(DEFAULT_CODE_MAP.ArrowUp, 'up')
  assert.equal(DEFAULT_CODE_MAP.Home, 'home')
  assert.equal(DEFAULT_CODE_MAP.ContextMenu, 'menu')
  assert.equal(DEFAULT_CODE_MAP.Backquote, 'tv')
  // 不该出现被系统吞掉的键
  for (const code of ['AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute', 'BrowserBack']) {
    assert.equal(DEFAULT_CODE_MAP[code], undefined, `${code} 不应出现在默认表里`)
  }
  assert.equal(DEFAULT_KEY_MAP.F5, 'voice')
})

test('normaliseKeyEvent 优先 code，回退 key', () => {
  assert.deepEqual(normaliseKeyEvent({ code: 'F5', key: 'F5' }), {
    logicalKey: 'voice',
    code: 'F5',
    key: 'F5',
    display: 'F5',
    source: 'code',
    known: true,
  })

  const byKey = normaliseKeyEvent({ code: 'Unidentified', key: 'Home' })
  assert.equal(byKey.logicalKey, 'home')
  assert.equal(byKey.source, 'key')

  const unknown = normaliseKeyEvent({ code: 'KeyZ', key: 'z' })
  assert.equal(unknown.logicalKey, 'unknown')
  assert.equal(unknown.known, false)
  assert.equal(unknown.display, 'z (KeyZ)')
})

test('normaliseKeyEvent 支持学习模式覆盖的表', () => {
  const result = normaliseKeyEvent({ code: 'F7', key: 'F7' }, { F7: 'tv' })
  assert.equal(result.logicalKey, 'tv')
  assert.equal(result.source, 'code')
})

test('describeKeyEvent 能处理残缺事件', () => {
  assert.equal(describeKeyEvent({}), '(空)')
  assert.equal(describeKeyEvent({ code: 'Enter' }), 'Enter')
  assert.equal(describeKeyEvent({ code: 'Enter', key: 'Enter' }), 'Enter')
})

test('parseChord 解析修饰键与主键', () => {
  assert.deepEqual(parseChord('ctrl+alt+space'), {
    ctrl: true,
    alt: true,
    shift: false,
    meta: false,
    part: 'space',
  })
  assert.deepEqual(parseChord('Shift+F5'), {
    ctrl: false,
    alt: false,
    shift: true,
    meta: false,
    part: 'F5',
  })
  assert.equal(parseChord(''), null)
  assert.equal(parseChord('ctrl+'), null)
  assert.equal(parseChord(undefined), null)
})

test('matchChord 严格比较修饰键状态', () => {
  const event = { code: 'Space', key: ' ', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false }
  assert.equal(matchChord(event, 'ctrl+alt+space'), true)
  assert.equal(matchChord(event, 'ctrl+alt+Space'), true)
  assert.equal(matchChord(event, 'ctrl+space'), false)
  assert.equal(matchChord({ ...event, shiftKey: true }, 'ctrl+alt+space'), false)
})

test('matchChord 支持单字母写法匹配 KeyX 形式的 code', () => {
  assert.equal(matchChord({ code: 'KeyK', key: 'k' }, 'ctrl+k'), false, '缺 ctrl 应不匹配')
  assert.equal(matchChord({ code: 'KeyK', key: 'k', ctrlKey: true }, 'ctrl+k'), true)
})

test('keyIdOf 把非法值收敛成 unknown', () => {
  for (const id of KNOWN_KEY_IDS) assert.equal(keyIdOf(id), id)
  assert.equal(keyIdOf('nope'), 'unknown')
  assert.equal(keyIdOf(undefined), 'unknown')
  assert.equal(keyIdOf(42), 'unknown')
})
