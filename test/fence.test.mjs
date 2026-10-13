import test from 'node:test'
import assert from 'node:assert/strict'

import { createFence, isLoopbackHostname, readJsonBody, selfRejection, trustedHostsFromEnv } from '../lib/fence.js'

/** 造一个最小的 http 请求对象。 */
function req(headers, url = '/dsh-remote2pro/api/state') {
  return { headers, url, on() {} }
}

test('isLoopbackHostname 只认回环', () => {
  for (const host of ['localhost', 'LOCALHOST', 'api.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
    assert.equal(isLoopbackHostname(host), true, `${host} 应当被认作回环`)
  }
  for (const host of ['', '127.0.0.1.evil.com', 'evil.com', '128.0.0.1', '127.0.0.256', 'localhost.evil.com', '0.0.0.0']) {
    assert.equal(isLoopbackHostname(host), false, `${host} 不应被认作回环`)
  }
})

test('selfRejection 放行正常的同源回环请求', () => {
  assert.equal(selfRejection(req({ host: '127.0.0.1:19387' }), { trustedHosts: [] }), null)
  assert.equal(
    selfRejection(req({ host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387', 'sec-fetch-site': 'same-origin' }), {
      trustedHosts: [],
    }),
    null,
  )
})

test('selfRejection 拒绝缺失 / 畸形 Host', () => {
  assert.equal(selfRejection(req({}), { trustedHosts: [] }), 403)
  assert.equal(selfRejection(req({ host: 'not a host' }), { trustedHosts: [] }), 403)
})

test('selfRejection 拒绝非回环 Host（DNS 重绑定防护）', () => {
  assert.equal(selfRejection(req({ host: 'evil.com' }), { trustedHosts: [] }), 403)
  assert.equal(selfRejection(req({ host: '127.0.0.1.evil.com' }), { trustedHosts: [] }), 403)
  assert.equal(selfRejection(req({ host: 'evil.com' }), { trustedHosts: ['evil.com'] }), null, '显式信任后放行')
})

test('selfRejection 拒绝跨站请求与跨源 Origin', () => {
  assert.equal(selfRejection(req({ host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' }), { trustedHosts: [] }), 403)
  assert.equal(selfRejection(req({ host: '127.0.0.1:1', origin: 'http://evil.com' }), { trustedHosts: [] }), 403)
  assert.equal(selfRejection(req({ host: '127.0.0.1:1', origin: 'garbage' }), { trustedHosts: [] }), 403)
  assert.equal(selfRejection(req({ host: '127.0.0.1:1', origin: 'null' }), { trustedHosts: [] }), null)
})

test('trustedHostsFromEnv 解析逗号分隔的环境变量', () => {
  assert.deepEqual(trustedHostsFromEnv({ DSH_REMOTE2PRO_TRUSTED_HOSTS: 'a.com, B.com ,,c.com' }), [
    'a.com',
    'b.com',
    'c.com',
  ])
  assert.deepEqual(trustedHostsFromEnv({}), [])
  assert.deepEqual(trustedHostsFromEnv(undefined), [])
})

test('createFence 在宿主没有栅栏时只靠自校验，并只警告一次', () => {
  const warnings = []
  const fence = createFence({ connection: undefined, trustedHosts: [], logger: { warn: (m) => warnings.push(m) } })
  assert.equal(fence.delegated, false)
  assert.equal(fence.check(req({ host: '127.0.0.1:1' })), null)
  assert.equal(fence.check(req({ host: '127.0.0.1:1' })), null)
  assert.equal(warnings.length, 1, '缺失警告应当只打一次')
  assert.match(warnings[0], /requestRejection/)
})

test('createFence 委托宿主栅栏，并沿用它的返回码', () => {
  const seen = []
  const fence = createFence({
    connection: { requestRejection: (request) => (seen.push(request), 401) },
    trustedHosts: [],
    logger: { warn() {} },
  })
  assert.equal(fence.delegated, true)
  assert.equal(fence.check(req({ host: '127.0.0.1:1' })), 401)
  assert.equal(seen.length, 1)
})

test('createFence 认宿主栅栏的各种返回形状', () => {
  const cases = [
    [undefined, null],
    [null, null],
    [false, null],
    [true, null],
    [403, 403],
    [{ status: 418 }, 418],
    [{ statusCode: 419 }, 419],
    [{ reject: true }, 403],
    [{ reject: false }, null],
  ]
  for (const [verdict, expected] of cases) {
    const fence = createFence({
      connection: { requestRejection: () => verdict },
      trustedHosts: [],
      logger: { warn() {} },
    })
    assert.equal(fence.check(req({ host: '127.0.0.1:1' })), expected, `verdict=${JSON.stringify(verdict)}`)
  }
})

test('宿主栅栏抛异常时按拒绝处理，绝不 fail-open', () => {
  const warnings = []
  const fence = createFence({
    connection: {
      requestRejection() {
        throw new Error('boom')
      },
    },
    trustedHosts: [],
    logger: { warn: (m) => warnings.push(m) },
  })
  assert.equal(fence.check(req({ host: '127.0.0.1:1' })), 403)
  assert.ok(warnings.some((warning) => warning.includes('boom')))
})

test('createFence 通过 getConnection 惰性取值（服务后到时也能拿到）', () => {
  let service
  const fence = createFence({ getConnection: () => service, trustedHosts: [], logger: { warn() {} } })
  assert.equal(fence.delegated, false)
  service = { requestRejection: () => 401 }
  assert.equal(fence.delegated, true)
  assert.equal(fence.check(req({ host: '127.0.0.1:1' })), 401)
})

test('自校验永远先跑，宿主无栅栏也拦得住跨站请求', () => {
  let called = 0
  const fence = createFence({
    connection: {
      requestRejection() {
        called += 1
        return null
      },
    },
    trustedHosts: [],
    logger: { warn() {} },
  })
  assert.equal(fence.check(req({ host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' })), 403)
  assert.equal(called, 0, '被自校验拦下的请求不该再去问宿主')
})

test('readJsonBody 解析合法 JSON、空体与坏 JSON', async () => {
  const makeReq = (chunks) => {
    const listeners = {}
    const request = {
      on(event, handler) {
        listeners[event] = handler
        return request
      },
      destroy() {},
    }
    queueMicrotask(() => {
      for (const chunk of chunks) listeners.data?.(Buffer.from(chunk))
      listeners.end?.()
    })
    return request
  }

  assert.deepEqual(await readJsonBody(makeReq(['{"a":1}'])), { ok: true, value: { a: 1 } })
  assert.deepEqual(await readJsonBody(makeReq([])), { ok: true, value: {} })
  const bad = await readJsonBody(makeReq(['{oops']))
  assert.equal(bad.ok, false)
  assert.equal(bad.status, 400)
})

test('readJsonBody 超过上限时返回 413', async () => {
  const listeners = {}
  const request = {
    on(event, handler) {
      listeners[event] = handler
      return request
    },
    destroy() {},
  }
  const promise = readJsonBody(request, 4)
  listeners.data(Buffer.from('12345'))
  const result = await promise
  assert.equal(result.ok, false)
  assert.equal(result.status, 413)
})
