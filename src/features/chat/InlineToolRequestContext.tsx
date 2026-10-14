/**
 * InlineToolRequestContext
 *
 * 把待处理的权限请求和提问请求注入到消息流里，
 * 让工具视图可以在对应位置直接渲染内嵌交互。
 * 对于 task 类型的 tool，还支持匹配子 session 内部的请求。
 */

import { createContext, useContext } from 'react'
import type { ApiPermissionRequest, ApiQuestionRequest, PermissionReply, QuestionAnswer } from '../../api'
import { childSessionStore } from '../../store'
import { makeSessionKey, splitSessionKey } from '../../utils/sessionKey'

export interface InlineToolRequestContextValue {
  /** 当前 pending 的权限请求 */
  pendingPermissions: ApiPermissionRequest[]
  /** 当前 pending 的提问请求 */
  pendingQuestions: ApiQuestionRequest[]
  /** 回复权限 */
  onPermissionReply: (requestId: string, reply: PermissionReply) => void
  /** 回复提问 */
  onQuestionReply: (requestId: string, answers: QuestionAnswer[]) => void
  /** 拒绝提问 */
  onQuestionReject: (requestId: string) => void
  /** 是否正在发送回复 */
  isReplying: boolean
}

const defaultValue: InlineToolRequestContextValue = {
  pendingPermissions: [],
  pendingQuestions: [],
  onPermissionReply: () => {},
  onQuestionReply: () => {},
  onQuestionReject: () => {},
  isReplying: false,
}

export const InlineToolRequestContext = createContext<InlineToolRequestContextValue>(defaultValue)

export function useInlineToolRequests() {
  return useContext(InlineToolRequestContext)
}

/**
 * 根据 callID 查找关联的权限请求。
 * 对于 task tool，额外传入 childSessionId，
 * 匹配子 session（及其子孙）内部发出的权限请求。
 */
export function findPermissionRequestForTool(
  pendingPermissions: ApiPermissionRequest[],
  callID: string,
  childSessionId?: string,
): ApiPermissionRequest | undefined {
  // 先按 callID 精确匹配（直接工具调用）
  const direct = pendingPermissions.find(p => p.tool?.callID === callID)
  if (direct) return direct

  // 对 task tool，按子 session 归属匹配
  if (childSessionId) {
    // 消息 metadata 里的 sessionId 是原始 id，pending 请求的 sessionID 可能是复合 key（SSE）
    // 或原始 id（轮询）：统一按原始 id 比较，isChildOf 需要复合 key（childSessionStore 存复合）
    const { serverId: childServerId, sessionId: childRawId } = splitSessionKey(childSessionId)
    const childScoped = childSessionId.includes('::') ? childSessionId : makeSessionKey(childServerId, childRawId)
    const isMatch = (sid: string) => {
      const { sessionId: raw } = splitSessionKey(sid)
      if (raw === childRawId) return true
      const scoped = sid.includes('::') ? sid : makeSessionKey(childServerId, raw)
      return childSessionStore.isChildOf(scoped, childScoped)
    }
    return pendingPermissions.find(p => isMatch(p.sessionID))
  }

  return undefined
}

/**
 * 根据 callID 查找关联的提问请求。
 * 对于 task tool，额外传入 childSessionId。
 */
export function findQuestionRequestForTool(
  pendingQuestions: ApiQuestionRequest[],
  callID: string,
  childSessionId?: string,
): ApiQuestionRequest | undefined {
  const direct = pendingQuestions.find(q => q.tool?.callID === callID)
  if (direct) return direct

  if (childSessionId) {
    const { serverId: childServerId, sessionId: childRawId } = splitSessionKey(childSessionId)
    const childScoped = childSessionId.includes('::') ? childSessionId : makeSessionKey(childServerId, childRawId)
    const isMatch = (sid: string) => {
      const { sessionId: raw } = splitSessionKey(sid)
      if (raw === childRawId) return true
      const scoped = sid.includes('::') ? sid : makeSessionKey(childServerId, raw)
      return childSessionStore.isChildOf(scoped, childScoped)
    }
    return pendingQuestions.find(q => isMatch(q.sessionID))
  }

  return undefined
}

interface ToolPartLike {
  callID: string
  tool: string
  state: { metadata?: unknown }
}

/**
 * 挑出没能匹配到任何已渲染工具部件的提问请求。
 *
 * 内嵌模式下匹配失败（子 session 关系还没注册、工具部件不在当前会话）时，
 * 内嵌卡片不会渲染。这些「落空」的请求需要浮层兜底，否则用户完全看不到提问。
 */
export function findUnmatchedQuestions(
  pendingQuestions: ApiQuestionRequest[],
  messages: { content: { type: string }[] }[],
): ApiQuestionRequest[] {
  if (pendingQuestions.length === 0) return []

  const matched = new Set<string>()
  for (const message of messages) {
    for (const rawPart of message.content) {
      if (rawPart.type !== 'tool') continue
      const part = rawPart as unknown as ToolPartLike
      const childSessionId =
        typeof part.tool === 'string' && part.tool.toLowerCase() === 'task'
          ? ((part.state.metadata as Record<string, unknown> | undefined)?.sessionId as string | undefined)
          : undefined
      const question = findQuestionRequestForTool(pendingQuestions, part.callID, childSessionId)
      if (question) matched.add(question.id)
    }
  }

  return pendingQuestions.filter(q => !matched.has(q.id))
}
