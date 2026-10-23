// ============================================
// Event API Types
// SDK 是类型真相源，本地只保留必要的运行时适配
// ============================================

import type {
  EventPermissionReplied as SDKEventPermissionReplied,
  EventQuestionRejected as SDKEventQuestionRejected,
  EventQuestionReplied as SDKEventQuestionReplied,
  EventSessionDiff as SDKEventSessionDiff,
  EventSessionIdle as SDKEventSessionIdle,
  EventSessionStatus as SDKEventSessionStatus,
  EventTodoUpdated as SDKEventTodoUpdated,
  EventVcsBranchUpdated as SDKEventVcsBranchUpdated,
  EventWorktreeFailed as SDKEventWorktreeFailed,
  EventWorktreeReady as SDKEventWorktreeReady,
  GlobalEvent as SDKGlobalEvent,
  Todo as SDKTodo,
} from '@opencode-ai/sdk/v2/client'
import type { Session } from './session'
import type { Message, Part } from './message'
import type { PermissionRequest, QuestionRequest } from './permission'
import type { Project } from './project'

// ============================================
// Event Payload Types
// ============================================

export type SessionIdlePayload = SDKEventSessionIdle['properties'] & {
  /**
   * 服务端完成事件的时间（v2 事件的 created）。
   *
   * 通知时间戳必须用它，而不是各端处理事件的本地时刻：两端处理同一轮完成
   * 的时刻必然不同，而「已读水位」要跨端比较，基准不一致就会出现「一端读了、
   * 另一端还亮着」。
   */
  timestamp?: number
  /** 这一轮是怎么结束的：succeeded / failed / interrupted */
  outcome?: 'succeeded' | 'failed' | 'interrupted'
  /**
   * 中断原因（仅 outcome === 'interrupted'）。
   *
   * - `user`       用户主动停止
   * - `inactivity` 服务端判定空闲/服务重启而中止
   * - `shutdown`   服务端关闭
   *
   * 非 `user` 的中断在界面上必须给出提示：实测服务重启会悄悄打断正在跑的一轮，
   * 用户什么都没做却发现「卡住了」，只能反复发「继续」来猜测发生了什么。
   */
  interruptReason?: string
}

export interface SessionErrorPayload {
  sessionID: string
  name: string
  data: unknown
}

export type SessionStatusPayload = SDKEventSessionStatus['properties'] & {
  /** 服务端事件时间；用于完成通知的跨端一致时间戳，同 SessionIdlePayload */
  timestamp?: number
}

/**
 * 会话压缩结果（v2 `session.compaction.ended` / `session.compaction.failed`）。
 * 失败时带 error.message（如 "Nothing to compact yet"），用于提示用户。
 */
/**
 * v2 `session.compaction.ended` 的 tokens 形状。
 *
 * 压缩结束时服务端会带上「压缩后这次摘要请求的上下文用量」——这正是压缩后
 * 新上下文的真实占用，比自己按消息文本估算准确得多。旧代码丢掉了它，
 * 导致压缩完成后圆环仍按估算值显示。
 */
export interface CompactionTokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface SessionCompactedPayload {
  sessionID: string
  status: 'started' | 'completed' | 'failed'
  reason?: 'auto' | 'manual'
  error?: string
  /**
   * 压缩摘要字符数与保留的近期消息字符数（`session.compaction.ended` 的
   * text / recent，或 compaction part 的等价信息）。
   *
   * 这两个字段是**压缩后上下文**的真实构成：旧轮次已被摘要取代。压缩事件里的
   * `tokens` 实测是**压缩前**用量（input 342383 / cache.read 577024），拿它显示
   * 「压缩后的占用」会让圆环停在压缩前的高水位 —— 正是用户报的现象。
   */
  summaryChars?: number
  recentChars?: number
  /**
   * 压缩后这次摘要请求的上下文用量（completed 才可能有）。
   *
   * ⚠️ v2 实测该值是**压缩前**的用量，不能直接当作压缩后的上下文大小；
   * 优先用 summaryChars + recentChars 推算。
   */
  tokens?: CompactionTokenUsage
  cost?: number
  /** 压缩完成时间（服务端事件时间，缺失时由前端补） */
  time?: number
  /** 压缩边界：压缩后保留内容的第一条消息 id（v2 compaction part 的 tail_start_id） */
  tailStartID?: string
}

/**
 * 会话级累计用量（v2 `session.usage.updated`）。
 *
 * 会话被压缩后，历史轮次的 assistant 消息可能被裁掉/折叠，前端从可见消息
 * 汇总出的「累计 token / 花费」会随之变小。服务端这份累计值不随消息裁剪
 * 变化，是唯一正确的累计口径。
 */
export interface SessionUsagePayload {
  sessionID: string
  tokens: CompactionTokenUsage
  cost: number
}

export type SessionDiffPayload = SDKEventSessionDiff['properties']

/** message.part.delta 载荷（v2 原生） */
export interface PartDeltaPayload {
  sessionID: string
  assistantMessageID: string
  ordinal: number
  delta?: string
}

/** message.part.removed 载荷 */
export interface PartRemovedPayload {
  sessionID: string
  messageID: string
  partID: string
}

/**
 * v2 用户消息入队（`session.inbox.enqueued`）。
 *
 * 实测 v2 的实时事件流里没有 `message.updated`，用户消息唯一的实时信号就是它。
 * `inboxID` 由客户端生成（= prompt 的 messageID），因此各端看到的 id 与服务端
 * 落库后的消息 id 一致，可以按 id 精确替换本端乐观占位。
 */
export interface InboxEnqueuedPayload {
  sessionID: string
  inboxID: string
  /** 服务端事件时间 */
  created: number
  text: string
}

export type PermissionRepliedPayload = SDKEventPermissionReplied['properties']

export type QuestionRepliedPayload = SDKEventQuestionReplied['properties']

export type QuestionRejectedPayload = SDKEventQuestionRejected['properties']

export type TodoItem = SDKTodo & {
  // SDK 的 Todo 没有 id，这里是前端适配层补上的稳定 key
  id: string
}

export type TodoUpdatedPayload = Omit<SDKEventTodoUpdated['properties'], 'todos'> & {
  todos: TodoItem[]
}

export type WorktreeReadyPayload = SDKEventWorktreeReady['properties']

export type WorktreeFailedPayload = SDKEventWorktreeFailed['properties']

export type VcsBranchUpdatedPayload = SDKEventVcsBranchUpdated['properties']

export interface ServerConnectedPayload {
  timestamp?: unknown
}

/**
 * session.next.tool.success/failed / session.next.shell.ended 归一后的载荷。
 * callID 用于定位对应 tool part；output/error 仅作兜底展示。
 */
export interface NextToolSettledPayload {
  sessionID: string
  callID: string
  status: 'completed' | 'error'
  output?: string
  error?: string
  /** 工具结果 metadata（v2 的 task 工具用它携带子会话 sessionId，供子代理识别） */
  metadata?: Record<string, unknown>
}

/** 工具执行中的进度更新（v2 `session.tool.progress`） */
export interface NextToolProgressPayload {
  sessionID: string
  callID: string
  /** 工具自定义的进度信息（bash 给 `{ shellID }`，其它工具各异） */
  metadata?: Record<string, unknown>
}

// ============================================
// Global Event Type
// ============================================

export type GlobalEvent = SDKGlobalEvent

/**
 * 事件类型常量
 */
export const EventTypes = {
  // Session events
  SESSION_CREATED: 'session.created',
  SESSION_UPDATED: 'session.updated',
  /**
   * 会话重命名（v2）。payload 只有 {sessionID, title}，不含完整 session，
   * 因此单独成事件，由消费方按 id 打补丁，而非走 SESSION_UPDATED 的整条替换。
   * 注：v1 SDK 的事件类型联合不含此名，故用 EXTRA 常量承载。
   */
  SESSION_RENAMED: 'session.renamed',
  SESSION_DELETED: 'session.deleted',
  SESSION_IDLE: 'session.idle',
  SESSION_ERROR: 'session.error',
  SESSION_STATUS: 'session.status',
  SESSION_DIFF: 'session.diff',
  SESSION_COMPACTED: 'session.compacted',
  /** v2 用户消息入队（session.inbox.enqueued）：让所有端实时看到这条用户消息 */
  SESSION_INBOX_ENQUEUED: 'session.inbox.enqueued',
  /** v2 会话累计用量（tokens / cost），不随消息裁剪变化 */
  SESSION_USAGE_UPDATED: 'session.usage.updated',
  /**
   * v2 重试信号：`session.retry.scheduled`。后端因限流/超时对某条 assistant
   * 消息发起重试时，会先广播此事件（带被放弃的 assistantMessageID），随后用
   * **新的** assistantMessageID 重新生成。若不处理，前端会把旧消息已产生的
   * 部分文本与新消息的完整文本都渲染出来 —— 表现为「回复中有的句子出现两次」。
   */
  SESSION_RETRY_SCHEDULED: 'session.retry.scheduled',

  /**
   * 系统合成消息（v2 `session.synthetic`）：后台任务完成通知。
   *
   * 正文是 `<shell id=... state=...>` / `<subagent sessionID=... state=...>`。
   * 不进对话流，只作为「后台任务已结束」的权威信号被工作状态面板消费。
   */
  SESSION_SYNTHETIC: 'session.synthetic',

  // Message events
  MESSAGE_UPDATED: 'message.updated',
  MESSAGE_REMOVED: 'message.removed',
  MESSAGE_PART_UPDATED: 'message.part.updated',
  MESSAGE_PART_DELTA: 'message.part.delta',
  MESSAGE_PART_REMOVED: 'message.part.removed',

  // Session "next" 事件流：新一代工具/命令生命周期事件。
  // 正常情况下工具状态已由 message.part.updated 承载，这里只做防御性对账：
  // 若后端改用 next.* 描述工具结束而不补发 part.updated，前端仍能把悬空的
  // running/pending part 落定，避免永久转圈。
  SESSION_NEXT_TOOL_CALLED: 'session.next.tool.called',
  SESSION_NEXT_TOOL_PROGRESS: 'session.next.tool.progress',
  SESSION_NEXT_TOOL_SUCCESS: 'session.next.tool.success',
  SESSION_NEXT_TOOL_FAILED: 'session.next.tool.failed',
  SESSION_NEXT_SHELL_STARTED: 'session.next.shell.started',
  SESSION_NEXT_SHELL_ENDED: 'session.next.shell.ended',

  // Permission events
  PERMISSION_ASKED: 'permission.asked',
  PERMISSION_REPLIED: 'permission.replied',

  // Question events
  QUESTION_ASKED: 'question.asked',
  QUESTION_REPLIED: 'question.replied',
  QUESTION_REJECTED: 'question.rejected',

  // Todo events
  TODO_UPDATED: 'todo.updated',

  // TUI events
  TUI_PROMPT_APPEND: 'tui.prompt.append',
  TUI_COMMAND_EXECUTE: 'tui.command.execute',
  TUI_TOAST_SHOW: 'tui.toast.show',
  TUI_SESSION_SELECT: 'tui.session.select',

  // Project events
  PROJECT_UPDATED: 'project.updated',

  // Server events
  SERVER_CONNECTED: 'server.connected',
  SERVER_INSTANCE_DISPOSED: 'server.instance.disposed',
  GLOBAL_DISPOSED: 'global.disposed',

  // File events
  FILE_EDITED: 'file.edited',
  FILE_WATCHER_UPDATED: 'file.watcher.updated',

  // Other events
  INSTALLATION_UPDATED: 'installation.updated',
  INSTALLATION_UPDATE_AVAILABLE: 'installation.update-available',
  WORKTREE_READY: 'worktree.ready',
  WORKTREE_FAILED: 'worktree.failed',
  WORKSPACE_READY: 'workspace.ready',
  WORKSPACE_FAILED: 'workspace.failed',
  LSP_UPDATED: 'lsp.updated',
  MCP_TOOLS_CHANGED: 'mcp.tools.changed',
  MCP_BROWSER_OPEN_FAILED: 'mcp.browser.open.failed',
  VCS_BRANCH_UPDATED: 'vcs.branch.updated',
  COMMAND_EXECUTED: 'command.executed',
  PTY_CREATED: 'pty.created',
  PTY_UPDATED: 'pty.updated',
  PTY_EXITED: 'pty.exited',
  PTY_DELETED: 'pty.deleted',
  /** 后台 shell 生命周期：工作状态面板「后台任务」的权威状态来源 */
  SHELL_CREATED: 'shell.created',
  SHELL_EXITED: 'shell.exited',
} as const satisfies Record<
  string,
  // 前端自有的补充事件名：SDK 的类型联合里没有，但内部事件总线需要承载。
  | SDKGlobalEvent['payload']['type']
  | 'session.renamed'
  | 'session.retry.scheduled'
  | 'session.usage.updated'
  | 'session.inbox.enqueued'
  | 'session.synthetic'
  | 'shell.created'
  | 'shell.exited'
>

export type EventType = SDKGlobalEvent['payload']['type']

// ============================================
// Event Callbacks Interface
// ============================================

export interface EventCallbacks {
  onMessageUpdated?: (message: Message) => void
  onPartUpdated?: (part: Part) => void
  onPartDelta?: (data: PartDeltaPayload) => void
  /** v2 用户消息入队（session.inbox.enqueued）：让所有端实时看到这条用户消息 */
  onInboxEnqueued?: (data: InboxEnqueuedPayload) => void
  onPartRemoved?: (data: PartRemovedPayload) => void
  /** 整条消息被移除（v2 session.inbox.cancelled：入队后被撤销的用户消息） */
  onMessageRemoved?: (data: { sessionID: string; messageID: string }) => void
  onServerConnected?: (data: ServerConnectedPayload) => void
  onSessionCreated?: (session: Session) => void
  onSessionUpdated?: (session: Session) => void
  /** 会话重命名（v2）：仅有 {sessionID, title}，消费方按 id 更新标题，不做整条替换 */
  onSessionRenamed?: (data: { sessionID: string; title: string }) => void
  /**
   * v2 重试：后端放弃该 assistant 消息并用新 id 重新生成，消费方移除旧消息避免文本重复。
   *
   * `attempt` / `at` / `error` 让界面能显示「第 N 次重试、原因是什么」——
   * 上游限流时实测有 24 秒完全没有任何内容事件，若不给提示，用户只会觉得
   * 「卡死了 / 不流式」。
   */
  onSessionRetryScheduled?: (data: {
    sessionID: string
    assistantMessageID: string
    attempt?: number
    /** 计划重试的时间戳（ms） */
    at?: number
    error?: Record<string, unknown>
  }) => void
  /**
   * 系统合成消息（v2 `session.synthetic`）。
   *
   * 后台任务完成通知走这里：正文是 `<shell id=... state=...>` /
   * `<subagent sessionID=... state=...>`。不进对话流，只更新后台任务状态。
   */
  onSessionSynthetic?: (data: {
    sessionID: string
    text: string
    description?: string
    createdAt?: number
  }) => void
  /**
   * 后台 shell 启动（v2 `shell.created`）。
   *
   * 这是「后台任务正在跑」的权威信号；不带这个信号时，面板只能从历史消息
   * 推导，而历史只能证明「曾经启动过」，于是所有任务都显示成已结束。
   * `sessionID` 取自 shell 的 metadata，能精确归属到发起它的会话。
   */
  onShellCreated?: (data: {
    id: string
    status: string
    command: string
    cwd: string
    sessionID?: string
    startedAt: number
  }) => void
  /** 后台 shell 退出（v2 `shell.exited`）：终态与退出码 */
  onShellExited?: (data: { id: string; status: string; exit?: number; endedAt: number }) => void
  onSessionDeleted?: (sessionId: string) => void
  onSessionIdle?: (data: SessionIdlePayload) => void
  /** 会话压缩结束（v2）：成功/失败都回调，用于提示与刷新消息 */
  onSessionCompacted?: (data: SessionCompactedPayload) => void
  onSessionUsageUpdated?: (data: SessionUsagePayload) => void
  onSessionError?: (data: SessionErrorPayload) => void
  onSessionStatus?: (data: SessionStatusPayload) => void
  onPermissionAsked?: (request: PermissionRequest) => void
  onPermissionReplied?: (data: PermissionRepliedPayload) => void
  onQuestionAsked?: (request: QuestionRequest) => void
  onQuestionReplied?: (data: QuestionRepliedPayload) => void
  onQuestionRejected?: (data: QuestionRejectedPayload) => void
  onTodoUpdated?: (data: TodoUpdatedPayload) => void
  /**
   * session.next.tool.success/failed、session.next.shell.ended 归一后的工具落定事件。
   * 用于对账：若后端未补发 message.part.updated，仍能把 running/pending 的 part 收尾。
   */
  onNextToolSettled?: (data: NextToolSettledPayload) => void
  /**
   * 工具执行中的实时进度（v2 `session.tool.progress`，ephemeral）。
   *
   * 带 `metadata`（bash 是 `{ shellID }`，其它工具各异）。用于让长时间运行的
   * 工具在界面上有「还在动」的反馈，而不是从「已调用」直接静止到「已完成」。
   */
  onNextToolProgress?: (data: NextToolProgressPayload) => void
  onProjectUpdated?: (project: Project) => void
  onWorktreeReady?: (data: WorktreeReadyPayload) => void
  onWorktreeFailed?: (data: WorktreeFailedPayload) => void
  onVcsBranchUpdated?: (data: VcsBranchUpdatedPayload) => void
  onError?: (error: Error) => void
  onReconnected?: (reason: 'network' | 'server-switch') => void
}
