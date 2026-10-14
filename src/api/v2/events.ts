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
import { EventTypes } from '../../types/api/event'
import { rec, str, num } from './adapt'

function globalEvent(directory: string, type: string, properties: Record<string, unknown>): GlobalEvent {
  return { directory, payload: { type, properties } } as unknown as GlobalEvent
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
    case 'session.renamed':
    case 'session.metadata.updated':
    case 'session.moved': {
      const session = data.session ?? data
      return globalEvent(directory, type === 'session.created' ? EventTypes.SESSION_CREATED : EventTypes.SESSION_UPDATED, {
        info: session,
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
    // 主动停止：v2 不发 session.idle，只发 execution.interrupted（+ step.failed aborted）。
    // 若不映射，会话会永久停在 Working、消息一直转圈。执行确已停止，归一为 IDLE：
    // 上层 handleSessionIdle 会定稿流式消息、落定悬空 tool、移除 Working 状态。
    case 'session.execution.interrupted':
      return globalEvent(directory, EventTypes.SESSION_IDLE, { sessionID })

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
          time: { start: num(e.created) ?? 0 },
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
          state: { status: 'pending', input: {}, time: { start: num(e.created) ?? 0 } },
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
          state: { status: 'running', input, time: { start: num(e.created) ?? 0 } },
        },
      })
    }

    case 'session.tool.success':
      return globalEvent(directory, EventTypes.SESSION_NEXT_TOOL_SUCCESS, {
        sessionID,
        callID: str(data.callID) ?? str(data.id) ?? '',
        // v2 工具结果正文是 content[]（文本块数组），不是 output 字符串。
        output: toolContentToText(data.content),
      })
    case 'session.tool.failed':
      return globalEvent(directory, EventTypes.SESSION_NEXT_TOOL_FAILED, {
        sessionID,
        callID: str(data.callID) ?? str(data.id) ?? '',
        error: errorMessage(rec(data.error)) ?? str(data.error),
      })

    case 'permission.asked':
      return globalEvent(directory, EventTypes.PERMISSION_ASKED, { request: data.request ?? data })
    case 'permission.replied':
      return globalEvent(directory, EventTypes.PERMISSION_REPLIED, {
        sessionID,
        requestID: str(data.requestID) ?? str(data.id) ?? '',
      })

    case 'form.created':
      return globalEvent(directory, EventTypes.QUESTION_ASKED, { request: data.form ?? data })
    case 'form.replied':
      return globalEvent(directory, EventTypes.QUESTION_REPLIED, { requestID: str(data.id) ?? '', sessionID })
    case 'form.cancelled':
      return globalEvent(directory, EventTypes.QUESTION_REJECTED, { requestID: str(data.id) ?? '', sessionID })

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
    case 'session.compaction.ended':
      return globalEvent(directory, EventTypes.SESSION_COMPACTED, { sessionID })

    default:
      // 未映射的 v2 事件（step/text.started/ended、usage、inbox、retry 等）
      // 由「每次连接成功的整体刷新 + 消息 part.updated 兜底」覆盖，这里丢弃。
      void num(e.created)
      return null
  }
}
