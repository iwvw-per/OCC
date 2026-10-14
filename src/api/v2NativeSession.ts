// ============================================
// v2 原生 Session 访问层
//
// 直接用 @opencode/client（v2 原生）调用 session 相关接口，
// 适配回前端 ApiSession 形状（复用 v2/adapt 的 adaptSession），
// 不经过 clientFacade 的 v1→v2 facade 层。
// ============================================

import { getV2Client } from './sdkV2'
import { adaptSession, adaptDataList } from './v2/session'
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
