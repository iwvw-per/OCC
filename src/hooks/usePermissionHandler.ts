// ============================================
// usePermissionHandler - Permission & Question 处理 (Enhanced)
// ============================================

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  replyPermission,
  replyQuestion,
  rejectQuestion,
  getPendingPermissions,
  getPendingQuestions,
  type ApiPermissionRequest,
  type ApiQuestionRequest,
  type PermissionReply,
  type QuestionAnswer,
} from '../api'
import { activeSessionStore } from '../store'
import { makeSessionKey } from '../utils/sessionKey'
import { permissionErrorHandler } from '../utils'

export interface UsePermissionHandlerResult {
  // State
  pendingPermissionRequests: ApiPermissionRequest[]
  pendingQuestionRequests: ApiQuestionRequest[]
  // Setters (for SSE events)
  setPendingPermissionRequests: React.Dispatch<React.SetStateAction<ApiPermissionRequest[]>>
  setPendingQuestionRequests: React.Dispatch<React.SetStateAction<ApiQuestionRequest[]>>
  // Handlers
  handlePermissionReply: (
    requestId: string,
    reply: PermissionReply,
    directory?: string,
    sessionId?: string,
  ) => Promise<boolean>
  handleQuestionReply: (requestId: string, answers: QuestionAnswer[], directory?: string) => Promise<boolean>
  handleQuestionReject: (requestId: string, directory?: string) => Promise<boolean>
  // Refresh (fallback sync for pending requests) - 支持单个或多个 session IDs
  refreshPendingRequests: (sessionIds?: string | string[], directory?: string) => Promise<void>
  // Reset
  resetPendingRequests: () => void
  // Loading state
  isReplying: boolean
}

const MAX_RETRIES = 3
const RETRY_DELAY = 500

async function isPermissionStillPending(
  requestId: string,
  directory?: string,
  sessionId?: string,
  serverId?: string,
): Promise<boolean | undefined> {
  try {
    const pending = await getPendingPermissions(sessionId, directory, serverId)
    return pending.some(request => request.id === requestId)
  } catch {
    return undefined
  }
}

async function withRetry<T>(fn: () => Promise<T>, retries = MAX_RETRIES, delay = RETRY_DELAY): Promise<T> {
  let lastError: Error | undefined

  for (let i = 0; i < retries; i++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      console.warn(`[Permission] Attempt ${i + 1} failed:`, lastError.message)

      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay * (i + 1)))
      }
    }
  }

  throw lastError
}

export function usePermissionHandler(serverId: string): UsePermissionHandlerResult {
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<ApiPermissionRequest[]>([])
  const [pendingQuestionRequests, setPendingQuestionRequests] = useState<ApiQuestionRequest[]>([])
  const [isReplying, setIsReplying] = useState(false)

  // 防止重复回复
  const replyingIdsRef = useRef<Set<string>>(new Set())

  // 回复回调保持稳定 identity，但服务器切换后必须读到最新的 serverId，
  // 否则回复会发到旧服务器。
  const serverIdRef = useRef(serverId)
  serverIdRef.current = serverId

  // v2 表单回复/取消需要 request 上的 sessionID 与字段（fieldKey/fieldType）。
  // 回调保持稳定 identity，用 ref 镜像当前列表，避免 stale closure。
  const pendingQuestionRequestsRef = useRef<ApiQuestionRequest[]>([])
  useEffect(() => {
    pendingQuestionRequestsRef.current = pendingQuestionRequests
  }, [pendingQuestionRequests])

  /** 从当前 pending 提问里取会话与表单字段（fieldKey 为空则说明不是 v2 表单）。 */
  const questionTarget = useCallback((requestId: string) => {
    const request = pendingQuestionRequestsRef.current.find(r => r.id === requestId)
    const sessionID = request?.sessionID
    const fields = (request?.questions ?? [])
      .map(q => ({
        key: (q as { fieldKey?: string }).fieldKey ?? '',
        type: (q as { fieldType?: string }).fieldType ?? 'string',
      }))
      .filter(f => !!f.key)
    return { sessionID, fields }
  }, [])

  const handlePermissionReply = useCallback(
    async (requestId: string, reply: PermissionReply, directory?: string, sessionId?: string): Promise<boolean> => {
      // 防止重复回复
      if (replyingIdsRef.current.has(requestId)) {
        console.warn(`[Permission] Already replying to ${requestId}`)
        return false
      }

      replyingIdsRef.current.add(requestId)
      setIsReplying(true)

      try {
        await withRetry(() => replyPermission(requestId, reply, undefined, directory, sessionId, serverIdRef.current))
        setPendingPermissionRequests(prev =>
          prev.some(r => r.id === requestId) ? prev.filter(r => r.id !== requestId) : prev,
        )
        activeSessionStore.resolvePendingRequest(requestId)
        return true
      } catch (error) {
        const stillPending = await isPermissionStillPending(requestId, directory, sessionId, serverIdRef.current)
        if (stillPending === false) {
          setPendingPermissionRequests(prev =>
            prev.some(r => r.id === requestId) ? prev.filter(r => r.id !== requestId) : prev,
          )
          activeSessionStore.resolvePendingRequest(requestId)
          return true
        }

        permissionErrorHandler('reply after retries', error)

        return false
      } finally {
        replyingIdsRef.current.delete(requestId)
        setIsReplying(false)
      }
    },
    [],
  )

  const handleQuestionReply = useCallback(
    async (requestId: string, answers: QuestionAnswer[], directory?: string): Promise<boolean> => {
      if (replyingIdsRef.current.has(requestId)) {
        console.warn(`[Question] Already replying to ${requestId}`)
        return false
      }

      replyingIdsRef.current.add(requestId)
      setIsReplying(true)

      try {
        // v2 表单：取 request 的 sessionID + 字段（fieldKey/fieldType）映射回 form answer
        const { sessionID, fields } = questionTarget(requestId)
        await withRetry(() =>
          replyQuestion(requestId, answers, directory, serverIdRef.current, sessionID, fields),
        )
        setPendingQuestionRequests(prev => prev.filter(r => r.id !== requestId))
        activeSessionStore.resolvePendingRequest(requestId)
        return true
      } catch (error) {
        // D24：回复失败时不清本地与 store。此前无条件清除，但服务端请求仍 pending，
        // 用户看到弹窗消失却无法真正回复，且没有重试入口（权限路径有
        // isPermissionStillPending 兜底，问题路径没有）。保留弹窗让用户可重试。
        permissionErrorHandler('question reply after retries', error)
        return false
      } finally {
        replyingIdsRef.current.delete(requestId)
        setIsReplying(false)
      }
    },
    [questionTarget],
  )

  const handleQuestionReject = useCallback(async (requestId: string, directory?: string): Promise<boolean> => {
    if (replyingIdsRef.current.has(requestId)) {
      return false
    }

    replyingIdsRef.current.add(requestId)
    setIsReplying(true)

    try {
      const { sessionID, fields } = questionTarget(requestId)
      await withRetry(() => rejectQuestion(requestId, directory, serverIdRef.current, sessionID, fields))
      setPendingQuestionRequests(prev => prev.filter(r => r.id !== requestId))
      activeSessionStore.resolvePendingRequest(requestId)
      return true
    } catch (error) {
      // D24：拒绝失败同样保留弹窗，让用户可重试（理由同 handleQuestionReply）
      permissionErrorHandler('question reject after retries', error)
      return false
    } finally {
      replyingIdsRef.current.delete(requestId)
      setIsReplying(false)
    }
  }, [questionTarget])

  // 主动轮询获取 pending 请求（用于 SSE 可能丢失事件的情况）
  // 一次拉取全量数据，用 sessionFamily 过滤后直接替换本地状态
  const refreshPendingRequests = useCallback(async (sessionIds?: string | string[], directory?: string) => {
    try {
      // 规范化为 Set 用于过滤（family 是复合 key；API 返回的 sessionID 是原始 id）
      const familySet = new Set(sessionIds ? (Array.isArray(sessionIds) ? sessionIds : [sessionIds]) : [])
      // 原始 id → 复合 key（按当前 pane 的服务器），两种形式都匹配
      const matchesFamily = (rawSessionId: string) => {
        if (familySet.size === 0) return true
        if (familySet.has(rawSessionId)) return true
        return familySet.has(makeSessionKey(serverId, rawSessionId))
      }

      // 只请求一次全量数据（不按 sessionId 分别请求）
      const [allPermissions, allQuestions] = await Promise.all([
        getPendingPermissions(undefined, directory, serverId).catch(() => []),
        getPendingQuestions(undefined, directory, serverId).catch(() => []),
      ])

      const nextPermissions =
        familySet.size > 0
          ? allPermissions.filter(p => matchesFamily(p.sessionID) && !replyingIdsRef.current.has(p.id))
          : allPermissions.filter(p => !replyingIdsRef.current.has(p.id))

      // OMO background subagents can emit permission.asked over SSE before /permission
      // exposes the request for the routed instance. Refresh 时序下子 session 关系可能
      // 尚未注册，因此 SSE 已知请求无条件保留（family 过滤只作用于新拉取的数据）
      setPendingPermissionRequests(prev => {
        const merged = new Map(nextPermissions.map(p => [p.id, p]))
        for (const request of prev) {
          if (replyingIdsRef.current.has(request.id)) continue
          if (!merged.has(request.id)) merged.set(request.id, request)
        }
        return Array.from(merged.values())
      })
      setPendingQuestionRequests(prev => {
        const nextQuestions =
          familySet.size > 0
            ? allQuestions.filter(q => matchesFamily(q.sessionID) && !replyingIdsRef.current.has(q.id))
            : allQuestions.filter(q => !replyingIdsRef.current.has(q.id))
        const merged = new Map(nextQuestions.map(q => [q.id, q]))
        for (const q of prev) {
          if (replyingIdsRef.current.has(q.id)) continue
          if (!merged.has(q.id)) merged.set(q.id, q)
        }
        return Array.from(merged.values())
      })

      // D9：同步对账 activeSessionStore（A 层）。组件 state 只反映 UI 已知的请求，
      // 而 store 的 pendingRequests 若不随刷新清理，服务端已不再返回的请求会长期
      // 残留（Working 列表 pendingAction 常亮、会话无法转 idle）。这里以服务端
      // 本次全量为准，清掉属于该 family、但服务端已不存在的 store pending。
      if (familySet.size > 0) {
        const authoritativeIds = new Set<string>([
          ...allPermissions.map(p => p.id),
          ...allQuestions.map(q => q.id),
        ])
        // store 的 sessionId 是复合 key；把 family 的原始 id 也纳入，兼容两种形式
        const scopedSessionIds = new Set<string>(familySet)
        activeSessionStore.reconcilePendingRequests(scopedSessionIds, authoritativeIds)
      }
    } catch (error) {
      permissionErrorHandler('refresh pending requests', error)
    }
  }, [serverId])

  const resetPendingRequests = useCallback(() => {
    setPendingPermissionRequests([])
    setPendingQuestionRequests([])
    replyingIdsRef.current.clear()
  }, [])

  return {
    pendingPermissionRequests,
    pendingQuestionRequests,
    setPendingPermissionRequests,
    setPendingQuestionRequests,
    handlePermissionReply,
    handleQuestionReply,
    handleQuestionReject,
    refreshPendingRequests,
    resetPendingRequests,
    isReplying,
  }
}
