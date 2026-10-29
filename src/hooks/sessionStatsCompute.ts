import type { AssistantMessageInfo, Content, Message, TokenUsage, UserMessageInfo } from '../types/message'
import type { SessionStats } from './sessionStatsTypes'
import type { CompactionMarker } from '../api/v2/message'

const COMPACTED_TOOL_PLACEHOLDER = '[Old tool result content cleared]'

/**
 * 字符 → token 的粗略换算。
 *
 * 官方口径大致是「英文约 4 字符 1 token」，但**中文/日文/韩文等 CJK 字符
 * 约 1 字 1 token**，直接 /4 会把中文内容低估 3～4 倍。会话里中文占一成时，
 * 估算就已经明显偏小了，所以这里按字符类别分别折算。
 *
 * 这只是兜底路径（正常情况用服务端实测 tokens），精度要求不高，但
 * 「系统性低估」会让用户在压缩前完全看不出快满了，因此必须按类别折算。
 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

/** 累计器：分别记 CJK 与非 CJK 字符数，避免把大段文本重复拼成字符串再遍历。 */
interface CharTally {
  cjk: number
  rest: number
}

function emptyTally(): CharTally {
  return { cjk: 0, rest: 0 }
}

function addText(tally: CharTally, text: string | undefined): void {
  if (!text) return
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    if (CJK_RE.test(text[i])) cjk++
  }
  tally.cjk += cjk
  tally.rest += text.length - cjk
}

function addChars(tally: CharTally, chars: number): void {
  // 只有长度、没有原文时（如已压缩的工具输出占位符）按纯英文折算。
  if (chars > 0) tally.rest += chars
}

function tallyTokens(tally: CharTally): number {
  return Math.ceil(tally.cjk + tally.rest / 4)
}

export function estimateTokensFromText(text: string): number {
  const tally = emptyTally()
  addText(tally, text)
  return tallyTokens(tally)
}

/**
 * 用户消息的正文。
 *
 * v2 的 user 消息**没有 content[]**，正文在 `info.text`（实测 `{id,time,text,type}`），
 * 只有工具/附件才走 content。此前只遍历 content，导致所有用户输入都被算成
 * 0 字符 —— 长会话里用户粘贴的大段代码/日志完全不计入估算。
 *
 * 两条路径可能同时存在（v1 折叠路径会同时填 text 与 content），因此以
 * `info.text` 为准，content 只补它没覆盖到的部分，避免同一段正文算两遍。
 */
function addUserMessage(tally: CharTally, message: Message & { info: UserMessageInfo }): void {
  const infoText = typeof message.info.text === 'string' ? message.info.text : ''
  addText(tally, infoText || undefined)

  for (const content of message.content ?? []) {
    if (content.type !== 'text') continue
    // text 已计入正文：跳过与之相同的 content 副本
    if (infoText && content.text === infoText) continue
    addText(tally, content.text)
  }
  for (const attachment of message.info.attachments ?? []) {
    addChars(tally, attachment.displayName?.length ?? 0)
  }
}

/**
 * 工具调用输入。
 *
 * 旧实现用「顶层键个数 × 16」，与真实体积完全脱钩：实测 209 次工具调用的
 * 输入 JSON 有 77,417 字符，旧算法只算出 7,232（低估 10.7 倍）。写文件、
 * 打补丁这类调用输入就是整个文件内容，是最容易撑爆上下文的来源，
 * 恰恰被算得最轻。改为按实际序列化长度计。
 */
function toolInputText(input: unknown): string {
  if (input === undefined || input === null) return ''
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input) ?? ''
  } catch {
    // 循环引用等异常：退回键数估算，绝不让估算路径抛错
    return ''
  }
}

function safeText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function addAssistantContent(tally: CharTally, content: Content): void {
  if (content.type === 'text' || content.type === 'reasoning') {
    addText(tally, content.text)
    return
  }
  if (content.type !== 'tool') return

  addText(tally, toolInputText(content.state.input))
  if (content.state.status === 'pending') {
    addText(tally, safeText(content.state.raw))
    return
  }
  if (content.state.status === 'completed') {
    if (content.state.time?.compacted) addChars(tally, COMPACTED_TOOL_PLACEHOLDER.length)
    else addText(tally, safeText(content.state.output))
    return
  }
  // 错误态的 error 不保证是字符串（v2 实测有 undefined）：直接读 .length 会得到
  // undefined，整个估算变成 NaN，圆环与百分比全部失效。
  if (content.state.status === 'error') addText(tally, safeText(content.state.error))
}

function estimateCurrentContext(messages: Message[]): number {
  const system = [...messages]
    .reverse()
    .find((msg): msg is Message & { info: { system?: string } } => {
      return msg.info.role === 'user' && typeof (msg.info as { system?: string }).system === 'string'
    })
  const systemText = system ? (((system.info as { system?: string }).system ?? '').trim() || undefined) : undefined

  const tally = emptyTally()
  addText(tally, systemText)

  for (const message of messages) {
    if (message.info.role === 'user') {
      addUserMessage(tally, message as Message & { info: UserMessageInfo })
      continue
    }
    if (message.info.role !== 'assistant') continue
    for (const content of message.content) addAssistantContent(tally, content)
  }

  // 按字符类别折算，而不是统一 /4：CJK 约 1 字 1 token，统一 /4 会低估数倍。
  return tallyTokens(tally)
}

/**
 * 是否必须改用「按字符估算」。
 *
 * 只有在**实测值已经不代表当前上下文**时才该估算：
 *   1. 一条带 tokens 的 assistant 都没有（新会话）；
 *   2. 最后一条带 tokens 的消息本身是压缩摘要（摘要不是真实 prompt）；
 *   3. 它之后出现了新的压缩摘要（历史已被替换）。
 *
 * 注意**不包含**「它之后还有消息」这种情形：末尾多一条尚未回复的 user 消息
 * 并不会改变已发送的上下文规模，实测值仍然有效。此前一律估算，实测一台机器
 * 上 201k 的会话被显示成 293.8k（高估 46%），用户会误以为快满了。
 */
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
 * 最后一条实测消息之后「新增的用户输入」token 数。
 *
 * 上下文占用 = 上一次请求的 prompt + 之后用户新输入但尚未被处理的部分。
 * 只算 user 正文：assistant 内容必然已包含在那次请求的 tokens 里。
 */
function pendingUserTokens(messages: Message[], afterIndex: number): number {
  const tally = emptyTally()
  for (let i = Math.max(0, afterIndex + 1); i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== 'user') continue
    addUserMessage(tally, msg as Message & { info: UserMessageInfo })
  }
  return tallyTokens(tally)
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
  // 只有长度、没有原文：按纯英文折算（压缩摘要多为中英混排，这里取保守下界，
  // 避免高估后圆环虚满）。真实值由后续轮次的 tokens 覆盖。
  return Math.ceil(chars / 4)
}

export function computeSessionStats(
  messages: Message[],
  /**
   * 该模型的上下文窗口。传 0（或缺省）表示**未知**，此时百分比为 null。
   *
   * 不设「看起来合理」的默认值：实测某模型真实窗口 1000000，而旧默认 200000
   * 会让百分比虚高 5 倍。未知就该显示未知。
   */
  contextLimit: number = 0,
  compactionUsage?: CompactionUsageHint,
  sessionUsage?: { tokens: TokenUsage; cost: number },
  compactionMarker?: CompactionMarker,
  contextUsageSnapshot?: { tokens: TokenUsage; cost: number; at: number },
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
  /**
   * 上下文快照（`session.context`）的可用性。
   *
   * 只在「消息里完全没有实测值」时启用 —— 这正是走网关骨架投影的典型情况：
   * 首屏每轮只留提问 + 最终回复，不带 tokens，于是 lastAssistantWithTokens
   * 为 null、contextEstimated 为 true，圆环退化成按字符估算。
   *
   * 一旦消息里出现实测值（用户发过消息 → 拉到完整消息），就让它让位：
   * 消息级值一定比快照新。
   */
  const snapshotContext =
    contextUsageSnapshot && !lastAssistantWithTokens
      ? (() => {
          const total = tokenUsageTotal(contextUsageSnapshot.tokens)
          return total > 0 ? total : null
        })()
      : null
  // 实测值 + 之后尚未被处理的用户输入：末尾多一条 user 消息时，上下文
  // 只增加了这条输入的长度，不该整轮退回字符估算。
  const measuredContext = lastAssistantWithTokens
    ? tokenTotal(lastAssistantWithTokens.tokens) + pendingUserTokens(messages, lastAssistantWithTokensIndex)
    : null
  const contextUsed =
    compactionContext !== null
      ? compactionContext
      : snapshotContext !== null
        ? snapshotContext
        : contextEstimated
          ? estimatedContextUsed
          : (measuredContext ?? estimatedContextUsed)
  /**
   * 百分比：窗口未知时必须是 null 而不是 0。
   *
   * 0% 会被读成「上下文几乎空着」，与「不知道分母」是两回事；用 200000 之类的
   * 猜测值算出来更糟 —— 真实窗口可能是它的 5 倍。
   */
  const contextPercent = contextLimit > 0 ? Math.min(100, (contextUsed / contextLimit) * 100) : null

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
    contextEstimated:
      measuredCompaction !== null || snapshotContext !== null
        ? false
        : markerCompaction !== null
          ? true
          : contextEstimated,
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
    snapshotKey?: string
    usageKey?: string
    stats: SessionStats
  }
>()

export function computeSessionStatsCached(
  messages: Message[],
  contextLimit: number = 0,
  compactionUsage?: CompactionUsageHint,
  sessionUsage?: { tokens: TokenUsage; cost: number },
  compactionMarker?: CompactionMarker,
  contextUsageSnapshot?: { tokens: TokenUsage; cost: number; at: number },
): SessionStats {
  const usageKey = sessionUsage
    ? `${sessionUsage.tokens.input}:${sessionUsage.tokens.output}:${sessionUsage.tokens.reasoning}:${sessionUsage.tokens.cache?.read ?? 0}:${sessionUsage.tokens.cache?.write ?? 0}:${sessionUsage.cost}`
    : undefined
  const snapshotKey = contextUsageSnapshot
    ? `${contextUsageSnapshot.at}:${contextUsageSnapshot.tokens.input}:${contextUsageSnapshot.tokens.output}:${contextUsageSnapshot.tokens.reasoning}:${contextUsageSnapshot.tokens.cache?.read ?? 0}:${contextUsageSnapshot.tokens.cache?.write ?? 0}`
    : undefined
  const cached = sessionStatsMemo.get(messages)
  if (
    cached &&
    cached.contextLimit === contextLimit &&
    cached.compactionAt === compactionUsage?.at &&
    // 压缩标记的 `at` 单独参与缓存键：v2 的压缩只更新标记（不发事件），
    // 若只比 compactionUsage.at，marker 变化永远不会让缓存失效。
    cached.markerAt === compactionMarker?.at &&
    // 上下文快照在后到达（backfill 是异步的）：不参与缓存键的话，
    // 快照落地后圆环会一直停在字符估算值上。
    cached.snapshotKey === snapshotKey &&
    cached.usageKey === usageKey
  ) {
    return cached.stats
  }
  const stats = computeSessionStats(
    messages,
    contextLimit,
    compactionUsage,
    sessionUsage,
    compactionMarker,
    contextUsageSnapshot,
  )
  sessionStatsMemo.set(messages, {
    contextLimit,
    compactionAt: compactionUsage?.at,
    markerAt: compactionMarker?.at,
    snapshotKey,
    usageKey,
    stats,
  })
  return stats
}
