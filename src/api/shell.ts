// ============================================
// Shell API - 命令执行与实时输出
// ============================================
//
// v2 的 bash 工具执行时会启动一个 shell 进程（`sh_xxx`），进程输出由服务端
// 按字节增量缓存。工具调用事件 `session.tool.progress` 会带上这个 `shellID`，
// 于是前端可以在命令还在跑的时候**持续读到新输出**。
//
// 这解决了长命令界面「静止」的问题：此前一个跑 30 秒的命令，界面上只有
// 「已调用」和「已完成」两个状态，中间 30 秒完全没有反馈，用户会以为卡死。
//
// 注意：本文件刻意用裸 fetch 而不是 SDK —— 当前 SDK 版本没有暴露 shell 端点。

import { buildHeaders } from './sdk'
import { serverStore } from '../store/serverStore'

export interface ShellOutputPage {
  output: string
  /** 本次返回内容在绝对字节轴上的结束位置 */
  cursor: number
  /** 服务端已捕获的总字节数；`cursor < size` 表示还有未读内容 */
  size: number
  /** 服务端是否因过长而截断了较早的输出 */
  truncated: boolean
}

/**
 * 读取 shell 的已捕获输出。
 *
 * 传 `cursor` 只取增量（`cursor` 之后的内容），避免长命令反复下载全部输出。
 */
export async function getShellOutput(
  shellId: string,
  options?: { cursor?: number; limit?: number; directory?: string; serverId?: string; signal?: AbortSignal },
): Promise<ShellOutputPage> {
  if (!shellId) throw new Error('shell id is required')

  const serverId = options?.serverId ?? serverStore.getActiveServerId()
  const base = serverStore.getServerBaseUrl(serverId).replace(/\/$/, '')
  const url = new URL(`${base}/api/shell/${encodeURIComponent(shellId)}/output`)
  if (options?.directory) url.searchParams.set('directory', options.directory)
  if (options?.cursor !== undefined) url.searchParams.set('cursor', String(options.cursor))
  if (options?.limit !== undefined) url.searchParams.set('limit', String(options.limit))

  const { getUnifiedFetch } = await import('../store/serverStore')
  const fetchImpl = await getUnifiedFetch()

  const controller = new AbortController()
  const abortFromExternal = () => controller.abort(options?.signal?.reason)
  if (options?.signal?.aborted) abortFromExternal()
  else options?.signal?.addEventListener('abort', abortFromExternal, { once: true })
  // 轮询路径必须有超时：一次挂起的请求会让整条增量链停住。
  const timeoutId = setTimeout(() => controller.abort(new Error('shell output request timed out')), 10_000)

  try {
    const response = await fetchImpl(url.toString(), {
      headers: { ...buildHeaders(serverId), Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`shell output failed: HTTP ${response.status}`)
    const payload: unknown = await response.json()
    const data = (payload as { data?: unknown })?.data ?? payload
    const rec = (data ?? {}) as Record<string, unknown>
    return {
      output: typeof rec.output === 'string' ? rec.output : '',
      cursor: typeof rec.cursor === 'number' ? rec.cursor : 0,
      size: typeof rec.size === 'number' ? rec.size : 0,
      truncated: rec.truncated === true,
    }
  } finally {
    clearTimeout(timeoutId)
    options?.signal?.removeEventListener('abort', abortFromExternal)
  }
}
