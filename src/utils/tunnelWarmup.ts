// ============================================
// 主机隧道预热
// ============================================
//
// 背景（来自面板网关 backend-go/internal/server/aiagent_runtime.go 的实现注释）：
//
//   数据通道的 WebSocket 反向握手约 700-900ms，是每次请求的固定开销。
//   打开一个会话会发出 20+ 个短请求，若每个都新建通道，仅握手就累加到
//   十几秒 —— 这正是「点击会话要等十几秒」的主因。
//
// 网关侧已经做了连接池（非流式请求复用长隧道），但池子是「用到才建」：
// 用户点开会话的那一瞬间，池子里一条隧道也没有，于是首屏那几个关键请求
// （session 元数据、message 列表）各自要等一次 700-900ms 的握手。
//
// 这里在应用启动/idle 时**提前并发建好 N 条隧道**，把它们放回池子里。
// 之后用户点会话时，首屏请求直接命中已建好的连接，省掉握手。
//
// 为什么必须并发发 N 个：主机 Agent 对单条隧道是**串行处理**的（不具备流水线），
// 所以网关必须为每个并发请求各开一条隧道。顺序发 1 个只会有 1 条连接被预热。

import { serverStore } from '../store/serverStore'
import { logger } from './logger'
import { isTauri } from './tauri'

/**
 * 预热并发数。
 *
 * 打开一个会话实测会并发发出 15+ 个短请求（session 元数据、message、
 * permission、question、agent、mcp、vcs、skill…）。网关池子按并发峰值
 * （MaxIdleConnsPerHost=128）配置，这里取 8 是折中：
 *   - 足够覆盖首屏最关键的几个请求；
 *   - 不会让「刚打开应用」时的并发连接数过大。
 */
const WARMUP_CONCURRENCY = 8

/** 每个服务器只预热一次（重复预热没有收益，池子已经是热的） */
const warmedServers = new Set<string>()

/**
 * 探测接口：返回极小的 JSON，且不触发任何副作用。
 *
 * 用 /api/info（server.info）：所有 v2 实例都有、不依赖目录、响应体最小。
 * 不用 /api/session（会扫描磁盘项目）也不用 /api/config（响应很大）。
 */
async function warmupRequest(serverId: string): Promise<void> {
  const { getV2Client } = await import('../api/sdkV2')
  const client = getV2Client(serverId)
  await client.server.info()
}

/**
 * 预热指定服务器的隧道池。幂等、失败静默。
 */
export async function warmupServerTunnels(serverId: string): Promise<void> {
  if (!serverId || warmedServers.has(serverId)) return
  warmedServers.add(serverId)

  const started = Date.now()
  const results = await Promise.allSettled(
    Array.from({ length: WARMUP_CONCURRENCY }, () => warmupRequest(serverId)),
  )
  const ok = results.filter(r => r.status === 'fulfilled').length
  if (ok === 0) {
    // 全失败：允许下次重试（比如服务器当时还没起来）
    warmedServers.delete(serverId)
    return
  }
  logger.log(`[warmup] ${serverId}: ${ok}/${WARMUP_CONCURRENCY} tunnels ready in ${Date.now() - started}ms`)
}

/**
 * 预热所有已启用服务器。等到浏览器空闲时再做，不抢首屏资源。
 *
 * 重复调用安全：已预热过的服务器会被跳过。
 */
export function scheduleTunnelWarmup(): void {
  if (typeof window === 'undefined') return
  // 桌面端直连本机/局域网，握手代价远小于网关隧道，预热收益有限但也没坏处；
  // 这里统一执行，逻辑更简单。
  const run = () => {
    const servers = serverStore.getEnabledServers()
    for (const server of servers) {
      void warmupServerTunnels(server.id).catch(() => {})
    }
  }

  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback
  if (typeof idle === 'function') {
    idle(run, { timeout: 3000 })
  } else {
    globalThis.setTimeout(run, 600)
  }
}

/** 测试用：清空已预热记录 */
export function resetTunnelWarmup(): void {
  warmedServers.clear()
}

/** 当前环境是否需要预热（网关隧道的场景） */
export function shouldWarmupTunnels(): boolean {
  // 浏览器端必然经网关；桌面端可能是直连，预热的性价比略低但无害
  return !isTauri() || true
}
