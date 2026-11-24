// ============================================
// updateRoutes — 更新请求的线路改写与回退
// ============================================
//
// 问题：国内直连 github.com / api.github.com / objects.githubusercontent.com
// 常被墙或极慢，表现为「检查更新一直转圈」「安装更新总出错」。用户希望能像
// 别的客户端那样选一个加速代理。
//
// 设计：
//   1. 代理是**前缀式**：`<prefix>https://github.com/owner/repo/...`，
//      与社区通用约定一致（gh-proxy.com / ghfast.top 等）。
//   2. 检查更新：按线路顺序逐个尝试 Release API，**第一个成功的**作为数据源，
//      并把命中的线路记下来，供后续安装/下载复用（避免清单走 A、安装包走 B）。
//   3. 安装更新：按同一顺序给出候选清单 URL，取回清单后把 asset URL 改写到
//      同一条线路，再交给 Rust 下载。
//
// ⚠️ 必须同步改写清单内部的 asset URL：tauri 的 latest.json 里写的是绝对
// github.com 地址，只改清单地址而不同步改 asset 地址，安装包仍然直连 —— 这正是
// 「检查能通过、下载必失败」的典型表现。

import { BUILTIN_UPDATE_PROXIES, updateProxySettingsStore, type UpdateProxySettings } from '../store/updateProxySettings'

/** 需要走代理的 GitHub 域名（release 资产还会 302 到 objects.githubusercontent.com） */
const PROXIED_HOSTS = [
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'release-assets.githubusercontent.com',
]

export interface UpdateRoute {
  /** 线路标识，仅用于日志与 UI 展示 */
  id: string
  /** 代理前缀；null 表示直连 */
  prefix: string | null
}

/** 直连线路 */
export const DIRECT_ROUTE: UpdateRoute = { id: 'direct', prefix: null }

function normalizePrefix(prefix: string): string | null {
  const trimmed = prefix.trim()
  if (!trimmed) return null
  // 统一补尾部斜杠，拼接时不用到处判断
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

/**
 * 按设置得到「代理线路」本身（不含直连）。
 *
 * @returns 用户选择的代理；选择 auto / none 时返回 null。
 */
export function getPreferredProxyRoute(settings: UpdateProxySettings): UpdateRoute | null {
  if (settings.proxy === 'none' || settings.proxy === 'auto') return null
  if (settings.proxy === 'custom') {
    const prefix = normalizePrefix(settings.customPrefix)
    return prefix ? { id: 'custom', prefix } : null
  }
  const builtin = BUILTIN_UPDATE_PROXIES.find(item => item.id === settings.proxy)
  return builtin ? { id: builtin.id, prefix: builtin.prefix } : null
}

/**
 * 本次请求应依次尝试的线路。
 *
 * - 'none'：只有直连；
 * - 'auto'：直连 → 内置代理们（直连通常最快，代理仅作兜底）；
 * - 显式代理：该代理 → 直连 → 其它内置代理（用户主动选了代理，说明直连多半不通，
 *   所以代理优先；但仍保留直连兜底，防止代理本身挂掉）。
 */
export function buildRouteChain(settings: UpdateProxySettings): UpdateRoute[] {
  const builtinRoutes: UpdateRoute[] = BUILTIN_UPDATE_PROXIES.map(item => ({ id: item.id, prefix: item.prefix }))

  if (settings.proxy === 'none') return [DIRECT_ROUTE]
  if (settings.proxy === 'auto') return [DIRECT_ROUTE, ...builtinRoutes]

  const preferred = getPreferredProxyRoute(settings)
  const rest = builtinRoutes.filter(route => route.id !== preferred?.id)
  return preferred ? [preferred, DIRECT_ROUTE, ...rest] : [DIRECT_ROUTE, ...builtinRoutes]
}

/** 把 GitHub 地址改写到某条线路上；非 GitHub 地址原样返回。 */
export function applyRoute(url: string, route: UpdateRoute): string {
  if (!route.prefix) return url
  try {
    const parsed = new URL(url)
    if (!PROXIED_HOSTS.includes(parsed.hostname)) return url
  } catch {
    return url
  }
  return `${route.prefix}${url}`
}

/**
 * 改写 tauri updater 清单里的安装包地址。
 *
 * 只动 `platforms[*].url`（tauri 的 latest.json 结构）；其余字段保持原样，签名
 * （`signature`）是对**安装包内容**的签名，与下载地址无关，因此不需要改。
 */
export function rewriteManifestUrls(manifest: Record<string, unknown>, route: UpdateRoute): Record<string, unknown> {
  if (!route.prefix) return manifest
  const platforms = manifest.platforms
  if (!platforms || typeof platforms !== 'object') return manifest

  const rewritten: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(platforms as Record<string, unknown>)) {
    if (value && typeof value === 'object') {
      const entry = value as Record<string, unknown>
      rewritten[key] = typeof entry.url === 'string' ? { ...entry, url: applyRoute(entry.url, route) } : entry
    } else {
      rewritten[key] = value
    }
  }
  return { ...manifest, platforms: rewritten }
}

/** 拿当前设置（每次现读，用户改完立刻生效，无需重启） */
export function getRouteChain(): UpdateRoute[] {
  return buildRouteChain(updateProxySettingsStore.get())
}

/**
 * 依次尝试各条线路取回 tauri 清单，返回第一个成功的清单内容。
 *
 * 返回 null 表示所有线路都失败（调用方保留原有清单，不做改写）。
 */
export async function fetchManifestContent(
  manifestUrl: string,
  routes: UpdateRoute[],
): Promise<Record<string, unknown> | null> {
  const failures: string[] = []
  for (const route of routes) {
    try {
      const response = await fetch(applyRoute(manifestUrl, route))
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload: unknown = await response.json()
      if (payload && typeof payload === 'object') return payload as Record<string, unknown>
      throw new Error('invalid manifest')
    } catch (error) {
      failures.push(`${route.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (import.meta.env.DEV) {
    console.warn('[updateRoutes] all routes failed for manifest:', failures.join(' | '))
  }
  return null
}

/**
 * 按地址反推它属于哪条线路（清单 URL 已带代理前缀时，改写 asset 必须用同一前缀）。
 */
export function routeFor(url: string): UpdateRoute {
  for (const item of BUILTIN_UPDATE_PROXIES) {
    if (url.startsWith(item.prefix)) return { id: item.id, prefix: item.prefix }
  }
  const custom = normalizePrefix(updateProxySettingsStore.get().customPrefix)
  if (custom && url.startsWith(custom)) return { id: 'custom', prefix: custom }
  return DIRECT_ROUTE
}

/** 错误信息里展示的线路名：直连显示 github.com，代理显示其域名 */
export function describeRoute(url: string | null): string {
  if (!url) return 'default'
  return routeFor(url).prefix ? new URL(routeFor(url).prefix!).hostname : 'github.com'
}
