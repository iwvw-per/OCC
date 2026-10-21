// ============================================
// 分页拉取轮次大纲（session.message?type=user）
// ============================================
//
// 核心矛盾：大纲只需要每个 user 消息的 id / time / text（合计约 24KB），
// 但 v2 会把内联附件（截图）以 base64 塞进 `files[].data` 一并返回 ——
// 实测 150 轮的会话整体响应 **18MB**，其中 13MB 集中在 10 个带截图的轮次。
//
// 已确认**没有任何参数能省略附件**：
//   - X-Lightweight / X-Omit-Files / Prefer: return=minimal 均无效；
//   - `session.export?sanitize=true` 会把正文也脱敏（变成 [redacted:...]），不可用。
//
// 所以这里的策略是「分页渐进 + 每页立即回调」：
//   - 从最新一页开始（order=desc），用户最快看到的是最近轮次；
//   - 单页体积可控（实测首屏 25 轮约 390KB），不必等 18MB；
//   - 页间让出事件循环，切走时立刻 abort；
//   - 调用方每页合并一次，轴逐步变长。

import { buildHeaders } from './sdk'
import { serverStore } from '../store/serverStore'

/**
 * 每页轮次数。
 *
 * 实测（150 轮 / 18MB 的会话）按 25 轮分页：首屏 394KB，后续页从几千字节到
 * 8MB 不等 —— 体积取决于该页是否含截图，无法通过调页大小消除。25 的取舍是
 * 「首屏足够小」+「总往返不至于太多」（150 轮 = 6 页）。
 */
const OUTLINE_PAGE_LIMIT = 25
/** 最多翻几页：防止病态会话（几千轮）把大纲补全拖成长期后台任务 */
const OUTLINE_MAX_PAGES = 12
/** 单请求超时：这是后台任务，卡住就放弃，下次再补 */
const OUTLINE_TIMEOUT_MS = 20_000
/** 页间停顿：让出主线程，也给用户切走/取消的机会 */
const OUTLINE_PAGE_GAP_MS = 60

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

export interface OutlinePageInfo {
  /** 已完成的页数（从 1 开始） */
  page: number
  /** 是否已翻到最早一页 */
  complete: boolean
}

/**
 * 分页拉取会话轮次，**每页到达就回调**。
 *
 * 从最新一页开始（`order=desc`），因此调用方最快拿到的是最近轮次 ——
 * 那正是用户最可能点击的部分。
 *
 * `onPage` 的 turns **已按时间升序**（页内反转），调用方可以直接 prepend。
 * 调用方应做增量合并，不要等整个 promise resolve —— 否则渐进式分页就退化成
 * 一次性等待，失去了「首屏 390KB 就能显示」的意义。
 */
export async function fetchSessionTurns(
  sessionId: string,
  options?: {
    serverId?: string
    directory?: string
    signal?: AbortSignal
    onPage?: (turns: OutlineTurn[], info: OutlinePageInfo) => void
  },
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
    // 页间停顿：让出主线程，并给外部 signal 一个生效机会
    if (pages > 0) {
      const aborted = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(false), OUTLINE_PAGE_GAP_MS)
        options?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve(true)
          },
          { once: true },
        )
      })
      if (aborted) break
    }
    if (options?.signal?.aborted) break

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
      // 服务端按 desc 返回；反转成时间升序，调用方可直接 prepend
      pageTurns.reverse()
      collected.push(...pageTurns)
      pages += 1

      const next = str(rec(root.cursor).next)
      if (!next) {
        complete = true
        options?.onPage?.(pageTurns, { page: pages, complete: true })
        break
      }
      options?.onPage?.(pageTurns, { page: pages, complete: false })
      cursor = next
    } finally {
      clearTimeout(timeoutId)
      options?.signal?.removeEventListener('abort', abortFromExternal)
    }
  }

  return { turns: collected, complete }
}
