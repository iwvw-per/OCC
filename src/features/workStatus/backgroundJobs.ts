// ============================================
// backgroundJobs — 后台任务（shell / subagent）的识别与汇总
//
// v2 没有「查询后台任务」的 HTTP 端点：`Job.Service` 只在 opencode 进程内可用，
// 协议层没有暴露 `/job` 之类的接口（实测 grep 整个 packages/protocol 无命中）。
// 所以前端只能从消息流里推导，共有两个信号源：
//
//   1. **启动**：工具调用本身。转入后台时工具输出是
//      `Command moved to the background (shell ID: sh_xxx).`，
//      子代理则是 `The subagent is working in the background (sessionID: ses_xxx)`。
//      工具 part 的 `state.metadata.shellID` / `sessionID` 更可靠，优先用它。
//   2. **完成**：一条 `synthetic` 消息，正文是 XML：
//      `<shell id="sh_xxx" state="completed" command="...">output</shell>`
//      或 `<subagent sessionID="ses_xxx" state="completed">...</subagent>`。
//      `state` 取值 running / completed / error / cancelled。
//
// 历史消息路径会丢弃 synthetic（见 api/v2/message.ts 的 adaptMessage），因此
// 刷新后「已完成」的任务只能靠工具输出里那条「已转入后台」的回执还原成
// 「状态未知」。这是有意的取舍：把已结束的后台任务当「运行中」是更严重的错误。
// ============================================

import type { Message } from '../../types/message'
import { isSubagentToolName } from '../message/subagentUtils'

export type BackgroundJobKind = 'shell' | 'subagent'
export type BackgroundJobStatus = 'running' | 'completed' | 'error' | 'cancelled' | 'unknown'

export interface BackgroundJob {
  /** shellID 或子会话 id；同一 id 多次出现时合并为一条 */
  id: string
  kind: BackgroundJobKind
  /** 命令 / 子代理描述，用于面板上的一行标题 */
  title: string
  status: BackgroundJobStatus
  /** 启动它的消息 id（点条目可跳回对话） */
  messageId: string
  /** 启动时间（ms） */
  startedAt: number
  /** 完成时间（ms），来自 synthetic 消息 */
  finishedAt?: number
  /** 输出摘要（仅完成通知里带） */
  output?: string
}

/** 工具输出里「已转入后台」的回执（v2 shell 工具固定文案） */
const BACKGROUND_SHELL_OUTPUT_RE = /moved to the background\s*\(shell ID:\s*([\w-]+)\)/i
/** 子代理后台回执 */
const BACKGROUND_SUBAGENT_OUTPUT_RE = /\bworking in the background\b[^)]*?sessionID:\s*([\w-]+)/i
/** 完成通知 XML：`<shell id="sh_x" state="completed" command="...">` */
const SHELL_NOTICE_RE = /<shell\b([^>]*)>/i
const SUBAGENT_NOTICE_RE = /<subagent\b([^>]*)>/i
const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"/g

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const match of raw.matchAll(ATTR_RE)) {
    if (match[1]) attrs[match[1]] = match[2] ?? ''
  }
  return attrs
}

function normalizeStatus(value: string | undefined): BackgroundJobStatus {
  switch (value) {
    case 'running':
      return 'running'
    case 'completed':
      return 'completed'
    case 'error':
      return 'error'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

/** 从一条 synthetic 消息的正文里解析完成通知；不是后台任务通知则返回 null */
export function parseBackgroundNotice(
  text: string,
): { id: string; kind: BackgroundJobKind; status: BackgroundJobStatus; title: string; output: string } | null {
  const shell = text.match(SHELL_NOTICE_RE)
  if (shell) {
    const attrs = parseAttrs(shell[1] ?? '')
    const id = attrs.id
    if (!id) return null
    return {
      id,
      kind: 'shell',
      status: normalizeStatus(attrs.state),
      title: attrs.command ?? id,
      output: text.slice((shell.index ?? 0) + shell[0].length).replace(/<\/shell>\s*$/i, '').trim(),
    }
  }
  const subagent = text.match(SUBAGENT_NOTICE_RE)
  if (subagent) {
    const attrs = parseAttrs(subagent[1] ?? '')
    const id = attrs.sessionID ?? attrs.sessionid
    if (!id) return null
    return {
      id,
      kind: 'subagent',
      status: normalizeStatus(attrs.state),
      title: attrs.description ?? id,
      output: text.slice((subagent.index ?? 0) + subagent[0].length).replace(/<\/subagent>\s*$/i, '').trim(),
    }
  }
  return null
}

/** 工具 part 是否是「已转入后台」的调用；是则返回其 job id */
function backgroundJobIdOfTool(part: {
  tool: string
  state: { metadata?: unknown; output?: unknown }
}): { id: string; kind: BackgroundJobKind } | null {
  const metadata = part.state.metadata
  if (metadata && typeof metadata === 'object') {
    const meta = metadata as Record<string, unknown>
    // shell：metadata.shellID；子代理：metadata.sessionID
    if (typeof meta.shellID === 'string' && meta.shellID) {
      return { id: meta.shellID, kind: 'shell' }
    }
    /**
     * 子代理：`metadata.sessionID` 是子会话 id。
     *
     * 必须排除 shell 类工具 —— 它们的 metadata 里也可能出现 sessionID
     * （例如 CodeMode 子调用），而那种情况后台 id 是 shellID 而不是会话 id。
     * 用「工具名是否子代理工具」判定，而不是黑名单 bash：v2 的 shell 工具
     * 可能被别名叫 sh / shell / terminal。
     */
    if (typeof meta.sessionID === 'string' && meta.sessionID && isSubagentToolName(part.tool)) {
      return { id: meta.sessionID, kind: 'subagent' }
    }
  }
  const output = part.state.output
  if (typeof output === 'string') {
    const shellMatch = output.match(BACKGROUND_SHELL_OUTPUT_RE)
    if (shellMatch?.[1]) return { id: shellMatch[1], kind: 'shell' }
    const subagentMatch = output.match(BACKGROUND_SUBAGENT_OUTPUT_RE)
    if (subagentMatch?.[1]) return { id: subagentMatch[1], kind: 'subagent' }
  }
  return null
}

/**
 * 从消息列表汇总后台任务。
 *
 * 只读 `content` 里的 tool part 与 synthetic 完成通知；不做网络请求。
 * 同一 id 多次出现时以**最新状态**为准（后出现的完成通知覆盖先前的 running）。
 *
 * `live` 是本会话的实时状态表（`backgroundJobStore`）。历史消息只能覆盖「已发生
 * 的」，正在跑的任务只有在实时事件到达后才知道——所以要把两者合并。
 */
export function collectBackgroundJobs(
  messages: Message[],
  live?: Map<string, { status: BackgroundJobStatus; at: number; output?: string; title?: string }>,
): BackgroundJob[] {
  const byId = new Map<string, BackgroundJob>()

  const touch = (job: BackgroundJob) => {
    const existing = byId.get(job.id)
    if (!existing) {
      byId.set(job.id, job)
      return
    }
    // 完成通知优先；同一优先级下保留更早的启动信息（startedAt 更准）
    if (job.status !== 'unknown' || existing.status === 'unknown') {
      byId.set(job.id, {
        ...existing,
        status: job.status === 'unknown' ? existing.status : job.status,
        title: job.title || existing.title,
        ...(job.finishedAt != null ? { finishedAt: job.finishedAt } : {}),
        ...(job.output ? { output: job.output } : {}),
      })
    }
  }

  for (const message of messages) {
    // 1) 完成通知（synthetic 消息被 adaptMessage 丢弃，这里只处理已进内存的）
    for (const part of message.content) {
      if (part.type !== 'text') continue
      if (!part.synthetic) continue
      const notice = parseBackgroundNotice(part.text)
      if (!notice) continue
      touch({
        id: notice.id,
        kind: notice.kind,
        title: notice.title,
        status: notice.status,
        messageId: message.info.id,
        startedAt: message.info.time?.created ?? 0,
        finishedAt: message.info.time?.created ?? 0,
        ...(notice.output ? { output: notice.output } : {}),
      })
    }

    // 2) 启动信号：工具 part 的「已转入后台」回执
    for (const part of message.content) {
      if (part.type !== 'tool') continue
      const job = backgroundJobIdOfTool(part)
      if (!job) continue
      /**
       * 状态：默认「已完成」。
       *
       * ⚠️ 不能用工具 part 的 status 判断任务是否还在跑：`background=true` 的调用
       * 会**立即返回**（工具本身是 completed），任务继续在后台跑。实测按工具状态
       * 判定会让所有历史任务都变成「状态未知」。
       *
       * 历史消息里能读到的轮次都已经结束，所以没有完成通知时按已完成处理；
       * 真正"正在跑"的任务由实时事件维护（backgroundJobStore）。
       */
      touch({
        id: job.id,
        kind: job.kind,
        title: toolTitle(part),
        status: part.state.status === 'error' ? 'error' : 'completed',
        messageId: message.info.id,
        startedAt: message.info.time?.created ?? 0,
      })
    }
  }

  // 实时状态覆盖历史推导的结果：正在跑的任务只有实时事件知道
  if (live && live.size > 0) {
    for (const [id, state] of live) {
      const existing = byId.get(id)
      if (existing) {
        byId.set(id, {
          ...existing,
          status: state.status,
          ...(state.output ? { output: state.output } : {}),
          ...(state.title ? { title: state.title } : {}),
          ...(state.status !== 'running' ? { finishedAt: state.at } : {}),
        })
        continue
      }
      // 历史里没有启动记录（比如工具回执已被裁剪）→ 仍要显示出来
      byId.set(id, {
        id,
        kind: 'shell',
        title: state.title ?? id,
        status: state.status,
        messageId: '',
        startedAt: state.at,
        ...(state.output ? { output: state.output } : {}),
        ...(state.status !== 'running' ? { finishedAt: state.at } : {}),
      })
    }
  }

  // 运行中优先、再按时间倒序（最近的在上面）
  const rank: Record<BackgroundJobStatus, number> = {
    running: 0,
    error: 1,
    unknown: 2,
    cancelled: 3,
    completed: 4,
  }
  return [...byId.values()].sort(
    (a, b) => rank[a.status] - rank[b.status] || b.startedAt - a.startedAt,
  )
}

/** 面板上显示的一行标题：优先命令行，其次工具名 */
function toolTitle(part: { tool: string; state: { input?: unknown } }): string {
  const input = part.state.input
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>
    for (const key of ['command', 'description', 'prompt', 'filePath', 'path']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }
  return part.tool
}
