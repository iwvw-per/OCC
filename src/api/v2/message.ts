import type { MessageWithParts, Part, TextPart, ReasoningPart, ToolPart } from '../../types'
import { rec, str, num, list } from './adapt'

function adaptToolState(raw: unknown): ToolPart['state'] {
  const state = rec(raw)
  const status = str(state.status)
  const input = rec(state.input)
  const metadata = rec(state.metadata)
  const time = rec(state.time)
  const start = num(time.start) ?? num(time.created) ?? 0
  switch (status) {
    case 'pending':
    case 'streaming':
      return { status: 'pending', input, raw: str(state.input) ?? '' } as ToolPart['state']
    case 'running':
      return { status: 'running', input, metadata, time: { start } } as ToolPart['state']
    case 'error':
      return {
        status: 'error',
        input,
        error: str(rec(state.error).message) ?? str(state.error) ?? 'tool error',
        metadata,
        time: { start, end: num(time.end) ?? start },
      } as ToolPart['state']
    case 'completed':
    default: {
      // v2 用 content: ToolContent[]，v1 用 output: string：拼接文本内容。
      const output = list(state.content)
        .map(item => {
          const c = rec(item)
          return str(c.text) ?? str(c.content) ?? ''
        })
        .join('')
      return {
        status: 'completed',
        input,
        output,
        title: str(state.title) ?? '',
        metadata,
        time: { start, end: num(time.end) ?? start },
      } as ToolPart['state']
    }
  }
}

function adaptAssistantParts(raw: Record<string, unknown>): Part[] {
  const id = String(raw.id ?? '')
  const sessionID = str(raw.sessionID) ?? ''
  const parts: Part[] = []
  let index = 0
  for (const item of list(raw.content)) {
    const c = rec(item)
    const type = str(c.type)
    const partID = `${id}-${index++}`
    if (type === 'text') {
      parts.push({
        id: partID,
        sessionID,
        messageID: id,
        type: 'text',
        text: str(c.text) ?? '',
        synthetic: false,
      } as TextPart)
    } else if (type === 'reasoning') {
      const time = rec(c.time)
      parts.push({
        id: partID,
        sessionID,
        messageID: id,
        type: 'reasoning',
        text: str(c.text) ?? '',
        time: { start: num(time.created) ?? 0, end: num(time.completed) },
      } as ReasoningPart)
    } else if (type === 'tool') {
      const toolID = str(c.id) ?? partID
      parts.push({
        id: toolID,
        sessionID,
        messageID: id,
        type: 'tool',
        callID: toolID,
        tool: str(c.name) ?? '',
        state: adaptToolState(c.state),
      } as ToolPart)
    }
  }
  return parts
}

function adaptUserParts(raw: Record<string, unknown>): Part[] {
  const id = String(raw.id ?? '')
  const sessionID = str(raw.sessionID) ?? ''
  const text = str(raw.text)
  if (text === undefined) return []
  return [
    {
      id: `${id}-text`,
      sessionID,
      messageID: id,
      type: 'text',
      text,
      synthetic: false,
    } as TextPart,
  ]
}

/** v2 单条 SessionMessageInfo → v1 MessageWithParts */
export function adaptMessage(raw: unknown): MessageWithParts {
  const m = rec(raw)
  const id = String(m.id ?? '')
  const sessionID = str(m.sessionID) ?? ''
  const time = rec(m.time)
  const type = str(m.type)
  if (type === 'assistant') {
    const model = rec(m.model)
    return {
      info: {
        id,
        sessionID,
        role: 'assistant',
        time: { created: num(time.created) ?? 0, completed: num(time.completed) },
        parentID: str(m.parentID) ?? '',
        modelID: str(model.id) ?? str(m.modelID) ?? '',
        providerID: str(model.providerID) ?? str(m.providerID) ?? '',
        mode: str(m.mode) ?? '',
        agent: str(m.agent) ?? '',
        path: { cwd: '', root: '' },
        cost: num(m.cost) ?? 0,
        tokens: m.tokens as never,
        finish: str(m.finish),
      } as never,
      parts: adaptAssistantParts(m),
    }
  }
  return {
    info: {
      id,
      sessionID,
      role: 'user',
      time: { created: num(time.created) ?? 0 },
      agent: str(m.agent) ?? '',
      model: { providerID: '', modelID: '' },
    } as never,
    parts: adaptUserParts(m),
  }
}

/** v2 message.list 响应 → 内部 messages + 游标 */
export function adaptMessagePage(raw: unknown): { messages: MessageWithParts[]; nextCursor?: string } {
  const r = rec(raw)
  const cursor = rec(r.cursor)
  return {
    messages: list(r.data).map(adaptMessage),
    nextCursor: str(cursor.next) ?? undefined,
  }
}
