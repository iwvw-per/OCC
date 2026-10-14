// ============================================
// Permission & Question API Functions
// 基于 @opencode-ai/sdk: /permission, /question 相关接口
// ============================================

import { getSDKClient, unwrap } from './sdk'
import { nativeListPermissions } from './v2NativeAgent'
import { resolveSessionTarget } from '../utils/sessionKey'
import { formatPathForApi, directoryCacheKey } from '../utils/directoryUtils'
import { serverStore } from '../store/serverStore'
import { microCache, invalidateMicroCache } from '../utils/microCache'
import type { ApiPermissionRequest, PermissionReply, ApiQuestionRequest, QuestionAnswer } from './types'

/**
 * 待处理列表的缓存有效期。
 *
 * 取 1.5s：只吸收「同一次交互引发的重复拉取」（实测同一会话打开时 permission /
 * question 各被拉 4 次），又不至于让用户看不到刚弹出的审批 —— SSE 推送仍是
 * 实时通道，这里的缓存只影响「主动轮询式」的兜底拉取。
 */
const PENDING_TTL_MS = 1500

/**
 * 全局待处理请求的合并键。
 * 目录用与传输格式无关的目录键，避免 pathMode 切换让同一目录算出两个 key。
 */
function pendingScopeKey(kind: 'permission' | 'question', directory?: string, serverId?: string): string {
  const sid = serverId ?? serverStore.getActiveServerId()
  return `${kind}:${sid}:${directoryCacheKey(directory)}`
}

/** 回复/拒绝后让待处理列表立即失效，避免继续返回已处理的那条 */
function invalidatePending(kind: 'permission' | 'question', directory?: string, serverId?: string): void {
  invalidateMicroCache(pendingScopeKey(kind, directory, serverId))
}

// ============================================
// Permission API
// ============================================

/**
 * 获取待处理的权限请求列表
 *
 * 同一 (server, directory) 的并发调用共享一次网络请求：初始化、目录切换、
 * SSE 重连会各自触发一次全量拉取，不去重就会在同一帧发出多份相同请求。
 */
export async function getPendingPermissions(
  sessionId?: string,
  directory?: string,
  serverId?: string,
): Promise<ApiPermissionRequest[]> {
  // microCache 同时覆盖「并发」与「短时间内先后发生」两类重复：
  // 实测打开一个会话会分几批（挂载 / 目录变化 / SSE 重连）各拉一次，
  // singleFlight 只能合并同一批，跨批次仍会各走一次约 1.1s 的隧道往返。
  const permissions = await microCache(
    pendingScopeKey('permission', directory, serverId),
    async () => {
      const sid = serverId ?? serverStore.getActiveServerId()
      if (serverStore.getApiVersion(sid) === 'v2') {
        return nativeListPermissions(sid)
      }
      const sdk = getSDKClient(serverId)
      return unwrap(await sdk.permission.list({ directory: formatPathForApi(directory, serverId) }))
    },
    { ttlMs: PENDING_TTL_MS },
  )
  if (!sessionId) return permissions
  const target = resolveSessionTarget(sessionId, serverId)
  return permissions.filter((p: ApiPermissionRequest) => p.sessionID === target.sessionId)
}

/**
 * 回复权限请求
 */
export async function replyPermission(
  requestId: string,
  reply: PermissionReply,
  message?: string,
  directory?: string,
  sessionId?: string,
  serverId?: string,
): Promise<boolean> {
  const sdk = getSDKClient(serverId)

  if (sessionId) {
    const target = resolveSessionTarget(sessionId, serverId)
    unwrap(
      await sdk.permission.respond({
        sessionID: target.sessionId,
        permissionID: requestId,
        directory: formatPathForApi(directory, serverId),
        response: reply,
      }),
    )
    invalidatePending('permission', directory, serverId)
    return true
  }

  unwrap(
    await sdk.permission.reply({
      requestID: requestId,
      directory: formatPathForApi(directory, serverId),
      reply,
      message,
    }),
  )
  invalidatePending('permission', directory, serverId)
  return true
}

// ============================================
// Question API
// ============================================

/**
 * 获取待处理的问题请求列表
 *
 * 与 getPendingPermissions 同样做同 key 在途合并。
 */
export async function getPendingQuestions(
  sessionId?: string,
  directory?: string,
  serverId?: string,
): Promise<ApiQuestionRequest[]> {
  const questions = await microCache(
    pendingScopeKey('question', directory, serverId),
    async () => {
      const sdk = getSDKClient(serverId)
      return unwrap(await sdk.question.list({ directory: formatPathForApi(directory, serverId) }))
    },
    { ttlMs: PENDING_TTL_MS },
  )
  if (!sessionId) return questions
  const target = resolveSessionTarget(sessionId, serverId)
  return questions.filter((q: ApiQuestionRequest) => q.sessionID === target.sessionId)
}

/**
 * 回复问题请求
 */
export async function replyQuestion(
  requestId: string,
  answers: QuestionAnswer[],
  directory?: string,
  serverId?: string,
): Promise<boolean> {
  const sdk = getSDKClient(serverId)
  unwrap(
    await sdk.question.reply({
      requestID: requestId,
      directory: formatPathForApi(directory, serverId),
      answers,
    }),
  )
  invalidatePending('question', directory, serverId)
  return true
}

/**
 * 拒绝问题请求
 */
export async function rejectQuestion(requestId: string, directory?: string, serverId?: string): Promise<boolean> {
  const sdk = getSDKClient(serverId)
  unwrap(
    await sdk.question.reject({
      requestID: requestId,
      directory: formatPathForApi(directory, serverId),
    }),
  )
  invalidatePending('question', directory, serverId)
  return true
}
