// ============================================
// 跨域通信的两条浏览器约束（对照 OpenCode Desktop 的做法）
//
//  1. 预检缓存：Chromium 只有在 Access-Control-Allow-Headers 里**逐项列出**
//     请求头名时才复用缓存的预检结果（`*` 不覆盖 authorization 这类
//     “非安全列表”头）。服务端因此必须点名 Authorization / 自定义头。
//
//  2. 保持请求「CORS-simple」：GET/HEAD/POST + 仅安全列表头时才不触发预检。
//     Authorization、X-* 自定义头都会强制预检。桌面端通过「主进程代持凭据、
//     渲染进程不带 Authorization」来省掉预检；浏览器端做不到，但可以避免
//     *额外* 的自定义头，让预检只需要为鉴权付一次（随后被 Max-Age 缓存）。
// ============================================

/** 会触发预检的请求头（安全列表之外）。用于开发期诊断。 */
const CORS_SAFELISTED_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-language',
  'content-type',
  'range',
])

/** Content-Type 中被视为“安全”的三个值；其它值（如 application/json）会触发预检。 */
const CORS_SAFELISTED_CONTENT_TYPES = new Set([
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
])

export interface PreflightDiagnosis {
  /** 是否会触发预检 */
  willPreflight: boolean
  /** 触发预检的请求头（小写） */
  triggeredBy: string[]
}

/**
 * 诊断一组请求头是否会触发 CORS 预检。
 *
 * 用于开发者工具里回答「为什么每个请求前都有一个 OPTIONS」：
 * 把触发原因列出来，而不是靠猜。
 */
export function diagnosePreflight(headers: Record<string, string | undefined>): PreflightDiagnosis {
  const triggeredBy: string[] = []
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase()
    if (value === undefined) continue
    if (name === 'content-type') {
      const mime = value.split(';', 1)[0].trim().toLowerCase()
      if (!CORS_SAFELISTED_CONTENT_TYPES.has(mime)) triggeredBy.push(name)
      continue
    }
    if (!CORS_SAFELISTED_HEADERS.has(name)) triggeredBy.push(name)
  }
  return { willPreflight: triggeredBy.length > 0, triggeredBy }
}

/**
 * 服务端预检缓存是否生效的判定依据。
 *
 * 返回 `true` 表示这个 Max-Age 足够让浏览器缓存预检；`false` 时每个请求前
 * 都会多一次 OPTIONS 往返（经隧道约 1.1s）。
 */
export function isPreflightCacheEffective(maxAgeHeader: string | null | undefined): boolean {
  const value = Number.parseInt(maxAgeHeader ?? '', 10)
  // Chromium 未收到该头时按 5 秒处理，等同于形同虚设
  return Number.isFinite(value) && value >= 60
}
