// ============================================
// v2 原生 Session 访问层
//
// 直接用 @opencode/client（v2 原生）调用 session 相关接口，
// 适配回前端 ApiSession 形状（复用 v2/adapt 的 adaptSession），
// ============================================

import { getV2Client } from './sdkV2'
import { adaptSession, adaptDataList } from './v2/session'
import { rec } from './v2/adapt'
import type { ApiSession } from './types'

/**
 * 原生列出会话（v2 session.list）。
 * 返回前端 ApiSession[] + 分页游标。
 */
export async function nativeListSessions(
  serverId: string | undefined,
  input: { directory?: string; search?: string; limit?: number; cursor?: string } = {},
): Promise<{ sessions: ApiSession[]; nextCursor?: string; prevCursor?: string }> {
  const client = getV2Client(serverId)
  // 注：v2 session.list 返回的会话含 parentID（子代理会话也在此列出），
  // root 过滤由调用方（getSessions）按 parentID 剔除，见 session.ts。
  const res = await client.session.list({
    directory: input.directory,
    search: input.search,
    limit: input.limit,
    cursor: input.cursor,
    order: 'desc',
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
 * 原生获取运行中会话（v2 session.active → SessionStatusMap）。
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
