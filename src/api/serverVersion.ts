// ============================================
// Server Version Detection
//
// OCC 只支持 opencode 2.x：版本信息在 GET /api/info（2.0.x 的根路径
// /global/health 会被前端 SPA 路由接管返回 HTML）。本模块只做纯探测，
// 不依赖 serverStore，由调用方注入 baseUrl / headers / fetch，避免循环依赖。
// ============================================

export interface ServerVersionInfo {
  /** opencode 版本号（如 2.0.28），探测不到时缺省 */
  version?: string
}

export interface DetectOptions {
  baseUrl: string
  headers?: Record<string, string>
  fetch: typeof globalThis.fetch
  timeoutMs?: number
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function parseVersion(body: string): string | undefined {
  try {
    const data: unknown = JSON.parse(body)
    if (data && typeof data === 'object' && typeof (data as { version?: unknown }).version === 'string') {
      return (data as { version: string }).version
    }
  } catch {
    // 非 JSON：忽略
  }
  return undefined
}

/**
 * 探测某服务器的 opencode 版本（GET /api/info）。
 *
 * 失败时抛出，交由调用方按连接失败处理。
 */
export async function detectServerVersion(options: DetectOptions): Promise<ServerVersionInfo> {
  const base = trimTrailingSlash(options.baseUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000)
  try {
    const response = await options.fetch(`${base}/api/info`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...options.headers },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`无法识别 opencode 服务：HTTP ${response.status}`)
    const text = await response.text().catch(() => '')
    return { version: parseVersion(text) }
  } finally {
    clearTimeout(timer)
  }
}
