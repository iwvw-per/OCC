// ============================================
// messagePartMerge — 流式 part 合并的纯函数
// ============================================
//
// 从 messageStore 抽出的无副作用逻辑：流式文本在「本地 live」与「服务端快照」
// 之间如何取舍。这是最容易出 bug 的一段（重复文本、回退、分叉），独立成模块
// 后可以被直接单测，而不必经由整个 store。

import type { Part } from '../types/message'

/** 从复合 key 提取 serverId（`${serverId}::${sessionId}`）；无分隔符时归为空串 */
export function serverIdOfSessionKey(sessionId: string): string {
  const idx = sessionId.indexOf('::')
  return idx === -1 ? '' : sessionId.slice(0, idx)
}

/**
 * 从复合 key 提取原始 sessionId（去掉 serverId 前缀）。
 *
 * 同一后端可能同时以多个 serverId 前缀被连接（如本机 `local` 与隧道
 * `aiagent:inst_xxx` 指向同一 opencode 实例），同一条会话因此会以不同前缀
 * 推事件。原始 sessionId 全局唯一，用它作为「同一会话」的判定依据。
 */
export function rawSessionIdOfKey(sessionId: string): string {
  const idx = sessionId.indexOf('::')
  return idx === -1 ? sessionId : sessionId.slice(idx + 2)
}

/**
 * 同步合并文本：live 更长且与服务端兼容（服务端是前缀）时不回退；
 * 服务端更长则跟上；分叉时以服务端为准。
 */
export function preferCompatibleText(local: string, incoming: string): string {
  if (local === incoming) return incoming
  if (local.startsWith(incoming)) return local
  if (incoming.startsWith(local)) return incoming
  return incoming
}

export function partHasText(part: Part): part is Part & { text: string } {
  return 'text' in part && typeof (part as { text?: unknown }).text === 'string'
}

export function mergePartPreferLiveText(local: Part | undefined, incoming: Part): Part {
  if (!local || local.id !== incoming.id) return incoming
  if (!partHasText(local) || !partHasText(incoming)) return incoming
  const text = preferCompatibleText(local.text, incoming.text)
  if (text === incoming.text) return incoming
  return { ...incoming, text } as Part
}

/**
 * 合并 tool part：v2 的事件是分片到达的——工具名只在 `session.tool.input.started`
 * 里，之后的 `session.tool.called` 不带 name。若直接用 incoming 覆盖，会丢掉名字。
 * 同理，状态从 pending→running 时保留已有 input。
 *
 * 不降级：一旦本地已落定为终态（completed/error），后续迟到的 running/pending 事件
 * 不得把它改回进行中（否则工具卡片会从「已完成」倒退回转圈）。
 */
export function mergeToolPart(local: Part | undefined, incoming: Part): Part {
  if (!local || local.id !== incoming.id) return incoming
  if (local.type !== 'tool' || incoming.type !== 'tool') return incoming
  const localTool = local as Part & { tool?: string; state?: { status?: string; input?: Record<string, unknown> } }
  const incomingTool = incoming as Part & {
    tool?: string
    state?: { status?: string; input?: Record<string, unknown> }
  }
  const localStatus = localTool.state?.status
  const incomingStatus = incomingTool.state?.status
  const settled = localStatus === 'completed' || localStatus === 'error' || localStatus === 'interrupted'
  if (settled && (incomingStatus === 'pending' || incomingStatus === 'running')) {
    // 仅补名字，不改状态/输入
    const tool = incomingTool.tool || localTool.tool || ''
    return tool === localTool.tool ? local : ({ ...local, tool } as Part)
  }
  const tool = incomingTool.tool || localTool.tool || ''
  const localInput = localTool.state?.input
  const incomingInput = incomingTool.state?.input
  const input = incomingInput && Object.keys(incomingInput).length > 0 ? incomingInput : (localInput ?? incomingInput)
  if (tool === incomingTool.tool && input === incomingInput) return incoming
  return {
    ...incoming,
    tool,
    state: { ...(incoming as { state?: object }).state, input },
  } as Part
}

export function mergePartsPreferLiveText(localParts: Part[], incomingParts: Part[]): Part[] {
  if (localParts.length === 0) return incomingParts
  const localById = new Map(localParts.map(part => [part.id, part]))
  return incomingParts.map(part => {
    const local = localById.get(part.id)
    if (part.type === 'tool') return mergeToolPart(local, part)
    return mergePartPreferLiveText(local, part)
  })
}

export interface IncompleteMessageLike {
  isStreaming?: boolean
  info: { time?: { completed?: number } }
}

/**
 * 读取助手消息的完成时间；消息或 time 缺失时返回 undefined。
 *
 * v2 的轻量投影/流式消息可能整条没有 time 字段，直接 `info.time.completed`
 * 会在渲染期抛 TypeError（Cannot read properties of undefined）。
 */
export function messageCompletedAt(
  message: { info?: { time?: { completed?: number } | null } | null } | null | undefined,
): number | undefined {
  return message?.info?.time?.completed
}

export function messageIsIncomplete(message: IncompleteMessageLike): boolean {
  if (message.isStreaming) return true
  return messageCompletedAt(message) == null
}

/**
 * 仅未定稿时保护更长 live；incoming/本地已 completed 则强制服务端，不再 preserve。
 */
export function shouldPreserveLiveParts(previous: IncompleteMessageLike, incoming?: IncompleteMessageLike): boolean {
  if (incoming && !messageIsIncomplete(incoming)) return false
  return messageIsIncomplete(previous)
}

/**
 * 是否为服务端/canonical part 的 id。
 *
 * 乐观本地占位 part 使用冒号分隔的本地形式（如 `${messageId}:text`）；
 * v2 后端 / 适配层的 canonical part id 或以 `prt` 开头，或复用消息 id
 * 派生（如 `${messageId}-text`、`${messageId}-text-0`）。这两者都应被视为
 * 权威 part，用于替换同消息内同类型的本地占位 part，避免正文重复。
 * 因此仅把「含冒号的本地占位 id」判为非服务端，其余一律视为 canonical。
 */
export function isServerPartId(id: string): boolean {
  return !id.includes(':')
}
