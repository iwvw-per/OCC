// ============================================
// v2 事件 → v1 GlobalEvent 适配
//
// v2 的 event.subscribe() 产出 V2Event：`{ id, created, type, data, location }`，
// 事件名与 v1 完全不同（如 session.text.delta / session.tool.success）。
// 上层（events.ts 的分发与 store）按 v1 的 GlobalEvent 形状消费：
//   `{ directory, payload: { type, properties } }`。
//
// 本模块把 v2 事件映射回 v1 事件类型与载荷。无法对应的 v2 事件返回 null（丢弃）。
// 只做纯映射，不发请求。
// ============================================

import type { GlobalEvent } from '../types'
import type { ApiSession } from '../../types'
import { EventTypes } from '../../types/api/event'
import { rec, str, num, toolResultMetadata } from './adapt'
import { adaptSession } from './session'
import { adaptFormToQuestionRequest } from './form'
import { adaptPermission } from './entities'

function globalEvent(directory: string, type: string, properties: Record<string, unknown>): GlobalEvent {
  return { directory, payload: { type, properties } } as unknown as GlobalEvent
}

/**
 * 把 v2 的 `session.created / moved / metadata.updated` 事件 payload 适配成
 * 前端 `ApiSession` 形状。
 *
 * v2 事件里会话 id 在 `data.sessionID`（不是 `data.id`）、目录在
 * `data.location.directory`（不是顶层 `directory`），时间在事件级 `created`
 * （session.created 的 data 里没有 `time`）。若原样透传：
 *   - applySessionChanged 按 `session.directory` 路由目录桶时拿到 ''，
 *     新会话在所有「按目录分桶」的侧栏桶里被 continue 丢弃 —— 新建对话后
 *     侧栏不出现，必须整页刷新才能看到；
 *   - scope()/makeSessionKey 拿 undefined id 生成损坏复合 key。
 *
 * metadata.updated 只带 {sessionID, metadata}，用事件级 location/created 兜底。
 */
function adaptSessionEvent(e: { data?: unknown; location?: unknown; created?: number }): ApiSession {
  const d = rec(e.data)
  const dataTime = rec(d.time)
  const eventLocation = rec(e.location)
  const sessionID = str(d.sessionID) ?? str(d.id) ?? ''
  const created = num(dataTime.created) ?? num(e.created) ?? 0
  const updated = num(dataTime.updated) ?? created
  return adaptSession({
    ...d,
    id: sessionID,
    // data 里无 location（metadata.updated）时退回事件级 location
    location: rec(d.location).directory ? d.location : eventLocation,
    time: { ...dataTime, created, updated },
  })
}

/**
 * 把 v2 的 `SessionStructuredError`（`{ type, message, status?, response? }`）映射为
 * 前端 `MessageError['name']`。
 *
 * v2 用 `type`（如 `provider.quota` / `provider.auth` / `aborted`），v1/前端用 `name`
 * （`APIError` / `ProviderAuthError` / `MessageAbortedError` …）。此前误读 `error.name`
 * 导致语义丢失（额度超限等被显示成通用 UnknownError）。
 */
function mapV2ErrorName(error: Record<string, unknown>): string {
  const type = str(error.type) ?? ''
  const status = num(error.status)
  if (type === 'aborted' || type === 'interrupted') return 'MessageAbortedError'
  if (type === 'provider.auth' || status === 401 || status === 403) return 'ProviderAuthError'
  if (type === 'provider.quota' || type === 'provider.rate_limit' || status === 429) return 'APIError'
  if (type.startsWith('provider.') || type.startsWith('tool.') || status !== undefined) return 'APIError'
  return 'UnknownError'
}

/**
 * 把 v2 结构化错误转成前端 `MessageError`（name + data），供错误视图渲染。
 * data 字段对齐 MessageErrorView：message / statusCode / isRetryable / responseBody。
 */
function toMessageError(error: Record<string, unknown>): { name: string; data: Record<string, unknown> } {
  const name = mapV2ErrorName(error)
  const response = rec(error.response)
  return {
    name,
    data: {
      message: str(error.message) ?? str(error.type) ?? 'error',
      statusCode: num(error.status),
      isRetryable: name === 'APIError',
      responseBody: str(response.body),
      providerID: str(error.providerID),
    },
  }
}

/** 从 v2 错误对象抽取可读文本（工具错误等简单展示用）。 */
function errorMessage(error: Record<string, unknown>): string | undefined {
  return str(error.message) ?? str(error.type)
}

/** v2 工具结果 `content: ToolContent[]`（文本块）拼成字符串；兼容 output 字符串。 */
function toolContentToText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts = content
    .map(item => {
      const c = rec(item)
      return str(c.text) ?? str(c.content)
    })
    .filter((t): t is string => typeof t === 'string')
  return texts.length > 0 ? texts.join('\n') : undefined
}

/**
 * 把 v2 提问/表单事件归一成 v1 QuestionRequest 形状。
 * - question.* 自带 questions[]，直接透传；
 * - OMO form.created 是 { id, sessionID, title, fields }，把 fields 转成 questions[]
 *   （沿用 InlineQuestion 的 Q&A 卡片），避免 request.questions 为 undefined 而崩溃。
 */
function normalizeQuestionRequest(request: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(request.questions)) return request
  return adaptFormToQuestionRequest(request)
}

/**
 * 把 v2 的 V2Event 映射为 v1 GlobalEvent。
 * @param raw v2 事件对象
 */
export function v2EventToGlobalEvent(raw: unknown): GlobalEvent | null {
  const e = rec(raw)
  const type = str(e.type)
  if (!type) return null
  const data = rec(e.data)
  const location = rec(e.location)
  const directory = str(location.directory) ?? ''
  const sessionID = str(data.sessionID) ?? str(e.sessionID) ?? ''

  switch (type) {
    case 'server.connected':
      return globalEvent(directory, EventTypes.SERVER_CONNECTED, { timestamp: e.created })

    case 'session.created':
    case 'session.updated':
    case 'session.metadata.updated':
    case 'session.moved': {
      const session = adaptSessionEvent(e)
      return globalEvent(directory, type === 'session.created' ? EventTypes.SESSION_CREATED : EventTypes.SESSION_UPDATED, {
        info: session,
      })
    }
    // v2 的 session.renamed payload 只有 {sessionID, title}（无完整 session）。
    // 若归入 SESSION_UPDATED 会因缺 id/directory 被消费方丢弃，标题永远不更新。
    case 'session.renamed':
      return globalEvent(directory, EventTypes.SESSION_RENAMED, {
        sessionID,
        title: str(data.title) ?? '',
      })
    // v2 重试：后端放弃该 assistant 消息、用新 id 重新生成。前端须移除旧消息，
    // 否则旧消息已产生的部分文本与新消息完整文本同时渲染 → 句子重复。
    case 'session.retry.scheduled': {
      const assistantMessageID = str(data.assistantMessageID) ?? ''
      if (!sessionID || !assistantMessageID) return null
      return globalEvent(directory, EventTypes.SESSION_RETRY_SCHEDULED, {
        sessionID,
        assistantMessageID,
      })
    }
    case 'session.deleted':
      return globalEvent(directory, EventTypes.SESSION_DELETED, { sessionID })
    case 'session.idle':
      return globalEvent(directory, EventTypes.SESSION_IDLE, { sessionID })
    case 'session.status':
      return globalEvent(directory, EventTypes.SESSION_STATUS, { sessionID, status: data.status })
    case 'session.execution.failed': {
      const messageError = toMessageError(rec(data.error))
      return globalEvent(directory, EventTypes.SESSION_ERROR, {
        sessionID,
        name: messageError.name,
        data: messageError.data,
      })
    }
    // v2 完成信号：成功结束只有 execution.succeeded（**不发 session.idle**）；
    // 主动停止发 execution.interrupted（+ step.failed aborted），同样不发 idle。
    // 两者都归一为 IDLE：若不映射，流式消息永不收尾、会话永久停在 Working。
    // 上层 handleSessionIdle 会定稿流式消息、落定悬空 tool、移除 Working 状态。
    case 'session.execution.succeeded':
    case 'session.execution.interrupted':
      return globalEvent(directory, EventTypes.SESSION_IDLE, { sessionID })
    // v2 运行态：execution.started 表示开始，映射为 busy 以便侧栏显示动态图标
    // （v2 不发 session.status，若只靠 /session/active 轮询则侧栏不实时）。
    case 'session.execution.started':
      return globalEvent(directory, EventTypes.SESSION_STATUS, { sessionID, status: { type: 'busy' } })

    // ============================================================
    // v2 消息流事件 → v1 Message 事件
    //
    // v2 没有 message.updated / message.part.updated / message.part.delta，
    // 消息生命周期由细粒度 session.* 事件表达，且字段是 assistantMessageID
    // （不是 messageID）+ ordinal（区分同消息内多段文本/推理）。
    // 这里把它们合成为 v1 形状，使 messageStore 能建立消息骨架并流式渲染。
    //
    // partID 约定：`${assistantMessageID}-${ordinal}`（text/reasoning），
    // tool 用 v2 的 callID。与 v2/message.ts 的 adaptAssistantParts 保持一致，
    // 保证「事件流建立的 part」与「历史快照拉取的 part」用同一 id 匹配。
    // ============================================================

    case 'session.step.started': {
      // 建立 assistant 消息骨架（此时尚无 part，由后续 text.*/tool.* 填充）。
      const messageID = str(data.assistantMessageID) ?? ''
      if (!messageID) return null
      const model = rec(data.model)
      const time = num(data.time) ?? num(e.created) ?? 0
      return globalEvent(directory, EventTypes.MESSAGE_UPDATED, {
        info: {
          id: messageID,
          sessionID,
          role: 'assistant',
          time: { created: time },
          parentID: '',
          modelID: str(model.id) ?? '',
          providerID: str(model.providerID) ?? '',
          mode: '',
          agent: str(data.agent) ?? '',
          path: { cwd: '', root: '' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      })
    }

    case 'session.text.started': {
      const messageID = str(data.assistantMessageID) ?? ''
      const ordinal = num(data.ordinal) ?? 0
      if (!messageID) return null
      return globalEvent(directory, EventTypes.MESSAGE_PART_UPDATED, {
        part: {
          id: `${messageID}-text-${ordinal}`,
          sessionID,
          messageID,
          type: 'text',
          text: '',
          synthetic: false,
        },
      })
    }

    case 'session.text.delta': {
      const messageID = str(data.assistantMessageID) ?? str(data.messageID) ?? ''
      const ordinal = num(data.ordinal) ?? 0
      if (!messageID) return null
      return globalEvent(directory, EventTypes.MESSAGE_PART_DELTA, {
        sessionID,
        messageID,
        partID: `${messageID}-text-${ordinal}`,
        field: 'text',
        delta: str(data.delta) ?? str(data.text) ?? '',
      })
    }

    case 'session.reasoning.started': {
      const messageID = str(data.assistantMessageID) ?? ''
      const ordinal = num(data.ordinal) ?? 0
      if (!messageID) return null
      return globalEvent(directory, EventTypes.MESSAGE_PART_UPDATED, {
        part: {
          id: `${messageID}-reasoning-${ordinal}`,
          sessionID,
          messageID,
          type: 'reasoning',
          text: '',
          time: { start: num(e.created) ?? Date.now() },
        },
      })
    }

    case 'session.reasoning.delta': {
      const messageID = str(data.assistantMessageID) ?? str(data.messageID) ?? ''
      const ordinal = num(data.ordinal) ?? 0
      if (!messageID) return null
      return globalEvent(directory, EventTypes.MESSAGE_PART_DELTA, {
        sessionID,
        messageID,
        partID: `${messageID}-reasoning-${ordinal}`,
        field: 'reasoning',
        delta: str(data.delta) ?? str(data.text) ?? '',
      })
    }

    case 'session.text.ended': {
      const messageID = str(data.assistantMessageID) ?? ''
      const ordinal = num(data.ordinal) ?? 0
      if (!messageID) return null
      return globalEvent(directory, EventTypes.MESSAGE_PART_UPDATED, {
        part: {
          id: `${messageID}-text-${ordinal}`,
          sessionID,
          messageID,
          type: 'text',
          text: str(data.text) ?? '',
          synthetic: false,
          time: { start: 0, end: num(e.created) ?? 0 },
        },
      })
    }

    // step.ended 携带该步的 tokens / cost / finish：map 回消息 info 更新，
    // 让 footer 统计（按 message.info.tokens 汇总）在流式过程中就能反映用量。
    // 只带变更字段 + 身份字段；store 侧按 id 合并 info，不会清空 model/agent。
    case 'session.step.ended': {
      const messageID = str(data.assistantMessageID) ?? ''
      if (!messageID) return null
      const tokens = rec(data.tokens)
      const cache = rec(tokens.cache)
      return globalEvent(directory, EventTypes.MESSAGE_UPDATED, {
        info: {
          id: messageID,
          sessionID,
          role: 'assistant',
          cost: num(data.cost) ?? 0,
          tokens: {
            input: num(tokens.input) ?? 0,
            output: num(tokens.output) ?? 0,
            reasoning: num(tokens.reasoning) ?? 0,
            cache: { read: num(cache.read) ?? 0, write: num(cache.write) ?? 0 },
          },
          finish: str(data.finish),
        },
      })
    }

    // step.failed：把结构化错误挂到该 assistant 消息上（v1 的 message.updated 携带 error）。
    // 用户主动中止（aborted）不挂错误——由 execution.interrupted → IDLE 静默收尾。
    case 'session.step.failed': {
      const messageID = str(data.assistantMessageID) ?? ''
      if (!messageID) return null
      const err = rec(data.error)
      if (str(err.type) === 'aborted') return null
      return globalEvent(directory, EventTypes.MESSAGE_UPDATED, {
        info: {
          id: messageID,
          sessionID,
          role: 'assistant',
          error: toMessageError(err),
        },
      })
    }

    // 工具调用开始（先于 tool.called 到达）：v2 只有这里带工具名（name）。
    // 先建 pending part 落下名字，后续 tool.called 复用同一 callID 补 input/状态。
    case 'session.tool.input.started': {
      const messageID = str(data.assistantMessageID) ?? ''
      const callID = str(data.id) ?? ''
      if (!messageID || !callID) return null
      return globalEvent(directory, EventTypes.MESSAGE_PART_UPDATED, {
        part: {
          id: callID,
          sessionID,
          messageID,
          type: 'tool',
          callID,
          tool: str(data.name) ?? '',
          state: { status: 'pending', input: {}, time: { start: num(e.created) ?? Date.now() } },
        },
      })
    }

    // 工具调用参数就绪（v2 无 name，需保留 input.started 落下的工具名）。
    case 'session.tool.called': {
      const messageID = str(data.assistantMessageID) ?? ''
      const callID = str(data.id) ?? ''
      if (!messageID || !callID) return null
      const input = data.input ?? {}
      return globalEvent(directory, EventTypes.MESSAGE_PART_UPDATED, {
        part: {
          id: callID,
          sessionID,
          messageID,
          type: 'tool',
          callID,
          tool: str(data.name) ?? '',
          state: { status: 'running', input, time: { start: num(e.created) ?? Date.now() } },
        },
      })
    }

    case 'session.tool.success':
      return globalEvent(directory, EventTypes.SESSION_NEXT_TOOL_SUCCESS, {
        sessionID,
        callID: str(data.callID) ?? str(data.id) ?? '',
        // v2 工具结果正文是 content[]（文本块数组），不是 output 字符串。
        output: toolContentToText(data.content),
        // task 工具的子会话 id 在结果 metadata 里（metadata.sessionId），透传供子代理识别。
        metadata: toolResultMetadata(data),
      })
    case 'session.tool.failed':
      return globalEvent(directory, EventTypes.SESSION_NEXT_TOOL_FAILED, {
        sessionID,
        callID: str(data.callID) ?? str(data.id) ?? '',
        // v2 的失败事件用 data.error（{type,message}）；兼容 content[] 文本块形状。
        error: errorMessage(rec(data.error)) ?? str(data.error) ?? toolContentToText(data.content),
        metadata: toolResultMetadata(data),
      })

    case 'permission.asked': {
      // v2 的 properties 本身扁平（id/sessionID/action/resources/source），
      // 用 adaptPermission 归成 v1 形状（action→permission、resources→patterns、
      // source→tool.callID），与轮询路径一致，内嵌权限才能按 callID 匹配对应工具。
      const request = rec(data.request ?? data)
      return globalEvent(directory, EventTypes.PERMISSION_ASKED, adaptPermission(request))
    }
    case 'permission.replied':
      return globalEvent(directory, EventTypes.PERMISSION_REPLIED, {
        sessionID,
        requestID: str(data.requestID) ?? str(data.id) ?? '',
      })

    // v2 标准事件名是 question.*（properties 扁平，含 id/sessionID/questions）；
    // 另有 question.v2.* 变体（questions 结构与 v1 一致）；OMO 另有一套 form.*。
    // 三者都取本体（兼容包在 form 里的变体）。
    case 'question.asked':
    case 'question.v2.asked':
    case 'form.created':
      return globalEvent(directory, EventTypes.QUESTION_ASKED, normalizeQuestionRequest(rec(data.form ?? data)))
    case 'question.replied':
    case 'question.v2.replied':
    case 'form.replied':
      return globalEvent(directory, EventTypes.QUESTION_REPLIED, {
        sessionID,
        requestID: str(data.requestID) ?? str(data.id) ?? '',
      })
    case 'question.rejected':
    case 'question.v2.rejected':
    case 'form.cancelled':
      return globalEvent(directory, EventTypes.QUESTION_REJECTED, {
        sessionID,
        requestID: str(data.requestID) ?? str(data.id) ?? '',
      })

    case 'pty.created':
      return globalEvent(directory, EventTypes.PTY_CREATED, { info: data.pty ?? data })
    case 'pty.updated':
      return globalEvent(directory, EventTypes.PTY_UPDATED, { info: data.pty ?? data })
    case 'pty.exited':
      return globalEvent(directory, EventTypes.PTY_EXITED, { info: data.pty ?? data })
    case 'pty.deleted':
      return globalEvent(directory, EventTypes.PTY_DELETED, { id: str(data.id) ?? '' })

    case 'vcs.branch.updated':
      return globalEvent(directory, EventTypes.VCS_BRANCH_UPDATED, { ...data })
    case 'project.updated':
      return globalEvent(directory, EventTypes.PROJECT_UPDATED, { ...data })
    case 'installation.updated':
      return globalEvent(directory, EventTypes.INSTALLATION_UPDATED, { version: str(data.version) })
    case 'installation.update-available':
      return globalEvent(directory, EventTypes.INSTALLATION_UPDATE_AVAILABLE, { version: str(data.version) })
    case 'lsp.updated':
      return globalEvent(directory, EventTypes.LSP_UPDATED, { ...data })
    case 'mcp.status.changed':
      return globalEvent(directory, EventTypes.MCP_TOOLS_CHANGED, { ...data })
    case 'command.updated':
      return globalEvent(directory, EventTypes.COMMAND_EXECUTED, { ...data })
    case 'filesystem.changed':
      return globalEvent(directory, EventTypes.FILE_EDITED, { ...data })

    case 'session.compaction.started':
      return globalEvent(directory, EventTypes.SESSION_COMPACTED, {
        sessionID,
        status: 'started',
        reason: str(data.reason),
      })
    // v2 压缩成功：携带压缩摘要文本，落定后需要刷新消息列表才能看到压缩分隔与
    // 精简后的历史。失败（如 "Nothing to compact yet"）同样要提示，否则用户点了
    // /compact 后界面毫无反应，误以为功能失效。
    case 'session.compaction.ended':
      return globalEvent(directory, EventTypes.SESSION_COMPACTED, {
        sessionID,
        status: 'completed',
        reason: str(data.reason),
      })
    case 'session.compaction.failed':
      return globalEvent(directory, EventTypes.SESSION_COMPACTED, {
        sessionID,
        status: 'failed',
        reason: str(data.reason),
        error: str(rec(data.error).message) ?? str(data.error) ?? '',
      })

    default:
      // 未映射的 v2 事件（step/text.started/ended、usage、inbox、retry 等）
      // 由「每次连接成功的整体刷新 + 消息 part.updated 兜底」覆盖，这里丢弃。
      void num(e.created)
      return null
  }
}
