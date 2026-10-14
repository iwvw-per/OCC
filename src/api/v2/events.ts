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
    case 'session.execution.failed':
      return globalEvent(directory, EventTypes.SESSION_ERROR, {
        sessionID,
        name: str(rec(data.error).name) ?? 'error',
        data: data.error,
      })

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

    case 'session.tool.called': {
      // 工具调用开始：建立 tool part（running）。
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
          state: {
            status: 'running',
            input,
            time: { start: num(e.created) ?? 0 },
          },
        },
      })
    }

    case 'session.tool.success':
      return globalEvent(directory, EventTypes.SESSION_NEXT_TOOL_SUCCESS, {
        sessionID,
        callID: str(data.callID) ?? str(data.id) ?? '',
        output: str(data.output),
      })
    case 'session.tool.failed':
      return globalEvent(directory, EventTypes.SESSION_NEXT_TOOL_FAILED, {
        sessionID,
        callID: str(data.callID) ?? str(data.id) ?? '',
        error: str(rec(data.error).message) ?? str(data.error),
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
