// ============================================
// 轮次骨架（turn skeleton）解析与适配
//
// 历史记录拉取的最终形态：主机 Agent 按**轮**投影，每轮只返回
// 「用户提问 + 最终回复 + 过程计数」，把 reasoning / 工具调用 / 中间说明
// 全部留在服务端。默认视图本来就只有这两样东西，过程块默认折叠、一个字节
// 都不显示，因此不传它们不损失任何有效信息。
//
// 实测（182 轮 / 3474 条消息 / 44 MB 原始响应的会话）：
//   原始完整消息          44 MB（前端按 200 条/页拉 19 次）
//   剥大字段（旧投影）     6.96 MB
//   轮次骨架               0.31 MB   ← 平均 1.7 KB/轮
//
// 用户点开「已处理」块时，仍按该轮首条 user 消息 id 自造游标回拉完整 parts
// （见 useSessionManager.hydrateTurn），结构与压缩态一致，复用同一条路径。
// ============================================

/**
 * 骨架里的一轮，**已还原成 v2 原生消息形态**。
 *
 * 刻意还原成 v2 形状而不是直接产出内部 `ApiMessageWithParts`：这样
 * `adaptMessagePage` 的压缩标记、轮次结论（idle）、会话配置（model-switched）
 * 提取逻辑可以原样复用，不必为骨架写第二套解析。
 */
export interface SkeletonTurnRaw {
  /** 用户消息（v2 user 形状：`{type:'user', id, time, text, files[]}`） */
  user: Record<string, unknown>
  /**
   * 最终回复（v2 assistant 形状）。
   * 该轮没有任何正文时缺省——纯工具轮由折叠块本身表达。
   */
  reply?: Record<string, unknown>
  /** 该轮累计的过程规模 */
  reasoningCount: number
  stepCount: number
  /** 该轮改动文件（用于最终回复下的 DiffChips） */
  changedFiles?: Array<{ path: string; additions?: number; deletions?: number }>
  /**
   * 该轮「已转入后台」的任务。
   *
   * 骨架把工具 part 整个剥掉（只留 stepCount），判断后台任务的依据
   * （`metadata.shellID` 与「Command moved to the background」回执）全在被剥掉的
   * 字段里。主机 Agent 因此单独带回这份最小信息，否则工作状态面板看不到后台任务。
   */
  backgroundJobs?: Array<{ id: string; kind: string; title: string; status: string }>
}

/** 骨架响应 → v2 原生消息序列 + 轮次记录 */
export interface SkeletonAdaptResult {
  /** 还原后的 v2 消息（可直接喂给 adaptMessagePage） */
  raw: unknown[]
  /** 轮次 id（用户消息 id）→ 过程规模与改动文件 */
  turns: Map<string, SkeletonTurnRecord>
  /**
   * 未定稿轮次的用户消息 id。
   *
   * 这些轮次仍在生成，骨架里只有截断快照；调用方必须改用完整消息拉取，
   * 否则实时 delta 接上来会重复或错位（delta 是 ephemeral、不带 seq）。
   */
  unsettled: string[]
  /** 全部轮次的后台任务（去重后） */
  backgroundJobs: Array<{ id: string; kind: string; title: string; status: string }>
}

export interface SkeletonTurnRecord {
  reasoningCount: number
  stepCount: number
  /** 该轮最终回复所在的助手消息 id */
  replyMessageID?: string
  /** 轮次总耗时（ms），折叠块 header 的「已处理 N 分钟」用它 */
  durationMs?: number
  changedFiles?: Array<{ path: string; additions?: number; deletions?: number }>
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * 判断响应是否为轮次骨架。
 *
 * 主机 Agent 未升级时会直接把请求透传给 opencode（不回 `X-Lightweight` 头），
 * 此时 `data[]` 是普通 message。骨架条目的标志是 `type: "turn"`。
 */
export function isTurnSkeleton(data: unknown[]): boolean {
  return data.some(item => str(rec(item).type) === 'turn')
}

/**
 * 骨架 → v2 原生消息序列。
 *
 * 每条 turn 还原成：
 *   - `{type:'user', id, time, text, files[]}`：正文 + 附件元信息（无 base64）；
 *   - `{type:'assistant', id, time, content:[{type:'text'}]}`：只有最终回复正文。
 *
 * 助手消息上额外带 `lightweight` 统计，`adaptMessage` 会据此把它标记为压缩态
 * （`isCompressed`），折叠块 header 因此仍显示「N 步 / N 段思考」，
 * 展开时走既有的 hydrateTurn 回拉完整过程。
 *
 * 系统标记（idle / compaction / agent-switched / ...）原样透传。
 */
export function adaptTurnSkeleton(data: unknown[]): SkeletonAdaptResult {
  const raw: unknown[] = []
  const turns = new Map<string, SkeletonTurnRecord>()
  /** 未定稿轮次的用户消息 id（调用方据此改用完整消息拉取） */
  const unsettled: string[] = []
  /** 全部轮次的后台任务（按 id 去重） */
  const backgroundJobs = new Map<string, { id: string; kind: string; title: string; status: string }>()

  for (const [index, entry] of data.entries()) {
    const item = rec(entry)
    const type = str(item.type)

    if (type !== 'turn') {
      // 系统标记：原样交给 adaptMessagePage 提取。
      raw.push(item)
      continue
    }

    /**
     * 未定稿的轮次（仍在生成）**不进骨架**。
     *
     * 骨架给的是「此刻的截断快照」，而后续 `session.text.delta` 是 ephemeral
     * （不重放、不带 seq），前端无法判断新 delta 与快照是否重叠 —— 直接拼会
     * 重复或错位。因此这类轮次交给调用方用完整消息拉取（方案 A）。
     */
    if (item.settled === false) {
      unsettled.push(str(item.id) ?? `skeleton-turn-${index}`)
      continue
    }

    const user = rec(item.user)
    const stats = rec(item.stats)
    const createdAt = num(rec(item.time).created) ?? 0
    const userId = str(item.id) ?? `skeleton-turn-${index}`
    const reasoningCount = num(stats.reasoningCount) ?? 0
    const stepCount = num(stats.stepCount) ?? 0

    // 后台任务：骨架单独带回（工具 part 已被剥掉，前端无法自己推导）
    for (const entry of list(item.backgroundJobs)) {
      const job = rec(entry)
      const jobId = str(job.id)
      if (!jobId) continue
      backgroundJobs.set(jobId, {
        id: jobId,
        kind: str(job.kind) ?? 'shell',
        title: str(job.title) ?? jobId,
        status: str(job.status) ?? 'unknown',
      })
    }

    // 用户消息：正文 + 附件元信息（骨架不含 base64 正文）
    const files = list(user.files).map(file => {
      const f = rec(file)
      return {
        mime: str(f.mime) ?? 'application/octet-stream',
        name: str(f.name) ?? str(f.filename),
        // 正文已由主机 Agent 剥掉；这里显式置空，避免适配层把 undefined
        // 当成「有 data」而拼出 `data:mime;base64,undefined`。
        data: '',
        source: { type: 'inline' },
        sizeBytes: num(f.sizeBytes),
      }
    })
    raw.push({
      type: 'user',
      id: userId,
      time: { created: createdAt },
      text: str(user.text) ?? '',
      ...(files.length > 0 ? { files } : {}),
    })

    // 最终回复
    const reply = rec(item.reply)
    const replyText = str(reply.text) ?? ''
    const replyMessageId = str(reply.messageID) ?? `${userId}-reply`
    /**
     * text 序号。
     *
     * 前端 partID 规则是 `${messageID}-text-${ordinal}`（见 adaptMessage），
     * 实时 `session.text.delta` 也用同一规则定位 part。骨架必须带回真实序号，
     * 否则「该轮最后一个 text 不是第 0 段」时 delta 会拼到错误位置。
     */
    const replyOrdinal = num(reply.ordinal) ?? 0
    const hasProcess = reasoningCount > 0 || stepCount > 0
    const durationMs = num(item.durationMs)
    const changedFiles = list(item.changedFiles)
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

    if (replyText.trim() || hasProcess || changedFiles.length > 0) {
      /**
       * content 里 text 的序号必须与真实消息对齐。
       *
       * `adaptMessage` 按 content 数组顺序给 text 编号（0、1、2…），而实时 delta
       * 用 `${messageID}-text-${ordinal}` 定位。若骨架的最终回复真实 ordinal 是 1，
       * 就必须先放一个占位 text 把序号顶到 1，否则 delta 会追加到第 0 段上。
       *
       * 占位段是空字符串 —— `isVisibleTextContent` 会把它过滤掉，不影响渲染。
       */
      const content: Array<Record<string, unknown>> = []
      for (let i = 0; i < replyOrdinal; i += 1) content.push({ type: 'text', text: '' })
      if (replyText.trim()) content.push({ type: 'text', text: replyText })

      raw.push({
        type: 'assistant',
        id: replyMessageId,
        time: { created: createdAt, completed: createdAt },
        content,
        ...(hasProcess || changedFiles.length > 0
          ? {
              lightweight: {
                reasoningCount,
                stepCount,
                // 改动文件清单：骨架里没有 tool part，DiffChips 只能靠这份数据。
                ...(changedFiles.length > 0 ? { changedFiles } : {}),
                // 轮次总耗时：骨架里没有逐条工具时间戳，无法反推，
                // 由 Agent 直接给出「首条 user 创建 → 末条 assistant 完成」。
                ...(durationMs != null ? { durationMs } : {}),
              },
            }
          : {}),
      })
    }

    const record: SkeletonTurnRecord = { reasoningCount, stepCount }
    if (str(reply.messageID)) record.replyMessageID = str(reply.messageID)
    if (changedFiles.length > 0) record.changedFiles = changedFiles
    if (durationMs != null) record.durationMs = durationMs
    turns.set(userId, record)
  }

  return { raw, turns, unsettled, backgroundJobs: [...backgroundJobs.values()] }
}
