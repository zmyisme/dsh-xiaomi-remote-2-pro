import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIONS,
  ACTION_KINDS,
  GESTURES,
  createGestureEngine,
  hasMapping,
  isRemoteKey,
  resolveAction,
  validateAction,
} from '../lib/mapping.js'
import { normaliseConfig } from '../lib/config.js'

/** 造一个"某按键配了哪些手势"的判定函数。 */
function gestureTable(table) {
  return (logicalKey, gesture) => (table[logicalKey] ?? []).includes(gesture)
}

test('动作目录自身是完整的', () => {
  assert.ok(ACTION_KINDS.includes('dictate'))
  assert.ok(ACTION_KINDS.includes('insertText'))
  assert.ok(ACTION_KINDS.includes('panel'))
  assert.equal(ACTIONS.dictate.phaseAware, true, '按住说话必须是分相位的')
  assert.equal(ACTIONS.exec.danger, true, 'exec 必须标记为危险动作')
  assert.equal(ACTIONS.http.danger, true)
  for (const kind of ACTION_KINDS) {
    assert.equal(typeof ACTIONS[kind].zh, 'string')
    assert.ok(Array.isArray(ACTIONS[kind].params))
  }
})

test('validateAction 拒绝非法形状', () => {
  assert.equal(validateAction(null).ok, false)
  assert.equal(validateAction([]).ok, false)
  assert.equal(validateAction({ kind: 'nope' }).ok, false)
  assert.equal(validateAction({ kind: 'insertText' }).ok, false, 'insertText 必须带 text')
  assert.equal(validateAction({ kind: 'insertText', text: 'ok' }).ok, true)
  assert.equal(validateAction({ kind: 'key', chord: 'ctrl+k' }).ok, true)
  assert.equal(validateAction({ kind: 'key', chord: '' }).ok, false)
  assert.equal(validateAction({ kind: 'scroll', direction: 'sideways' }).ok, false)
  assert.equal(validateAction({ kind: 'scroll', direction: 'down' }).ok, true)
  assert.equal(validateAction({ kind: 'http', url: 'ftp://x' }).ok, false)
  assert.equal(validateAction({ kind: 'http', url: 'https://x/y' }).ok, true)
  assert.equal(validateAction({ kind: 'exec' }).ok, false)
  assert.equal(validateAction({ kind: 'exec', command: 'git status' }).ok, true)
})

test('resolveAction 把 none 当作"没配"', () => {
  const config = {
    mappings: {
      ok: { tap: { kind: 'submit' }, doubleTap: { kind: 'none' } },
    },
  }
  assert.deepEqual(resolveAction(config, 'ok', 'tap'), { kind: 'submit' })
  assert.equal(resolveAction(config, 'ok', 'doubleTap'), undefined)
  assert.equal(resolveAction(config, 'ok', 'hold'), undefined)
  assert.equal(resolveAction(config, 'voice', 'tap'), undefined)
  assert.equal(hasMapping(config, 'ok', 'tap'), true)
  assert.equal(hasMapping(config, 'ok', 'doubleTap'), false)

  const normalised = normaliseConfig({ mappings: { ok: { doubleTap: { kind: 'none' } } } }).config
  assert.equal(normalised.mappings.ok.doubleTap, undefined, '归一化时应把 none 丢掉')
  assert.deepEqual(normalised.mappings.ok.tap, { kind: 'submit' }, '预设里其它手势保留（深合并）')

  const onlyNone = normaliseConfig({ preset: 'custom', mappings: { ok: { doubleTap: { kind: 'none' } } } }).config
  assert.equal(onlyNone.mappings.ok, undefined, '整键只剩 none 时应连键一起消失')
})

test('单击：只在配了 tap 时立即触发', () => {
  const engine = createGestureEngine({
    hasGesture: gestureTable({ ok: ['tap'] }),
    doubleTapMs: 280,
    longPressMs: 500,
  })
  assert.deepEqual(engine.down('ok', 1000), [])
  assert.deepEqual(engine.up('ok', 1050), [{ logicalKey: 'ok', gesture: 'tap', phase: 'press' }])
  assert.equal(engine.nextDeadline(), null)
})

test('按住说话：按下与松开各触发一次', () => {
  const engine = createGestureEngine({
    hasGesture: gestureTable({ voice: ['hold'] }),
    doubleTapMs: 280,
    longPressMs: 500,
  })
  assert.deepEqual(engine.down('voice', 0), [{ logicalKey: 'voice', gesture: 'hold', phase: 'press' }])
  assert.deepEqual(engine.up('voice', 900), [{ logicalKey: 'voice', gesture: 'hold', phase: 'release' }])
})

test('自动重复不会把 hold 触发多次', () => {
  const engine = createGestureEngine({
    hasGesture: gestureTable({ voice: ['hold'] }),
    doubleTapMs: 280,
    longPressMs: 500,
  })
  assert.equal(engine.down('voice', 0).length, 1)
  // 系统按住不放会连续派发 keydown
  assert.deepEqual(engine.down('voice', 100), [])
  assert.deepEqual(engine.down('voice', 200), [])
  assert.deepEqual(engine.up('voice', 300), [{ logicalKey: 'voice', gesture: 'hold', phase: 'release' }])
})

test('长按：按住超过阈值时在按下期间就触发，松开不再补单击', () => {
  const engine = createGestureEngine({
    hasGesture: gestureTable({ menu: ['tap', 'longPress'] }),
    doubleTapMs: 280,
    longPressMs: 500,
  })
  assert.deepEqual(engine.down('menu', 0), [])
  assert.deepEqual(engine.tick(400), [], '还没到阈值')
  assert.deepEqual(engine.tick(500), [{ logicalKey: 'menu', gesture: 'longPress', phase: 'press' }])
  assert.deepEqual(engine.up('menu', 700), [], '长按已经触发过，松开不该再出单击')
})

test('长按需要 tick 推进，nextDeadline 给出准确时刻', () => {
  const engine = createGestureEngine({
    hasGesture: gestureTable({ menu: ['longPress'] }),
    doubleTapMs: 280,
    longPressMs: 500,
  })
  engine.down('menu', 1000)
  assert.equal(engine.nextDeadline(), 1500)
  assert.deepEqual(engine.tick(1499), [])
  assert.equal(engine.nextDeadline(), 1500)
  assert.equal(engine.tick(1500).length, 1)
  assert.equal(engine.nextDeadline(), null)
})

test('单击与双击共存时，单击被延迟到双击窗口结束', () => {
  const engine = createGestureEngine({
    hasGesture: gestureTable({ ok: ['tap', 'doubleTap'] }),
    doubleTapMs: 280,
    longPressMs: 500,
  })
  // 第一次快速按松：不立刻出事件，等窗口
  assert.deepEqual(engine.down('ok', 0), [])
  assert.deepEqual(engine.up('ok', 40), [])
  assert.equal(engine.nextDeadline(), 320)
  // 窗口内没有第二击 → 兑现为单击
  assert.deepEqual(engine.tick(320), [{ logicalKey: 'ok', gesture: 'tap', phase: 'press' }])
})

test('双击：窗口内第二次按松产生 doubleTap 而不是两次单击', () => {
  const engine = createGestureEngine({
    hasGesture: gestureTable({ ok: ['tap', 'doubleTap'] }),
    doubleTapMs: 280,
    longPressMs: 500,
  })
  engine.down('ok', 0)
  engine.up('ok', 40)
  engine.down('ok', 150)
  assert.deepEqual(engine.up('ok', 190), [{ logicalKey: 'ok', gesture: 'doubleTap', phase: 'press' }])
  // 双击已兑现，不该再冒出单击
  assert.deepEqual(engine.tick(10_000), [])
})

test('没配 tap 时，按松不产生任何延迟', () => {
  const engine = createGestureEngine({
    hasGesture: gestureTable({ ok: ['doubleTap'] }),
    doubleTapMs: 280,
    longPressMs: 500,
  })
  engine.down('ok', 0)
  assert.deepEqual(engine.up('ok', 40), [], '只配双击时第一次按松什么都不出')
  assert.equal(engine.nextDeadline(), 320, '但仍在等双击窗口')
  assert.deepEqual(engine.tick(320), [], '窗口过后因为没有 tap 所以什么都不出')
})

test('未配任何手势的按键完全不产生事件', () => {
  const engine = createGestureEngine({ hasGesture: () => false, doubleTapMs: 280, longPressMs: 500 })
  assert.deepEqual(engine.down('tv', 0), [])
  assert.deepEqual(engine.up('tv', 50), [])
  assert.deepEqual(engine.tick(99_999), [])
  assert.equal(engine.nextDeadline(), null)
})

test('reset 清掉全部待兑现状态', () => {
  const engine = createGestureEngine({
    hasGesture: gestureTable({ ok: ['tap', 'doubleTap'] }),
    doubleTapMs: 280,
    longPressMs: 500,
  })
  engine.down('ok', 0)
  engine.up('ok', 40)
  assert.deepEqual(engine.pendingKeys(), ['ok'])
  engine.reset()
  assert.deepEqual(engine.pendingKeys(), [])
  assert.deepEqual(engine.tick(9999), [])
})

test('isDown 反映按下状态（面板指示灯用）', () => {
  const engine = createGestureEngine({ hasGesture: gestureTable({ voice: ['hold'] }) })
  assert.equal(engine.isDown('voice'), false)
  engine.down('voice', 0)
  assert.equal(engine.isDown('voice'), true)
  engine.up('voice', 10)
  assert.equal(engine.isDown('voice'), false)
})

test('isRemoteKey 认得按键表与 unknown', () => {
  assert.equal(isRemoteKey('voice'), true)
  assert.equal(isRemoteKey('unknown'), true)
  assert.equal(isRemoteKey('KeyZ'), false)
})

test('GESTURES 列表与文档一致', () => {
  assert.deepEqual([...GESTURES], ['tap', 'doubleTap', 'longPress', 'hold'])
})

test('每一种动作都有可用的最小配置（UI 里选得出来，也存得下去）', () => {
  // 这份表与 client.js 的 defaultActionFor 保持一致：切换动作类型时会填入这些初值，
  // 否则新选的动作会因为缺参数在校验时被丢掉，用户会看到映射行凭空消失。
  const minimal = {
    none: { kind: 'none' },
    dictate: { kind: 'dictate' },
    dictateSubmit: { kind: 'dictateSubmit' },
    insertText: { kind: 'insertText', text: '' },
    prompt: { kind: 'prompt', text: '' },
    submit: { kind: 'submit' },
    newline: { kind: 'newline' },
    clear: { kind: 'clear' },
    key: { kind: 'key', chord: 'ctrl+k' },
    scroll: { kind: 'scroll', direction: 'down', amount: 320 },
    panel: { kind: 'panel' },
    log: { kind: 'log' },
    http: { kind: 'http', url: 'https://example.com/', method: 'POST' },
    exec: { kind: 'exec', command: '' },
  }

  assert.deepEqual(
    Object.keys(minimal).sort(),
    [...ACTION_KINDS].sort(),
    '新增动作时必须同步补上它的最小配置，否则这条测试会失败',
  )

  for (const [kind, action] of Object.entries(minimal)) {
    assert.equal(validateAction(action).ok, true, `${kind} 的最小配置应当被 validateAction 接受`)
    if (kind === 'none') continue
    const { config, warnings } = normaliseConfig({ preset: 'custom', mappings: { ok: { tap: action } } })
    assert.ok(config.mappings.ok?.tap, `${kind} 应当能通过配置归一化存活`)
    assert.deepEqual(warnings, [], `${kind} 不该产生配置警告`)
  }
})
