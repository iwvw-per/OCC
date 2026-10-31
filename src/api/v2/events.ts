// ============================================
// v2 原生事件 → 内部 GlobalEvent 适配
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
import type { CompactionTokenUsage } from '../../types/api/event'
import { EventTypes } from '../../types/api/event'
import { rec, str, num, toolResultMetadata } from './adapt'
import { adaptSession } from './session'
import { adaptFormToQuestionRequest } from './form'
import { adaptPermission } from './entities'

function globalEvent(directory: string, type: string, properties: Record<string, unknown>): GlobalEvent {
  return { directory, payload: { type, properties } } as unknown as GlobalEvent
}

/** 归一 tokens 形状；全零/缺失时返回 null（调用方不应把 0 当成「有测量」）。 */
function adaptTokenUsage(raw: unknown): CompactionTokenUsage | null {
  if (raw == null || typeof raw !== 'object') return null
  const t = rec(raw)
  const cache = rec(t.cache)
  const usage: CompactionTokenUsage = {
    input: num(t.input) ?? 0,
    output: num(t.output) ?? 0,
    reasoning: num(t.reasoning) ?? 0,
    cache: { read: num(cache.read) ?? 0, write: num(cache.write) ?? 0 },
  }
  const total = usage.input + usage.output + usage.reasoning + usage.cache.read + usage.cache.write
  return total > 0 ? usage : null
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
  const eventCreated = num(e.created)

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
      const attempt = num(data.attempt)
      const at = num(data.at)
      return globalEvent(directory, EventTypes.SESSION_RETRY_SCHEDULED, {
        sessionID,
        assistantMessageID,
        ...(attempt != null ? { attempt } : {}),
        ...(at != null ? { at } : {}),
        // 失败原因：上游限流 / 超时会走到重试，界面上要说明「为什么卡住了」。
        ...(data.error != null ? { error: toMessageError(rec(data.error)).data } : {}),
      })
    }
    case 'session.deleted':
      return globalEvent(directory, EventTypes.SESSION_DELETED, { sessionID })
    /**
     * 系统合成消息：后台任务完成通知走这里。
     *
     * 正文是 `<shell id=... state=completed command=...>output</shell>` 或
     * `<subagent sessionID=... state=...>`。它**不进对话流**，只作为「后台任务
     * 已结束」的权威信号被工作状态面板消费（见 workStatus/backgroundJobs.ts）。
     *
     * 不映射它的后果：实时期间后台任务永远停在「运行中」。
     */
    case 'session.synthetic': {
      const text = str(data.text) ?? ''
      if (!sessionID || !text.trim()) return null
      return globalEvent(directory, EventTypes.SESSION_SYNTHETIC, {
        sessionID,
        text,
        ...(str(data.description) ? { description: str(data.description) } : {}),
        createdAt: num(e.created) ?? Date.now(),
      })
    }

    /**
     * 后台 shell 的生命周期。这是「后台任务还在不在跑」的**权威信号**：
     * `shell.created` 带完整 info（含 metadata.sessionID 与命令行），
     * `shell.exited` 带终态与 exit code。
     *
     * 未映射它时，后台任务只能靠消息流的历史推导 —— 那只能证明「曾经启动过」，
     * 于是面板上所有任务都显示成已结束（用户报的正是这个问题）。
     */
    case 'shell.created': {
      const info = rec(data.info)
      const id = str(info.id)
      if (!id) return null
      const metadata = rec(info.metadata)
      const time = rec(info.time)
      return globalEvent(directory, EventTypes.SHELL_CREATED, {
        id,
        status: str(info.status) ?? 'running',
        command: str(info.command) ?? '',
        cwd: str(info.cwd) ?? '',
        ...(str(metadata.sessionID) ? { sessionID: str(metadata.sessionID) } : {}),
        startedAt: num(time.started) ?? eventCreated ?? Date.now(),
      })
    }
    case 'shell.exited': {
      const id = str(data.id)
      if (!id) return null
      return globalEvent(directory, EventTypes.SHELL_EXITED, {
        id,
        status: str(data.status) ?? 'exited',
        ...(num(data.exit) != null ? { exit: num(data.exit) } : {}),
        endedAt: eventCreated ?? Date.now(),
      })
    }

    case 'session.idle':
      return globalEvent(directory, EventTypes.SESSION_IDLE, { sessionID, timestamp: eventCreated })
    case 'session.status':
      return globalEvent(directory, EventTypes.SESSION_STATUS, {
        sessionID,
        status: data.status,
        timestamp: eventCreated,
      })
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
    //
    // interrupted 带 reason（user | shutdown | superseded | inactivity）：
    // 用户主动停止和「服务端重启打断」在界面上是两回事，带上它才能区分。
    case 'session.execution.succeeded': {
      const outcome = str(data.outcome)
      return globalEvent(directory, EventTypes.SESSION_IDLE, {
        sessionID,
        timestamp: eventCreated,
        ...(outcome === 'failed' ? { outcome: 'failed' as const } : {}),
      })
    }
    case 'session.execution.interrupted': {
      const reason = str(data.reason)
      return globalEvent(directory, EventTypes.SESSION_IDLE, {
        sessionID,
        timestamp: eventCreated,
        outcome: 'interrupted' as const,
        ...(reason ? { interruptReason: reason } : {}),
      })
    }
    // v2 运行态：execution.started 表示开始，映射为 busy 以便侧栏显示动态图标
    // （v2 不发 session.status，若只靠 /session/active 轮询则侧栏不实时）。
    case 'session.execution.started':
      return globalEvent(directory, EventTypes.SESSION_STATUS, { sessionID, status: { type: 'busy' } })

    // ============================================================
    // 用户投递队列（v2 的多端输入通道）→ v1 user 消息
    //
    // 实测 v2 的 SSE 流里**没有** message.updated（本机 39,446 条 durable 事件
    // 里只有 message.*，而实时流只发 session.*）。用户消息唯一的实时信号就是
    // `session.inbox.enqueued`：它在 prompt 被受理的瞬间广播，带 inboxID（=
    // 客户端传的 messageID）与 item.payload.text/files/agents。
    //
    // 不映射它的后果是确定性的：A 端发的消息，B 端在它被 agent 读取之前
    // 完全看不到；若 A 端连发两条，B 端只在轮次结束后靠重拉才补齐，中间的
    // 那条就是用户说的「吞消息」。这里把它转成 MESSAGE_UPDATED + PART_UPDATED，
    // 让所有端在同一时刻看到同一条用户消息。
    //
    // 注意：enqueued 只是「进入队列」，还没被 agent 消费；cancelled 表示这条
    // 被撤销（前端要移除占位，否则会显示一条永远不会被处理的用户消息）。
    // ============================================================
    case 'session.inbox.enqueued': {
      const inboxID = str(data.inboxID) ?? ''
      if (!inboxID) return null
      const item = rec(data.item)
      const itemType = str(item.type)
      // 只有用户文本消息对应 UI 里的一条消息；compaction/synthetic/move 等
      // 系统投递项由各自的入口处理，不能在这里伪造用户消息。
      if (itemType !== 'user') return null
      const payload = rec(item.payload)
      const created = eventCreated ?? Date.now()
      // 两条事件：先建消息骨架，再补文本 part。
      // 只发骨架的话，UI 里会出现一条空白用户消息（text 在 part 上，不在 info 上）。
      // 用 TEXT_STARTED 语义等价的形式（MESSAGE_PART_UPDATED + text）让 store
      // 走与历史拉取一致的路径（part id `${id}-text` 与 adaptUserParts 对齐）。
      return globalEvent(directory, EventTypes.SESSION_INBOX_ENQUEUED, {
        sessionID,
        inboxID,
        created,
        text: str(payload.text) ?? '',
      })
    }

    case 'session.inbox.cancelled': {
      const inboxID = str(data.inboxID) ?? ''
      if (!inboxID) return null
      return globalEvent(directory, EventTypes.MESSAGE_REMOVED, { sessionID, messageID: inboxID })
    }

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

    // 流式输出结束：记下 streamed 时刻。官方 TUI 的 tok/s 分母就是
    // `streamed - created`（见 opencode packages/tui/.../rows.ts 的 turnTokensPerSecond），
    // 它精确圈出「模型吐字的窗口」，把 TTFT、工具执行、step 间等待都排除在外。
    // 不映射这个事件 → 前端只能退回整条消息时长，速度被系统性摊薄。
    case 'session.step.streamed': {
      const messageID = str(data.assistantMessageID) ?? ''
      if (!messageID) return null
      const streamed = num(e.created) ?? Date.now()
      return globalEvent(directory, EventTypes.MESSAGE_UPDATED, {
        info: {
          id: messageID,
          sessionID,
          role: 'assistant',
          time: { streamed },
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
        assistantMessageID: messageID,
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

    /**
     * 推理结束：定稿 reasoning part。
     *
     * 缺这条映射会有两个可观测后果：
     *   1. reasoning part 的 `time.end` 永远是 undefined，UI 上推理块一直算
     *      「进行中」，折叠/耗时统计都不准；
     *   2. `handlePartDelta` 依靠 `time.end` 丢弃已定稿 part 的迟到增量。
     *      没有 end，用户按下停止后服务端仍在途的 reasoning.delta 会继续被
     *      追加到推理块里 —— 表现就是「点了停止，内容还在往里流」。
     */
    case 'session.reasoning.ended': {
      const messageID = str(data.assistantMessageID) ?? ''
      const ordinal = num(data.ordinal) ?? 0
      if (!messageID) return null
      return globalEvent(directory, EventTypes.MESSAGE_PART_UPDATED, {
        part: {
          id: `${messageID}-reasoning-${ordinal}`,
          sessionID,
          messageID,
          type: 'reasoning',
          text: str(data.text) ?? '',
          time: { start: 0, end: num(e.created) ?? 0 },
        },
      })
    }

    /**
     * 压缩 part（v2 的实时压缩信号）。
     *
     * `session.compaction.*` 事件在 schema 里存在，但实测**不一定发**；压缩过程
     * 还会走 `message.part.updated` + `part.type === "compaction"`：
     *   - 开始时只有 {id, sessionID, messageID, type, auto}；
     *   - 结束时多出 `tail_start_id`，指向压缩后保留内容的起点（schema 已确认）。
     *
     * 这条路径比只等压缩事件可靠：压缩完成的瞬间就能让前端重拉，
     * 且给出了压缩边界。没有 tail_start_id 时视为仍在进行中，只通知开始。
     */
    case 'message.part.updated': {
      const part = rec(data.part)
      if (str(part.type) !== 'compaction') return null
      const messageID = str(part.messageID) ?? str(data.messageID) ?? ''
      const columnID = str(part.id) ?? ''
      if (!messageID || !columnID) return null
      const tailStartID = str(part.tail_start_id) ?? str(part.tailStartID) ?? ''
      return globalEvent(directory, EventTypes.SESSION_COMPACTED, {
        sessionID,
        status: tailStartID ? 'completed' : 'started',
        reason: part.auto === true ? 'auto' : 'manual',
        // 压缩边界：压缩后保留内容的第一条消息 id（v2 用 id 而非时间戳）
        ...(tailStartID ? { tailStartID } : {}),
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
      const completed = num(e.created) ?? Date.now()
      return globalEvent(directory, EventTypes.MESSAGE_UPDATED, {
        info: {
          id: messageID,
          sessionID,
          role: 'assistant',
          // 步结束时必须落下 completed：渲染层用 messageCompletedAt 判「这条消息
          // 已定稿」，assistantHasLiveWork 也据此判断这一轮是否还在跑。缺它时
          // 消息永远算未完成 —— 对话已结束仍挂「处理中」、过程块不收起、
          // 思考内容继续外露，只有整页刷新才会被快照修正。
          time: { completed },
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

    /**
     * 工具执行中的实时进度。
     *
     * 实测载荷（bash 工具）：
     *   data: { sessionID, assistantMessageID, id: "call_xxx",
     *           metadata: { shellID: "sh_xxx" } }
     *
     * 它是 ephemeral（不落库），只在执行期间间歇发送。不同工具填的 metadata
     * 不一样（bash 给 shellID，别的工具可能给阶段/百分比）。这里统一透传，
     * 让渲染层按 `state.metadata` 自行取用 —— 关键是**状态必须是 running**，
     * 否则会覆盖掉已经 completed 的 part（乱序到达时）。
     *
     * 不映射它的后果：一个跑 30 秒的命令，界面上只有「已调用」和「已完成」
     * 两个状态，中间 30 秒完全静止，用户以为卡死了。
     */
    case 'session.tool.progress': {
      const messageID = str(data.assistantMessageID) ?? ''
      const callID = str(data.id) ?? ''
      if (!messageID || !callID) return null
      const metadata = rec(data.metadata)
      return globalEvent(directory, EventTypes.SESSION_NEXT_TOOL_PROGRESS, {
        sessionID,
        callID,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      })
    }
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
    //
    // ⚠️ 这里**不能**用 data.tokens 当作压缩后的上下文用量：实测 gzip 前后都显示
    // 它是「压缩前」的用量（input 342383 / cache.read 577024），而压缩后实际约
    // 24k。真实构成是 text（摘要）+ recent（保留的近期消息），用它们推算才正确。
    // 旧实现用 tokens，结果圆环在压缩后反而显得更满 —— 用户报的正是这个。
    case 'session.compaction.ended':
      return globalEvent(directory, EventTypes.SESSION_COMPACTED, {
        sessionID,
        status: 'completed',
        reason: str(data.reason),
        ...(adaptTokenUsage(data.tokens) ? { tokens: adaptTokenUsage(data.tokens) } : {}),
        ...(num(data.cost) != null ? { cost: num(data.cost) } : {}),
        summaryChars: (str(data.text) ?? '').length,
        recentChars: (str(data.recent) ?? '').length,
        time: eventCreated ?? Date.now(),
      })
    case 'session.compaction.failed':
      return globalEvent(directory, EventTypes.SESSION_COMPACTED, {
        sessionID,
        status: 'failed',
        reason: str(data.reason),
        error: str(rec(data.error).message) ?? str(data.error) ?? '',
      })
    /**
     * 用量记录（durable）。
     *
     * ⚠️ 与 `session.usage.updated` 语义**不同**，不能直接当成会话累计值：
     * `usage.recorded` 多一个 `source: 'title' | 'compaction'`，表示「这次是
     * 为了某个特定用途（生成标题 / 压缩摘要）花的量」，不是会话累计消耗。
     * 把它写进 `usage` 会让侧栏累计 token/花费被重复计入。
     *
     * 只有 `source === 'compaction'` 对我们有意义：它是压缩那一次请求的真实
     * 用量，补进 `compactionUsage`（压缩后上下文快照的权威来源）。
     * `title` 是内部临时调用（AI 重命名），用户不可见，直接忽略。
     *
     * 实测该事件在当前后端（v2.2.0）的普通对话流里**不出现**，属于低频路径；
     * 接它是为了在真的出现时不被静默丢弃。
     */
    case 'session.usage.recorded': {
      const tokens = adaptTokenUsage(data.tokens)
      if (!tokens) return null
      if (str(data.source) !== 'compaction') return null
      return globalEvent(directory, EventTypes.SESSION_COMPACTION_USAGE, {
        sessionID,
        tokens,
        cost: num(data.cost) ?? 0,
        at: eventCreated ?? Date.now(),
      })
    }
    case 'session.usage.updated': {
      const tokens = adaptTokenUsage(data.tokens)
      if (!tokens) return null
      return globalEvent(directory, EventTypes.SESSION_USAGE_UPDATED, {
        sessionID,
        tokens,
        cost: num(data.cost) ?? 0,
      })
    }

    /**
     * 已读水位（durable）。
     *
     * 语义：`viewed < idle` 即未读。实测该事件**确实会推送**（当 viewed 真的
     * 前进时；传与当前相同的值服务端不产生事件），且服务端只升不降。
     *
     * 不映射它的后果：A 端读了会话，B 端仍显示未读点，直到 B 端自己点开
     * 或走账号通道的 readWatermarks 同步（未登录时根本没有那条通道）。
     */
    case 'session.viewed': {
      const idle = num(data.idle)
      if (!sessionID || idle == null) return null
      return globalEvent(directory, EventTypes.SESSION_VIEWED, { sessionID, idle })
    }

    default:
      // 未映射的 v2 事件（step/text.started/ended、usage、inbox、retry 等）
      // 由「每次连接成功的整体刷新 + 消息 part.updated 兜底」覆盖，这里丢弃。
      void num(e.created)
      return null
  }
}
