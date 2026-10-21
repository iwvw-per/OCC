// ============================================
// 轮次大纲（Turn Outline）
// ============================================
//
// 目标：把「这个会话一共有哪些轮次」与「消息有没有加载进内存」解耦。
//
// 背景：侧边时间轴原先只从**已加载的消息**里提取 user 轮次，历史没拉完时
// 轴上就只有最近几轮，用户必须一路往上滚，轴才慢慢补齐。于是「点轴跳转到
// 更早的轮次」这条路，对未加载的轮次根本不存在 —— 轴上压根没有那个点。
//
// v2 的 `message.list` 支持 `type` 过滤（packages/protocol/src/groups/message.ts
// 的 SessionMessagesQuery）。只取 `type=user` 就能一次拿到**全部轮次**的
// id / 时间 / 文本，无需拉任何 assistant 内容。
//
// ⚠️ 一个必须知道的代价（实测，4810 条消息 / 141 轮的会话）：
//   - 141 个轮次的纯文本只有 **24KB**；
//   - 但同一次请求的响应体是 **16.9MB** —— 因为 v2 的 User 消息把内联附件
//     （截图）以 base64 放在 `files[].data` 里，且**没有参数能省略它**
//     （试过 X-Lightweight / X-Omit-Files / Prefer: return=minimal，均无效）。
//
// 所以这条请求**绝不能放在首屏关键路径上**：它只在后台补全大纲时发一次，
// 结果随即持久化（turnOutlineStore），之后打开同一会话不再请求。
// 这也解释了为什么 limit 取 200：一次拿完（141 轮一页就够），比翻多页更省。

import { buildHeaders } from './sdk'
import { serverStore } from '../store/serverStore'

/** 服务端硬上限 200；轮次通常远少于消息数，一页基本能覆盖整个会话 */
const OUTLINE_PAGE_LIMIT = 200
/** 最多翻几页：防止病态会话（几千轮）把大纲补全拖成长期后台任务 */
const OUTLINE_MAX_PAGES = 5
/** 单请求超时：这是后台任务，卡住就放弃，下次再补 */
const OUTLINE_TIMEOUT_MS = 20_000

export interface OutlineTurn {
  messageId: string
  /** 用户消息文本（用于生成标题）；不含附件 */
  text: string
  createdAt: number
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 拉取会话的**全部**轮次（仅 user 消息，只保留 id/文本/时间）。
 *
 * 返回的 `complete` 表示是否已翻到最早一页：false 时调用方可以稍后再补，
 * 但不要立即重试（每页都是昂贵的）。
 */
export async function fetchSessionTurns(
  sessionId: string,
  options?: { serverId?: string; directory?: string; signal?: AbortSignal; onPage?: (turns: OutlineTurn[]) => void },
): Promise<{ turns: OutlineTurn[]; complete: boolean }> {
  const serverId = options?.serverId ?? serverStore.getActiveServerId()
  const base = serverStore.getServerBaseUrl(serverId).replace(/\/$/, '')
  const { getUnifiedFetch } = await import('../store/serverStore')
  const fetchImpl = await getUnifiedFetch()

  const collected: OutlineTurn[] = []
  let cursor: string | undefined
  let pages = 0
  let complete = false

  while (pages < OUTLINE_MAX_PAGES) {
    const url = new URL(`${base}/api/session/${encodeURIComponent(sessionId)}/message`)
    url.searchParams.set('limit', String(OUTLINE_PAGE_LIMIT))
    url.searchParams.set('type', 'user')
    if (cursor) url.searchParams.set('cursor', cursor)
    else url.searchParams.set('order', 'desc')

    const controller = new AbortController()
    const abortFromExternal = () => controller.abort(options?.signal?.reason)
    if (options?.signal?.aborted) abortFromExternal()
    else options?.signal?.addEventListener('abort', abortFromExternal, { once: true })
    const timeoutId = setTimeout(() => controller.abort(new Error('outline request timed out')), OUTLINE_TIMEOUT_MS)

    try {
      const response = await fetchImpl(url.toString(), {
        headers: { ...buildHeaders(serverId), Accept: 'application/json' },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`outline fetch failed: HTTP ${response.status}`)
      const payload: unknown = await response.json()
      const root = rec(payload)
      const data = Array.isArray(root.data) ? root.data : []

      const pageTurns: OutlineTurn[] = []
      for (const item of data) {
        const m = rec(item)
        if (str(m.type) !== 'user') continue
        const messageId = str(m.id)
        if (!messageId) continue
        pageTurns.push({
          messageId,
          text: str(m.text) ?? '',
          createdAt: num(rec(m.time).created) ?? 0,
        })
      }
      collected.push(...pageTurns)
      options?.onPage?.(pageTurns)
      pages += 1

      const next = str(rec(root.cursor).next)
      if (!next) {
        complete = true
        break
      }
      cursor = next
    } finally {
      clearTimeout(timeoutId)
      options?.signal?.removeEventListener('abort', abortFromExternal)
    }
  }

  return { turns: collected, complete }
}
