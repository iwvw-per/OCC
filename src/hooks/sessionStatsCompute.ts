import type { AssistantMessageInfo, Content, Message, TokenUsage } from '../types/message'
import type { SessionStats } from './sessionStatsTypes'
import type { CompactionMarker } from '../api/v2/message'

const COMPACTED_TOOL_PLACEHOLDER = '[Old tool result content cleared]'

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

function charsFromUserContent(content: Content): number {
  if (content.type === 'text') return content.text.length
  return 0
}

function charsFromAssistantContent(content: Content): { assistant: number; tool: number } {
  if (content.type === 'text') return { assistant: content.text.length, tool: 0 }
  if (content.type === 'reasoning') return { assistant: content.text.length, tool: 0 }
  if (content.type !== 'tool') return { assistant: 0, tool: 0 }

  const inputSize = Object.keys(content.state.input ?? {}).length * 16
  if (content.state.status === 'pending') return { assistant: 0, tool: inputSize + (content.state.raw?.length ?? 0) }
  if (content.state.status === 'completed') {
    const outputText = content.state.time?.compacted ? COMPACTED_TOOL_PLACEHOLDER : (content.state.output ?? '')
    return { assistant: 0, tool: inputSize + outputText.length }
  }
  if (content.state.status === 'error') return { assistant: 0, tool: inputSize + (content.state.error?.length ?? 0) }
  return { assistant: 0, tool: inputSize }
}

function estimateCurrentContext(messages: Message[]): number {
  const system = [...messages]
    .reverse()
    .find((msg): msg is Message & { info: { system?: string } } => {
      return msg.info.role === 'user' && typeof (msg.info as { system?: string }).system === 'string'
    })
  const systemChars = system ? (((system.info as { system?: string }).system ?? '').trim().length || 0) : 0

  let userChars = 0
  let assistantChars = 0
  let toolChars = 0

  for (const message of messages) {
    if (message.info.role === 'user') {
      for (const content of message.content) userChars += charsFromUserContent(content)
      for (const attachment of message.info.attachments ?? []) userChars += attachment.displayName?.length ?? 0
      continue
    }

    if (message.info.role !== 'assistant') continue
    for (const content of message.content) {
      const next = charsFromAssistantContent(content)
      assistantChars += next.assistant
      toolChars += next.tool
    }
  }

  return (
    estimateTokens(systemChars) +
    estimateTokens(userChars) +
    estimateTokens(assistantChars) +
    estimateTokens(toolChars)
  )
}

function shouldUseEstimatedContext(
  messages: Message[],
  lastAssistantWithTokensIndex: number,
  lastAssistantWithTokens: AssistantMessageInfo | null,
) {
  if (messages.length === 0) return false
  if (!lastAssistantWithTokens) return true
  if (lastAssistantWithTokens.summary) return true

  for (let i = Math.max(0, lastAssistantWithTokensIndex + 1); i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role === 'assistant' && (msg.info as AssistantMessageInfo).summary) return true
  }

  return false
}

/**
 * 压缩后的权威上下文用量（来自 v2 `session.compaction.ended` 的 tokens）。
 *
 * 为什么需要它：压缩把旧轮次换成摘要后，历史消息已不代表「当前上下文」——
 * 旧代码只能把整段可见消息按字符数估算，得到近似值，而且压缩事件里的真实
 * 用量被丢弃。结果就是用户压缩完看到圆环几乎没动。
 *
 * 只在该用量「不早于」最近一次带 tokens 的 assistant 消息时才采用：之后若又
 * 跑了新的轮次，消息里的真实用量更新，压缩快照就应当让位。
 */
export interface CompactionUsageHint {
  tokens: TokenUsage
  at: number
}

function tokenUsageTotal(tokens: TokenUsage | undefined): number {
  if (!tokens) return 0
  return (
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    (tokens.reasoning ?? 0) +
    (tokens.cache?.read || 0) +
    (tokens.cache?.write || 0)
  )
}

function contextFromCompaction(
  compaction: CompactionUsageHint | undefined,
  lastAssistantWithTokens: AssistantMessageInfo | null,
): number | null {
  if (!compaction) return null
  const snapshotAt = compaction.at
  if (!Number.isFinite(snapshotAt)) return null
  const lastCreated = lastAssistantWithTokens?.time?.created
  // 压缩之后又产生了带 tokens 的消息：上下文已被新一轮刷新，快照过期。
  if (typeof lastCreated === 'number' && lastCreated > snapshotAt) return null
  const total = tokenUsageTotal(compaction.tokens)
  return total > 0 ? total : null
}

/**
 * 从「压缩标记」推算压缩后的上下文用量。
 *
 * 压缩记录来自 `message.list` 的 `type: "compaction"` 条目（事件可能不发，见
 * api/v2/message.ts）。那条的 `tokens` 是**压缩前**用量，不能用；压缩后的上下文
 * 由「摘要 + 保留的近期消息」构成，这里按字符数估算（与 estimateCurrentContext
 * 同一换算口径）。
 *
 * 只在「压缩后还没有新的带 tokens 消息」时使用；一旦新一轮跑过，真实用量
 * 来自那条消息，估算必须让位。
 */
function contextFromCompactionMarker(
  marker: CompactionMarker | undefined,
  lastAssistantWithTokens: AssistantMessageInfo | null,
): number | null {
  if (!marker) return null
  if (!Number.isFinite(marker.at)) return null
  const lastCreated = lastAssistantWithTokens?.time?.created
  if (typeof lastCreated === 'number' && lastCreated > marker.at) return null
  const chars = marker.summaryChars + marker.recentChars
  if (chars <= 0) return null
  return estimateTokens(chars)
}

export function computeSessionStats(
  messages: Message[],
  contextLimit: number = 200000,
  compactionUsage?: CompactionUsageHint,
  sessionUsage?: { tokens: TokenUsage; cost: number },
  compactionMarker?: CompactionMarker,
): SessionStats {
  // v2 的 assistant 消息在流式/出错时 tokens 可能缺省（undefined）；防御性读取，
  // 否则 tokenTotal → tokens.input 抛出 "Cannot read properties of undefined"。
  const tokenTotal = tokenUsageTotal

  let inputTokens = 0
  let outputTokens = 0
  let reasoningTokens = 0
  let cacheRead = 0
  let cacheWrite = 0
  let totalCost = 0
  let lastAssistantWithTokens: AssistantMessageInfo | null = null
  let lastAssistantWithTokensIndex = -1

  for (const msg of messages) {
    if (msg.info.role === 'assistant') {
      const info = msg.info as AssistantMessageInfo
      const hasTokens = tokenTotal(info.tokens) > 0

      if (hasTokens) {
        const tokens = info.tokens
        inputTokens += tokens.input ?? 0
        outputTokens += tokens.output ?? 0
        reasoningTokens += tokens.reasoning ?? 0
        cacheRead += tokens.cache?.read || 0
        cacheWrite += tokens.cache?.write || 0
      }
      if (info.cost) {
        totalCost += info.cost
      }
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info.role !== 'assistant') continue
    const info = msg.info as AssistantMessageInfo
    if (tokenTotal(info.tokens) <= 0) continue
    lastAssistantWithTokens = info
    lastAssistantWithTokensIndex = i
    break
  }

  // 会话累计值优先用服务端口径：压缩会裁掉旧轮次，按可见消息累加会偏小。
  const usage = sessionUsage
  if (usage) {
    const t = usage.tokens
    inputTokens = t.input ?? 0
    outputTokens = t.output ?? 0
    reasoningTokens = t.reasoning ?? 0
    cacheRead = t.cache?.read || 0
    cacheWrite = t.cache?.write || 0
    totalCost = usage.cost || 0
  }

  const totalTokens = inputTokens + outputTokens + reasoningTokens + cacheRead + cacheWrite
  const estimatedContextUsed = estimateCurrentContext(messages)
  // 优先级：服务端实测快照 > 压缩标记推算 > 消息估算。
  // 第二条是让 v2「压缩后真的掉下来」的关键（v2 的压缩事件不一定发，
  // 且其 tokens 是压缩前用量）。
  const measuredCompaction = contextFromCompaction(compactionUsage, lastAssistantWithTokens)
  const markerCompaction =
    measuredCompaction === null
      ? contextFromCompactionMarker(compactionMarker, lastAssistantWithTokens)
      : null
  const compactionContext = measuredCompaction ?? markerCompaction
  const contextEstimated = shouldUseEstimatedContext(
    messages,
    lastAssistantWithTokensIndex,
    lastAssistantWithTokens,
  )
  const contextUsed =
    compactionContext !== null
      ? compactionContext
      : contextEstimated
        ? estimatedContextUsed
        : lastAssistantWithTokens
          ? tokenTotal(lastAssistantWithTokens.tokens)
          : estimatedContextUsed
  const contextPercent = contextLimit > 0 ? Math.min(100, (contextUsed / contextLimit) * 100) : 0

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheRead,
    cacheWrite,
    totalTokens,
    totalCost,
    contextUsed,
    contextLimit,
    contextPercent,
    // 服务端实测快照 → 非估算；marker 推算（字符数换算）仍是估算，如实标注。
    contextEstimated: measuredCompaction !== null ? false : markerCompaction !== null ? true : contextEstimated,
  }
}

export function isSameSessionStats(a: SessionStats, b: SessionStats): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.reasoningTokens === b.reasoningTokens &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite &&
    a.totalTokens === b.totalTokens &&
    a.totalCost === b.totalCost &&
    a.contextUsed === b.contextUsed &&
    a.contextLimit === b.contextLimit &&
    a.contextPercent === b.contextPercent &&
    a.contextEstimated === b.contextEstimated
  )
}

/**
 * 按 messages 数组引用缓存统计结果，合并同一帧内多个消费者的重复遍历
 * （SidebarFooter / ContextDetailsDialog / WorkStatus 各自都算一遍）。
 * WeakMap 按引用持有，数组被替换后旧条目由 GC 回收；contextLimit 不同则重算。
 *
 * 压缩快照与会话累计值同样参与缓存键：压缩刚结束时 messages 引用可能没变
 * （还没重拉），只有快照变了 —— 若只比较数组引用，圆环会停在旧值上，
 * 正是「压缩完上下文占用不更新」的第二个原因。
 */
const sessionStatsMemo = new WeakMap<
  Message[],
  {
    contextLimit: number
    compactionAt?: number
    markerAt?: number
    usageKey?: string
    stats: SessionStats
  }
>()

export function computeSessionStatsCached(
  messages: Message[],
  contextLimit: number = 200000,
  compactionUsage?: CompactionUsageHint,
  sessionUsage?: { tokens: TokenUsage; cost: number },
  compactionMarker?: CompactionMarker,
): SessionStats {
  const usageKey = sessionUsage
    ? `${sessionUsage.tokens.input}:${sessionUsage.tokens.output}:${sessionUsage.tokens.reasoning}:${sessionUsage.tokens.cache?.read ?? 0}:${sessionUsage.tokens.cache?.write ?? 0}:${sessionUsage.cost}`
    : undefined
  const cached = sessionStatsMemo.get(messages)
  if (
    cached &&
    cached.contextLimit === contextLimit &&
    cached.compactionAt === compactionUsage?.at &&
    // 压缩标记的 `at` 单独参与缓存键：v2 的压缩只更新标记（不发事件），
    // 若只比 compactionUsage.at，marker 变化永远不会让缓存失效。
    cached.markerAt === compactionMarker?.at &&
    cached.usageKey === usageKey
  ) {
    return cached.stats
  }
  const stats = computeSessionStats(messages, contextLimit, compactionUsage, sessionUsage, compactionMarker)
  sessionStatsMemo.set(messages, {
    contextLimit,
    compactionAt: compactionUsage?.at,
    markerAt: compactionMarker?.at,
    usageKey,
    stats,
  })
  return stats
}
