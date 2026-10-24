import type { MessageWithParts, Part, TextPart, ReasoningPart, ToolPart, FilePart, AgentPart } from '../../types'
import { rec, str, num, list } from './adapt'
import { mapInSlices } from '../../utils/chunkedWork'

function adaptToolState(raw: unknown): ToolPart['state'] {
  const state = rec(raw)
  const status = str(state.status)
  const input = rec(state.input)
  const metadata = rec(state.metadata)
  const time = rec(state.time)
  const start = num(time.start) ?? num(time.created) ?? 0
  // title 与状态无关：v2 在 running 阶段也会给出标题（如命令摘要），
  // 只有 completed 分支读它会让运行中的工具退化成类型名（全都显示 "Execute"）。
  const title = str(state.title) ?? ''
  switch (status) {
    case 'pending':
    case 'streaming':
      return { status: 'pending', input, raw: str(state.input) ?? '', title } as ToolPart['state']
    case 'running':
      return { status: 'running', input, metadata, title, time: { start } } as ToolPart['state']
    case 'error':
      return {
        status: 'error',
        input,
        error: str(rec(state.error).message) ?? str(state.error) ?? 'tool error',
        metadata,
        title,
        time: { start, end: num(time.end) ?? start },
      } as ToolPart['state']
    case 'completed':
    default: {
      // v2 用 content: ToolContent[]，v1 用 output: string：拼接文本内容。
      //
      // ⚠️ 同时统计**被丢弃的内联文件体积**。
      // content[] 里的 `type: "file"` 块带 `uri`，值是完整的 `data:image/png;base64,...`
      // （实测一张截图 2.3MB）。这部分不能留在内存里，所以只拼文本、把图片丢掉。
      // 但它**仍然留在服务端上下文**，会让「上下文转发给模型」的请求体膨胀 ——
      // 真实故障就是 5 张截图累计 11MB，触发上游网关 16MB 上限，返回 413。
      // 这里只记一个数字（体积），用于发送前预警，不保留任何字节。
      let omittedFileBytes = 0
      const output = list(state.content)
        .map(item => {
          const c = rec(item)
          if (str(c.type) === 'file') {
            const uri = str(c.uri) ?? str(c.url) ?? ''
            if (uri) {
              const comma = uri.indexOf(',')
              omittedFileBytes +=
                comma > 0 && uri.slice(0, comma).includes('base64')
                  ? Math.floor(((uri.length - comma) * 3) / 4)
                  : Math.max(0, uri.length - comma)
            }
            return ''
          }
          return str(c.text) ?? str(c.content) ?? ''
        })
        .join('')
      return {
        status: 'completed',
        input,
        output,
        title,
        metadata,
        time: { start, end: num(time.end) ?? start },
        ...(omittedFileBytes > 0 ? { omittedFileBytes } : {}),
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
    // v2 的 file 有两种来源：
    //   - source.type === 'uri'   ：引用一个地址（file:// / https://）
    //   - source.type === 'inline'：正文以 base64 放在 f.data 里
    //
    // 此前只处理了 uri，inline 的 data 被**直接丢弃** —— 于是用户发的图片既显示
    // 不出来，又白白把 base64 下载了下来。实测一条带截图的会话里，60 条消息中
    // 有 1358KB 是 inline 图片数据（占 92%），首屏 18 秒基本都花在它上面。
    const inlineData = str(f.data)
    const uri = source.type === 'uri' ? (str(source.uri) ?? '') : ''
    const url = uri || (inlineData ? `data:${mime};base64,${inlineData}` : '')
    parts.push({
      id: `${id}-file-${ordinal++}`,
      sessionID,
      messageID: id,
      type: 'file',
      mime,
      filename: str(f.name),
      url,
      source: url
        ? {
            type: 'file',
            path: uri || str(f.name) || '',
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
  /**
   * synthetic：后台任务的完成通知。
   *
   * 它的正文是 `<shell id=... state=... command=...>output</shell>` 或
   * `<subagent sessionID=... state=...>`，是「后台任务跑完了」的唯一权威信号
   * （v2 没有查询后台任务的 HTTP 端点）。**必须保留**，否则刷新后工作状态面板
   * 里所有后台任务都只能显示「状态未知」。
   *
   * 但它不能进对话流：会以一段 XML 的形式插在用户与助手之间。因此标成
   * `synthetic` part —— 渲染层会跳过它（见 isVisibleTextContent），而
   * `collectBackgroundJobs` 专门读它。
   */
  if (type === 'synthetic') {
    const text = str(m.text) ?? ''
    if (!text.trim()) return null
    return {
      info: {
        id,
        sessionID,
        role: 'assistant',
        parentID: '',
        modelID: '',
        providerID: '',
        mode: '',
        agent: '',
        path: { cwd: '', root: '' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: num(time.created) ?? 0, completed: num(time.created) ?? 0 },
      } as never,
      parts: [
        {
          id: `${id}-synthetic`,
          sessionID,
          messageID: id,
          type: 'text',
          text,
          synthetic: true,
          time: { start: 0, end: num(time.created) ?? 0 },
        } as never,
      ],
      ...(lightweight ? { lightweight } : {}),
    }
  }
  // 其余系统消息（idle / model-switched / agent-switched / system / skill / shell /
  // compaction）一律丢弃，避免它们污染对话流导致用户/助手位置错乱。
  if (type !== 'user') return null
  // 正文同时挂到 info.text：v2 的 user 消息正文在顶层 `text`，而前端领域模型
  // 以 content[] 为主。上下文估算等「只要体积、不渲染」的路径读 info.text
  // 比遍历 content 更直接，也避免与 content 里的同一段正文重复计数。
  const userText = str(m.text)
  return {
    info: {
      id,
      sessionID,
      role: 'user',
      time: { created: num(time.created) ?? 0 },
      agent: str(m.agent) ?? '',
      model: { providerID: '', modelID: '' },
      ...(userText !== undefined ? { text: userText } : {}),
    } as never,
    parts: adaptUserParts(m),
    ...(lightweight ? { lightweight } : {}),
  }
}

/** 归一 lightweight 统计字段；缺失或非法返回 undefined。 */
function adaptLightweight(raw: unknown):
  | {
      reasoningCount?: number
      stepCount?: number
      durationMs?: number
      changedFiles?: Array<{ path: string; additions?: number; deletions?: number }>
    }
  | undefined {
  if (raw == null || typeof raw !== 'object') return undefined
  const lw = rec(raw)
  const reasoningCount = num(lw.reasoningCount)
  const stepCount = num(lw.stepCount)
  const durationMs = num(lw.durationMs)

  // 轮次骨架回填的改动文件清单（骨架里没有 tool part，DiffChips 只能靠它）
  const changedFiles = list(lw.changedFiles)
    .map(entry => {
      const file = rec(entry)
      const path = str(file.path)
      if (!path) return null
      return {
        path,
        ...(num(file.additions) != null ? { additions: num(file.additions) } : {}),
        ...(num(file.deletions) != null ? { deletions: num(file.deletions) } : {}),
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry != null)

  if (reasoningCount == null && stepCount == null && durationMs == null && changedFiles.length === 0) {
    return undefined
  }
  return {
    reasoningCount,
    stepCount,
    ...(durationMs != null ? { durationMs } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
  }
}

/** 轮次结论（来自 `type: "idle"` 消息）。 */
export interface IdleMarker {
  /** 轮次结束时间（消息 time.created） */
  at: number
  /** succeeded | failed | interrupted */
  outcome: 'succeeded' | 'failed' | 'interrupted'
  /** 失败/中断时的错误说明 */
  error?: string
}

/** 会话配置切换记录（来自 `model-switched` / `agent-switched` 消息）。 */
export interface SessionConfigMarkers {
  model?: { providerID: string; modelID: string; at: number }
  agent?: { agent: string; at: number }
}

/**
 * 从一页消息里收集「轮次结论 + 会话配置切换」这类**非对话**的系统记录。
 *
 * v2 的 `SessionMessage.Info` 有 11 种类型，其中只有 user/assistant 是对话内容：
 *
 *   user  assistant  idle  compaction  system  synthetic  skill  shell
 *   agent-switched  model-switched  location-switched
 *
 * 我们的对话渲染只处理 user/assistant（其余若塞进消息流会让用户/助手位置错乱，
 * 所以继续丢弃）。但丢弃**不等于**信息无用 —— 其中两类是权威状态：
 *
 *   - `idle`：带 `outcome: succeeded | failed | interrupted` 和 `error`。
 *     这是「这一轮到底结束了吗、是成功还是失败」的**权威来源**。事件流里的
 *     `session.execution.succeeded` 一旦丢失/重连漏收，界面就会永远转圈；
 *     而 idle 在消息列表里，刷新即可恢复。
 *   - `model-switched` / `agent-switched`：带 `model` / `agent`。
 *     这是「这个会话绑定什么模型/agent」的权威历史。v2 的 user 消息**没有**
 *     model 字段（实测只有 time/text/files），所以「无痕窗口/新设备打开会话
 *     显示成默认模型」这类问题只能靠这里（或 session 元数据）还原。
 *
 * 这里只做**提取**，不改消息数组形状，避免污染对话流。
 */
export function collectSessionMarkers(data: unknown[]): {
  idle?: IdleMarker
  config: SessionConfigMarkers
} {
  let idle: IdleMarker | undefined
  const config: SessionConfigMarkers = {}

  for (const item of data) {
    const m = rec(item)
    const type = str(m.type)
    if (!type) continue
    const created = num(rec(m.time).created) ?? 0

    if (type === 'idle') {
      // 取最近一次（消息按 asc 或 desc 都可能，用时间比较而不是位置）
      if (idle && created <= idle.at) continue
      const rawOutcome = str(m.outcome)
      const outcome: IdleMarker['outcome'] =
        rawOutcome === 'failed' || rawOutcome === 'interrupted' ? rawOutcome : 'succeeded'
      const err = rec(m.error)
      const errMessage = str(err.message)
      const errData = rec(err.data)
      const errMsg = errMessage ?? str(errData.message) ?? undefined
      idle = { at: created, outcome, ...(errMsg ? { error: errMsg } : {}) }
      continue
    }

    if (type === 'model-switched') {
      const model = rec(m.model)
      const providerID = str(model.providerID)
      const modelID = str(model.id) ?? str(model.modelID)
      if (!providerID || !modelID) continue
      if (config.model && created <= config.model.at) continue
      config.model = { providerID, modelID, at: created }
      continue
    }

    if (type === 'agent-switched') {
      const agent = str(m.agent)
      if (!agent) continue
      if (config.agent && created <= config.agent.at) continue
      config.agent = { agent, at: created }
    }
  }

  return { ...(idle ? { idle } : {}), config }
}

/** v2 message.list 响应 → 内部 messages + 双向游标 */
export function adaptMessagePage(raw: unknown): {
  messages: MessageWithParts[]
  nextCursor?: string
  prevCursor?: string
  /** 本页内最近一次「已完成」压缩的时间戳；用于在消息流末尾展示压缩分隔条 */
  compactedAt?: number
  /** 压缩标记（摘要/近期消息规模） */
  compaction?: CompactionMarker
  /** 本页内最近一次轮次结论（idle 消息） */
  idle?: IdleMarker
  /** 本页内的会话配置切换记录 */
  config: SessionConfigMarkers
} {
  const r = rec(raw)
  const cursor = rec(r.cursor)
  const data = list(r.data)
  const compaction = findCompactionMarker(data)
  const markers = collectSessionMarkers(data)
  return {
    messages: data.map(adaptMessage).filter((m): m is MessageWithParts => m != null),
    nextCursor: str(cursor.next) ?? undefined,
    prevCursor: str(cursor.previous) ?? undefined,
    compactedAt: compaction?.at,
    compaction,
    idle: markers.idle,
    config: markers.config,
  }
}

/**
 * 分块版：逐条适配，每 ~6ms 让出一帧。
 *
 * 一页可达数千条消息，同步 `map(adaptMessage)`（含 content[] 展开、part 构造）
 * 在低端设备上会卡住主线程数百毫秒——正好落在首屏/上滑加载这些用户能感知的时机。
 * 结果与同步版完全一致，仅执行节奏不同。
 */
export async function adaptMessagePageAsync(raw: unknown): Promise<{
  messages: MessageWithParts[]
  nextCursor?: string
  prevCursor?: string
  compactedAt?: number
  compaction?: CompactionMarker
  idle?: IdleMarker
  config: SessionConfigMarkers
}> {
  const r = rec(raw)
  const cursor = rec(r.cursor)
  const data = list(r.data)
  const messages = await mapInSlices(data, adaptMessage)
  const compaction = findCompactionMarker(data)
  const markers = collectSessionMarkers(data)
  return {
    messages: messages.filter((m): m is MessageWithParts => m != null),
    nextCursor: str(cursor.next) ?? undefined,
    prevCursor: str(cursor.previous) ?? undefined,
    compactedAt: compaction?.at,
    compaction,
    idle: markers.idle,
    config: markers.config,
  }
}

/**
 * 压缩标记：`message.list` 里 `type: "compaction"` 的那条系统消息。
 *
 * 为什么不能只靠事件：`session.compaction.ended` 在 schema 里存在（带 text/recent），
 * 但实测它**不一定发**——本机 39,446 条事件里没有任何 `session.compaction.*`，
 * 而同一次压缩在消息列表里有完整的 `type: "compaction"` 记录。压缩是历史事实，
 * 消息列表才是权威来源，事件只当加速通道。
 *
 * 另有一个关键坑：该记录的 `tokens` 是**压缩前**用量（实测 input 342383 /
 * cache.read 577024），不能用它显示压缩后的占用；压缩后的上下文 ≈ 摘要 + 保留的
 * 近期消息，即下面两个字符数。
 */
export interface CompactionMarker {
  /** 压缩完成时间（消息的 time.created） */
  at: number
  /** 压缩摘要字符数 */
  summaryChars: number
  /** 保留的近期消息字符数 */
  recentChars: number
}

/** 从一页消息里找出最近一次「已完成」的压缩标记（含摘要规模）。 */
export function findCompactionMarker(data: unknown[]): CompactionMarker | undefined {
  let marker: CompactionMarker | undefined
  for (const item of data) {
    const m = rec(item)
    if (str(m.type) !== 'compaction' || str(m.status) !== 'completed') continue
    const created = num(rec(m.time).created)
    if (created == null) continue
    if (marker && created <= marker.at) continue
    marker = {
      at: created,
      // 轮次骨架路径下，主机 Agent 会把摘要 / 保留消息的**全文**换成字符数
      // （`summaryChars` / `recentChars`），只留计数以省带宽；两条路径都要支持。
      summaryChars: num(m.summaryChars) ?? (str(m.summary) ?? '').length,
      // `recent` 是压缩后原样保留的近期消息；没有该字段时按 0 计，
      // 让上界只包含摘要（宁可低估也不虚高）。
      recentChars: num(m.recentChars) ?? (str(m.recent) ?? '').length,
    }
  }
  return marker
}
