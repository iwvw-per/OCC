// ============================================
// v2 原生 Session 访问层
//
// 直接用 @opencode/client（v2 原生）调用 session 相关接口，
// 适配回前端 ApiSession 形状（复用 v2/adapt 的 adaptSession），
// ============================================

import { getV2Client } from './sdkV2'
import { buildHeaders } from './sdk'
import { serverStore } from '../store/serverStore'
import { adaptSession, adaptDataList } from './v2/session'
import { rec, str } from './v2/adapt'
import type { ApiSession } from './types'

/**
 * 原生列出会话（v2 session.list）。
 * 返回前端 ApiSession[] + 分页游标。
 *
 * `rootsOnly` 传 true 时给服务端下发 `parentID=null`，让它**在分页之前**就只返回
 * root 会话。此前是拉全量再在客户端 `filter(s => !s.parentID)` 剔除子代理会话：
 * 实测同一台机器 75 条里 7 条是子会话，等于白传 7 条会话的全部字段（含 tokens /
 * cost / location），而且**会让分页游标错位** —— 客户端过滤掉的那几条仍然占用了
 * 服务端一页的名额，导致「展开更多」时一页只能多出不到 limit 条真实条目。
 */
export async function nativeListSessions(
  serverId: string | undefined,
  input: {
    directory?: string
    search?: string
    limit?: number
    cursor?: string
    rootsOnly?: boolean
    parentID?: string
  } = {},
): Promise<{ sessions: ApiSession[]; nextCursor?: string; prevCursor?: string }> {
  const client = getV2Client(serverId)
  // parentID: null = 只要 root；指定 parentID = 只要该会话的子会话；都不传 = 全部。
  const parentID = input.parentID ?? (input.rootsOnly ? null : undefined)
  const res = await client.session.list({
    directory: input.directory,
    search: input.search,
    limit: input.limit,
    cursor: input.cursor,
    order: 'desc',
    parentID,
  })
  return {
    sessions: adaptDataList(res).map(adaptSession),
    nextCursor: (res as { cursor?: { next?: string } }).cursor?.next,
    prevCursor: (res as { cursor?: { previous?: string } }).cursor?.previous,
  }
}

/**
 * 原生获取单个会话。
 */
export async function nativeGetSession(serverId: string | undefined, sessionID: string): Promise<ApiSession> {
  const client = getV2Client(serverId)
  const res = await client.session.get({ sessionID })
  return adaptSession(res)
}

/**
 * 原生创建会话。
 */
export async function nativeCreateSession(
  serverId: string | undefined,
  input: { directory?: string; title?: string; parentID?: string },
): Promise<ApiSession> {
  const client = getV2Client(serverId)
  const res = await client.session.create({
    title: input.title,
    parentID: input.parentID,
    location: input.directory ? { directory: input.directory } : undefined,
  })
  return adaptSession(res)
}

/**
 * 原生更新会话（v2 session.update：title / metadata / permissions）。
 *
 * 注意：SDK 的 session.update body 只透传 { title, metadata, permissions }，会丢弃
 * `time`；且后端对 metadata 是整段替换（实测 PATCH {a:1,b:2} 后再 PATCH {a:9}
 * 只剩 {a:9}）。因此归档不能写 time.archived，也不能直接覆盖 metadata——必须读出
 * 现有 metadata 合并后只改 __archived，避免抹掉后端/其它客户端写入的键。
 */
export async function nativeUpdateSession(
  serverId: string | undefined,
  input: { sessionID: string; title?: string; archived?: number },
): Promise<ApiSession> {
  const client = getV2Client(serverId)
  const params: {
    sessionID: string
    title?: string
    metadata?: Record<string, unknown>
  } = { sessionID: input.sessionID }
  if (input.title !== undefined) params.title = input.title
  if (input.archived !== undefined) {
    const current = await client.session.get({ sessionID: input.sessionID })
    const existing = rec(rec(current).metadata)
    params.metadata = { ...existing, __archived: input.archived }
  }
  await client.session.update(params as never)
  return adaptSession(await client.session.get({ sessionID: input.sessionID }))
}

/**
 * 原生删除会话（v2 session.remove）。
 */
export async function nativeRemoveSession(serverId: string | undefined, sessionID: string): Promise<boolean> {
  const client = getV2Client(serverId)
  await client.session.remove({ sessionID })
  return true
}

/**
 * 原生中止会话（v2 session.interrupt）。
 */
export async function nativeInterruptSession(serverId: string | undefined, sessionID: string): Promise<boolean> {
  const client = getV2Client(serverId)
  await client.session.interrupt({ sessionID })
  return true
}

/**
 * 原生把前台阻塞工具转入后台（v2 session.background）。
 *
 * 空闲会话上是 no-op；有前台阻塞工具时它转后台继续观察，会话得以继续。
 */
export async function nativeBackgroundSession(serverId: string | undefined, sessionID: string): Promise<void> {
  const client = getV2Client(serverId)
  await client.session.background({ sessionID })
}

/**
 * 原生回退消息（v2 session.revert.stage）。
 */
export async function nativeRevertMessage(
  serverId: string | undefined,
  input: { sessionID: string; messageID: string },
): Promise<ApiSession> {
  const client = getV2Client(serverId)
  await client.session.revert.stage({ sessionID: input.sessionID, messageID: input.messageID })
  return adaptSession(await client.session.get({ sessionID: input.sessionID }))
}

/**
 * 原生恢复回退（v2 session.revert.clear）。
 */
export async function nativeUnrevertSession(serverId: string | undefined, sessionID: string): Promise<ApiSession> {
  const client = getV2Client(serverId)
  await client.session.revert.clear({ sessionID })
  return adaptSession(await client.session.get({ sessionID }))
}

/**
 * 原生 fork 会话（v2 session.fork）。
 */
export async function nativeForkSession(
  serverId: string | undefined,
  input: { sessionID: string; messageID?: string },
): Promise<ApiSession> {
  const client = getV2Client(serverId)
  const res = await client.session.fork({ sessionID: input.sessionID, before: input.messageID })
  return adaptSession(res)
}

/**
 * 原生压缩会话（v2 session.compact）。
 */
export async function nativeCompactSession(serverId: string | undefined, sessionID: string): Promise<boolean> {
  const client = getV2Client(serverId)
  await client.session.compact({ sessionID })
  return true
}

/**
 * 原生获取子会话（v2 session.list 按 parentID）。
 */
export async function nativeListChildSessions(
  serverId: string | undefined,
  parentID: string,
): Promise<ApiSession[]> {
  const client = getV2Client(serverId)
  const res = await client.session.list({ parentID })
  return adaptDataList(res).map(adaptSession)
}

/**
 * 原生回复表单（v2 session.form.reply）。
 * v2 用 Form 体系取代 question；answer 是 fieldKey → 值 的映射。
 */
export async function nativeReplyForm(
  serverId: string | undefined,
  input: { sessionID: string; formID: string; answer: Record<string, string | number | boolean | string[]> },
): Promise<void> {
  const client = getV2Client(serverId)
  await client.session.form.reply({ sessionID: input.sessionID, formID: input.formID, answer: input.answer })
}

/**
 * 原生取消表单（v2 session.form.cancel）。
 */
export async function nativeCancelForm(
  serverId: string | undefined,
  input: { sessionID: string; formID: string },
): Promise<void> {
  const client = getV2Client(serverId)
  await client.session.form.cancel({ sessionID: input.sessionID, formID: input.formID })
}

/**
 * 原生标记会话已读（v2 session.view）。
 *
 * v2 把「用户看过这一轮」持久化在 `session.time.viewed` 上，语义是「已观察到
 * 哪个 idle 水位」。未读判定因此变成 `viewed < idle`，天然跨端、跨设备一致 ——
 * 此前 OCC 只在本地 notificationStore 维护未读点，换一台设备就完全不同步。
 *
 * `idle` 必须传该会话当前的 `time.idle`（服务端会忽略比现有 viewed 更小的值，
 * 也会忽略没有 idle 的会话），因此调用方应直接传会话对象上的值。
 */
export async function nativeViewSession(
  serverId: string | undefined,
  input: { sessionID: string; idle: number },
): Promise<boolean> {
  const client = getV2Client(serverId)
  await client.session.view({ sessionID: input.sessionID, idle: input.idle })
  return true
}

/**
 * 原生列出会话收件箱（v2 session.inbox.list）。
 *
 * 已入队但**尚未投递**的工作（用户消息 / synthetic / 压缩 / move）。断线重连后
 * 靠它精确恢复队列，而不是依赖可能丢失的 `inbox.enqueued` 事件。
 */
export async function nativeListInbox(serverId: string | undefined, sessionID: string): Promise<unknown[]> {
  const client = getV2Client(serverId)
  const res = await client.session.inbox.list({ sessionID })
  return adaptDataList(res)
}

/**
 * 原生获取会话活跃上下文（v2 session.context）。
 *
 * 返回「最后一次压缩之后」的消息，也就是**真正发给模型的那一段**。用它算上下文
 * 占用比前端把全部已加载消息累加要准得多（压缩后旧消息不计入）。
 */
export async function nativeGetSessionContext(serverId: string | undefined, sessionID: string): Promise<unknown[]> {
  const client = getV2Client(serverId)
  const res = await client.session.context({ sessionID })
  return adaptDataList(res)
}

/**
 * 原生获取会话的某一轮 diff（v2 session.diff，支持 from/to/context）。
 *
 * 相比「拉 50 条消息再从 summary.diffs 里抠」，这个端点由服务端按轮次边界
 * 直接算好，且能指定 `context` 控制 patch 大小。
 */
export async function nativeGetSessionDiff(
  serverId: string | undefined,
  input: { sessionID: string; from?: string; to?: string; context?: number },
): Promise<unknown[]> {
  const client = getV2Client(serverId)
  const res = await client.session.diff({
    sessionID: input.sessionID,
    from: input.from,
    to: input.to,
    context: input.context,
  })
  return adaptDataList(res)
}

/**
 * 原生生成会话标题（v2 session.generate）。
 *
 * 这是**在会话上下文之上**做一次性生成，不写入历史、不产生事件。用它替换
 * 「建临时会话 → 发消息 → 读回复 → 删会话」那套四步流程（后者每生成一个标题
 * 要 4 个往返，还会在事件流里留下痕迹）。
 */
export async function nativeGenerateSessionText(
  serverId: string | undefined,
  input: { sessionID: string; prompt: string },
): Promise<string> {
  const client = getV2Client(serverId)
  const res = await client.session.generate({ sessionID: input.sessionID, prompt: input.prompt })
  return str(rec(res).text) ?? ''
}

/**
 * 原生一次性文本生成（v2 `POST /api/experimental/generate`，无会话上下文）。
 *
 * ⚠️ SDK 2.0.28 的 `client.experimental` 只暴露了 persistentPty，没有这个端点，
 * 因此这里直接走 HTTP。需要「脱离会话」生成时用它（如根据一段文本起标题）。
 * 未指定 model 时服务端会用默认模型；若服务端是受限发行版可能返回 503。
 */
export async function nativeGenerateText(
  serverId: string | undefined,
  input: { prompt: string; model?: { providerID: string; id: string } },
): Promise<string> {
  const base = (serverId ? serverStore.getServerBaseUrl(serverId) : serverStore.getActiveBaseUrl()).replace(/\/$/, '')
  const { getUnifiedFetch } = await import('../store/serverStore')
  const fetchImpl = await getUnifiedFetch()
  const response = await fetchImpl(`${base}/api/experimental/generate`, {
    method: 'POST',
    headers: { ...buildHeaders(serverId), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ prompt: input.prompt, model: input.model }),
  })
  if (!response.ok) throw new Error(`generate failed: HTTP ${response.status}`)
  const payload: unknown = await response.json()
  return str(rec(rec(payload).data).text) ?? ''
}

/**
 * 原生获取会话运行中状态（v2 session.active → SessionStatusMap）。
 */
export async function nativeActiveSessions(serverId: string | undefined): Promise<Record<string, { type: 'busy' }>> {
  const client = getV2Client(serverId)
  const res = await client.session.active()
  const map: Record<string, { type: 'busy' }> = {}
  for (const [id, val] of Object.entries(res)) {
    if ((val as { type?: string }).type === 'running') map[id] = { type: 'busy' }
  }
  return map
}
