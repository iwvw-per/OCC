// ============================================
// Server API Version Detection
//
// opencode 有两代 HTTP API：
//   - v1（1.18.x 及更早）：根路径 API，健康检查 GET /global/health 返回
//     JSON `{healthy, version}`。
//   - v2（2.0.x）：API 挂在 /api/* 前缀下，根路径 GET /global/health 会被
//     前端 SPA 路由接管返回 HTML；版本信息在 GET /api/info。
//
// 客户端需要据此选择 SDK 与请求路径。本模块只做纯探测，不依赖 serverStore，
// 由调用方注入 baseUrl / headers / fetch，避免循环依赖。
// ============================================

export type ApiVersion = 'v1' | 'v2'

export interface ServerVersionInfo {
  apiVersion: ApiVersion
  /** opencode 版本号（如 1.18.34 / 2.0.28），探测不到时缺省 */
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

async function fetchJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  headers: Record<string, string> | undefined,
  timeoutMs: number,
): Promise<{ status: number; contentType: string; text: string } | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal,
    })
    const text = await response.text().catch(() => '')
    return {
      status: response.status,
      contentType: response.headers.get('content-type')?.toLowerCase() ?? '',
      text,
    }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
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
 * 探测某服务器的 opencode API 版本。
 *
 * 顺序：先探 v1 的 /global/health（返回 JSON 即 v1）；否则探 v2 的 /api/info。
 * 两者都失败时抛出，交由调用方按连接失败处理。
 */
export async function detectServerVersion(options: DetectOptions): Promise<ServerVersionInfo> {
  const base = trimTrailingSlash(options.baseUrl)
  const timeoutMs = options.timeoutMs ?? 5000

  const health = await fetchJson(options.fetch, `${base}/global/health`, options.headers, timeoutMs)
  if (health && health.status >= 200 && health.status < 300 && health.contentType.includes('application/json')) {
    return { apiVersion: 'v1', version: parseVersion(health.text) }
  }

  const info = await fetchJson(options.fetch, `${base}/api/info`, options.headers, timeoutMs)
  if (info && info.status >= 200 && info.status < 300 && info.contentType.includes('application/json')) {
    return { apiVersion: 'v2', version: parseVersion(info.text) }
  }

  // v2 的根路径返回 HTML（SPA）：health 拿到 HTML 且 /api/info 不可用，
  // 仍倾向判定为 v2，避免把「v2 但 info 偶发失败」误报成 v1。
  if (health && health.contentType.includes('text/html')) {
    return { apiVersion: 'v2' }
  }

  throw new Error('无法识别 opencode API 版本')
}
