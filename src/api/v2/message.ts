import type { MessageWithParts, Part, TextPart, ReasoningPart, ToolPart, FilePart, AgentPart } from '../../types'
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
  let textOrdinal = 0
  let reasoningOrdinal = 0
  for (const item of list(raw.content)) {
    const c = rec(item)
    const type = str(c.type)
    if (type === 'text') {
      const partID = `${id}-text-${textOrdinal++}`
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
      const partID = `${id}-reasoning-${reasoningOrdinal++}`
      parts.push({
        id: partID,
        sessionID,
        messageID: id,
        type: 'reasoning',
        text: str(c.text) ?? '',
        time: { start: num(time.created) ?? 0, end: num(time.completed) },
      } as ReasoningPart)
    } else if (type === 'tool') {
      const toolID = str(c.id) ?? `${id}-tool-${parts.length}`
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
  const parts: Part[] = []
  const text = str(raw.text)
  if (text !== undefined) {
    parts.push({
      id: `${id}-text`,
      sessionID,
      messageID: id,
      type: 'text',
      text,
      synthetic: false,
    } as TextPart)
  }
  // v2 user message 的 files[]/agents[] → v1 file/agent part。
  // 前端 messageConversion.foldPartsToContent 会把它们折成 info.attachments。
  let ordinal = 0
  for (const rawFile of list(raw.files)) {
    const f = rec(rawFile)
    const mime = str(f.mime) ?? 'text/plain'
    const source = rec(f.source)
    const uri = source.type === 'uri' ? str(source.uri) : ''
    parts.push({
      id: `${id}-file-${ordinal++}`,
      sessionID,
      messageID: id,
      type: 'file',
      mime,
      filename: str(f.name),
      url: uri,
      source: uri
        ? {
            type: 'file',
            path: uri,
            text: { value: '', start: 0, end: 0 },
          }
        : undefined,
    } as unknown as FilePart)
  }
  for (const rawAgent of list(raw.agents)) {
    const a = rec(rawAgent)
    parts.push({
      id: `${id}-agent-${ordinal++}`,
      sessionID,
      messageID: id,
      type: 'agent',
      name: str(a.name) ?? '',
    } as unknown as AgentPart)
  }
  return parts
}

/** v2 单条 SessionMessageInfo → v1 MessageWithParts；非 user/assistant 的消息返回 null */
export function adaptMessage(raw: unknown): MessageWithParts | null {
  const m = rec(raw)
  const id = String(m.id ?? '')
  const sessionID = str(m.sessionID) ?? ''
  const time = rec(m.time)
  const type = str(m.type)
  // 主机 Agent 的轻量投影会在消息上回填 lightweight 统计（见 aiagent_projection）。
  // 透传到内部形状，前端据此把消息标记为压缩态并可展开回拉完整内容。
  const lightweight = adaptLightweight(m.lightweight)
  if (type === 'assistant') {
    const model = rec(m.model)
    // v2 assistant 在流式/出错时可能不带 tokens；归一为完整 TokenUsage 形状，
    // 避免下游（统计/速率/上下文详情）读取 undefined.input 崩溃。
    const tokens = rec(m.tokens)
    const cache = rec(tokens.cache)
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
        tokens: {
          input: num(tokens.input) ?? 0,
          output: num(tokens.output) ?? 0,
          reasoning: num(tokens.reasoning) ?? 0,
          cache: { read: num(cache.read) ?? 0, write: num(cache.write) ?? 0 },
        },
        finish: str(m.finish),
      } as never,
      parts: adaptAssistantParts(m),
      ...(lightweight ? { lightweight } : {}),
    }
  }
  // 只把真正的 user 消息映射为用户消息；idle / model-switched / agent-switched /
  // synthetic / system / skill / shell / compaction 等系统消息一律丢弃，
  // 避免它们污染对话流导致用户/助手位置错乱。
  if (type !== 'user') return null
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
    ...(lightweight ? { lightweight } : {}),
  }
}

/** 归一 lightweight 统计字段；缺失或非法返回 undefined。 */
function adaptLightweight(raw: unknown): { reasoningCount?: number; stepCount?: number } | undefined {
  if (raw == null || typeof raw !== 'object') return undefined
  const lw = rec(raw)
  const reasoningCount = num(lw.reasoningCount)
  const stepCount = num(lw.stepCount)
  if (reasoningCount == null && stepCount == null) return undefined
  return { reasoningCount, stepCount }
}

/** v2 message.list 响应 → 内部 messages + 双向游标 */
export function adaptMessagePage(raw: unknown): {
  messages: MessageWithParts[]
  nextCursor?: string
  prevCursor?: string
  /** 本页内最近一次「已完成」压缩的时间戳；用于在消息流末尾展示压缩分隔条 */
  compactedAt?: number
} {
  const r = rec(raw)
  const cursor = rec(r.cursor)
  const data = list(r.data)
  let compactedAt: number | undefined
  for (const item of data) {
    const m = rec(item)
    if (str(m.type) !== 'compaction' || str(m.status) !== 'completed') continue
    const created = num(rec(m.time).created)
    if (created != null && (compactedAt == null || created > compactedAt)) compactedAt = created
  }
  return {
    messages: data
      .map(adaptMessage)
      .filter((m): m is MessageWithParts => m != null),
    nextCursor: str(cursor.next) ?? undefined,
    prevCursor: str(cursor.previous) ?? undefined,
    compactedAt,
  }
}
