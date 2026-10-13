/**
 * HTTP 路由的工具层与**信任栅栏**。
 *
 * ## 为什么自己也要做一遍校验
 *
 * 本插件的路由里有一条会写配置、还有一条会调用系统语音识别——都属于"能被滥用"的
 * 操作。DSH 的 `ctx.connection.requestRejection(req)` 提供了宿主级校验，但在部分
 * 宿主版本上这个方法**不存在**，而已知实现里"服务缺失"与"自身抛异常"两条路径都曾
 * 是 fail-open（放行）。社区里已有插件因此让 22 条路由集体失去校验。
 *
 * 所以这里的顺序刻意是：
 *
 * 1. **插件自己的轻量校验永远先跑**：只认回环 Host、拒绝 `Sec-Fetch-Site: cross-site`、
 *    有 `Origin` 时必须与 Host 同源。
 * 2. 宿主栅栏可用 → 委托它，返回码照用；**它抛异常一律按拒绝处理**。
 * 3. 宿主栅栏不可用 → 只靠第 1 层，并在**插件加载时**打一条醒目警告。
 */

/** 允许额外信任的 Host（逗号分隔），用于非回环部署。 */
const TRUSTED_HOSTS_ENV = 'DSH_REMOTE2PRO_TRUSTED_HOSTS'

/** 内置的默认响应上限，防止一条畸形请求把宿主拖死。 */
export const MAX_JSON_BODY_BYTES = 12 * 1024 * 1024

/**
 * 判断主机名是否是回环地址。
 *
 * 逐段校验 IPv4，避免 `127.0.0.1.evil.com` 这类相似域名被误判为可信。
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLoopbackHostname(hostname) {
  const host = String(hostname ?? '')
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
  if (host === '') return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1') return true

  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (match === null) return false
  if (Number(match[1]) !== 127) return false
  return [match[2], match[3], match[4]].every((part) => Number(part) <= 255)
}

/** 读取环境变量里声明的额外可信主机。 */
export function trustedHostsFromEnv(env = globalThis.process?.env) {
  return String(env?.[TRUSTED_HOSTS_ENV] ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '')
}

/**
 * 插件自己的轻量校验。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ trustedHosts?: string[] }} [options]
 * @returns {number | null} 应当返回的拒绝状态码；`null` 表示放行。
 */
export function selfRejection(req, options = {}) {
  const headers = req?.headers ?? {}
  const trustedHosts = options.trustedHosts ?? trustedHostsFromEnv()

  const rawHost = String(headers.host ?? '')
  let hostUrl
  try {
    hostUrl = new URL(`http://${rawHost}`)
  } catch {
    return 403 // 缺 Host 或形状畸形
  }

  const hostname = hostUrl.hostname.toLowerCase()
  if (!isLoopbackHostname(hostname) && !trustedHosts.includes(hostname)) return 403

  // 跨站请求一律拒绝：正常页面与本地脚本都不会带这个值
  const fetchSite = String(headers['sec-fetch-site'] ?? '').toLowerCase()
  if (fetchSite === 'cross-site') return 403

  const rawOrigin = headers.origin
  if (typeof rawOrigin === 'string' && rawOrigin !== '' && rawOrigin !== 'null') {
    let originUrl
    try {
      originUrl = new URL(rawOrigin)
    } catch {
      return 403
    }
    if (originUrl.host !== hostUrl.host) return 403
  }

  return null
}

/**
 * 创建完整的信任栅栏。
 *
 * `connection` 支持传服务实例或 `getConnection` 取值函数：Cordis 的服务就绪顺序不
 * 确定，如果在这里把服务快照下来，早于 `connection` 就绪的实例会永远以为宿主没有栅栏。
 *
 * @param {{
 *   connection?: { requestRejection?: (request: unknown) => unknown },
 *   getConnection?: () => { requestRejection?: (request: unknown) => unknown } | undefined,
 *   trustedHosts?: string[],
 *   logger?: { warn?: Function },
 * }} [options]
 */
export function createFence(options = {}) {
  const trustedHosts = options.trustedHosts ?? trustedHostsFromEnv()
  const logger = options.logger ?? console
  let warned = false

  const resolveConnection = typeof options.getConnection === 'function'
    ? options.getConnection
    : () => options.connection

  function fenceOf() {
    const connection = resolveConnection()
    return typeof connection?.requestRejection === 'function' ? connection : undefined
  }

  return {
    /** 栅栏是否拿到了宿主实现（每次现取）。 */
    get delegated() {
      return fenceOf() !== undefined
    },

    /** 宿主栅栏缺失时提醒一次。由首次真正需要校验的请求触发，避免时序竞态。 */
    warnIfMissing() {
      if (warned || fenceOf() !== undefined) return
      warned = true
      logger.warn?.(
        '[xiaomi-remote-2-pro] 宿主没有提供 ctx.connection.requestRejection —— ' +
          '本次只使用插件自带的回环 / 同源校验。若你在非回环地址上暴露了 DSH，请设置 ' +
          `${TRUSTED_HOSTS_ENV} 并自行加一层反向代理鉴权。`,
      )
    },

    /**
     * 校验一条请求。
     * @param {import('node:http').IncomingMessage} req
     * @returns {number | null} 拒绝状态码；`null` 表示放行。
     */
    check(req) {
      // 1. 插件自己的校验永远先跑
      const own = selfRejection(req, { trustedHosts })
      if (own !== null) return own

      // 2. 宿主栅栏可用则委托
      const connection = fenceOf()
      if (connection === undefined) {
        this.warnIfMissing()
        return null
      }

      try {
        const verdict = connection.requestRejection(req)
        if (verdict === undefined || verdict === null || verdict === false) return null
        if (typeof verdict === 'number') return verdict
        if (typeof verdict === 'object') {
          const status = verdict.status ?? verdict.statusCode
          if (typeof status === 'number') return status
          if (verdict.reject === true) return 403
          return null
        }
        return null
      } catch (error) {
        // 宿主栅栏自己炸了 → 按拒绝处理，绝不 fail-open
        logger.warn?.(`[xiaomi-remote-2-pro] 宿主信任栅栏抛异常，已按拒绝处理：${String(error)}`)
        return 403
      }
    },
  }
}

/** 发送 JSON 响应。 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload ?? null)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** 发送文本 / 脚本响应。 */
export function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/**
 * 读取并解析 JSON 请求体。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, status: number, reason: string }>}
 */
export function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        finish({ ok: false, status: 413, reason: `请求体超过 ${maxBytes} 字节上限。` })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        finish({ ok: true, value: {} })
        return
      }
      try {
        finish({ ok: true, value: JSON.parse(text) })
      } catch {
        finish({ ok: false, status: 400, reason: '请求体不是合法 JSON。' })
      }
    })

    req.on('error', (error) => {
      finish({ ok: false, status: 400, reason: `读取请求体失败：${String(error)}` })
    })
  })
}
