// ============================================
// Message Types - 直接对齐 API 数据结构
// ============================================
//
// 前端领域模型已统一为 v2 content[]（text / reasoning / tool 三种）。
// v1 后端的 12 种 part 由适配层（src/utils/messageConversion.ts）折叠为这 3 种，
// v1 专有的基础设施 part（step-start/step-finish/snapshot/patch/subtask/agent 等）
// 不再进入本模型。

import type { Attachment } from '../features/attachment/types'

// ============================================
// Common Types
// ============================================

export interface MessageTime {
  /**
   * v2 轻量投影/流式消息可能整条没有 `time`，或只有 `created`/`completed` 之一。
   * 读取方必须容忍缺失（`info.time?.created ?? 0`），否则渲染期会抛 TypeError
   * 并被 ErrorBoundary 兜成整页「OCC ran into a problem」。
   */
  created?: number
  /**
   * 流式输出结束时刻（`session.step.streamed`）。
   *
   * 语义：**该步模型把内容吐完的时刻**，不是首 token 时刻。
   * 官方 TUI 的 tok/s 就用它做分母（`streamed - created`），
   * 见 opencode `packages/tui/src/routes/session/rows.ts` 的 `turnTokensPerSecond`。
   *
   * 为什么必须单独有这个字段：v2 的 text part **完全没有 time**，
   * 只有 reasoning / tool 有；用 part 时间算速度永远拿不到样本，
   * 只能退回「整条消息时长」，把 TTFT 与工具执行也算进生成时间。
   */
  streamed?: number
  completed?: number
}

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface ModelRef {
  providerID: string
  modelID: string
  variant?: string
}

export interface PathInfo {
  cwd: string
  root: string
}

export interface MessageSummary {
  title?: string
  body?: string
  diffs?: FileDiff[]
}

export interface FileDiff {
  path: string
  additions: number
  deletions: number
  diff?: string
}

// ============================================
// Error Types
// ============================================

export interface ProviderAuthError {
  name: 'ProviderAuthError'
  data: { providerID: string; message: string }
}

export interface UnknownError {
  name: 'UnknownError'
  data: { message: string }
}

export interface MessageOutputLengthError {
  name: 'MessageOutputLengthError'
  data: Record<string, never>
}

export interface MessageAbortedError {
  name: 'MessageAbortedError'
  data: { message: string }
}

export interface APIError {
  name: 'APIError'
  data: {
    message: string
    statusCode?: number
    isRetryable: boolean
    responseHeaders?: Record<string, string>
    responseBody?: string
    metadata?: Record<string, string>
  }
}

export type MessageError = ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError | APIError

// ============================================
// Message Info (元信息)
// ============================================

// User message info
export interface UserMessageInfo {
  id: string
  sessionID: string
  role: 'user'
  time: MessageTime
  agent: string
  model: ModelRef
  summary?: MessageSummary
  /**
   * 用户输入的正文。
   *
   * v2 的 user 消息**不带 content[]**，正文就在这个字段（实测 `{id,time,text,type}`）；
   * content 只在带工具/附件时才出现。上下文估算必须读它，否则用户输入全被算成 0。
   */
  text?: string
  /** 用户消息附带的文件 / agent 引用（v2 user message 的 files[]/agents[]，或 v1 file/agent part 折叠） */
  attachments?: Attachment[]
}

// Assistant message info
export interface AssistantMessageInfo {
  id: string
  sessionID: string
  role: 'assistant'
  time: MessageTime
  parentID: string // 指向用户消息
  modelID: string
  providerID: string
  mode: string
  agent: string
  path: PathInfo
  cost: number
  tokens: TokenUsage
  finish?: 'stop' | 'tool-calls' | string
  error?: MessageError
  summary?: boolean // 是否为摘要消息
}

export type MessageInfo = UserMessageInfo | AssistantMessageInfo

// ============================================
// Content Types (v2 content[] 内容)
// ============================================

interface ContentBase {
  id: string
  sessionID: string
  messageID: string
}

export interface TextContent extends ContentBase {
  type: 'text'
  text: string
  synthetic?: boolean // 系统生成的上下文
  time?: { start: number; end?: number }
}

export interface ReasoningContent extends ContentBase {
  type: 'reasoning'
  text: string
  time: { start: number; end?: number }
}

// ToolState - 按状态细分的联合类型
export interface ToolStatePending {
  status: 'pending'
  input: Record<string, unknown>
  raw?: string
}

export interface ToolStateRunning {
  status: 'running'
  input: Record<string, unknown>
  title?: string
  metadata?: Record<string, unknown>
  time: { start: number }
}

export interface ToolStateCompleted {
  status: 'completed'
  input: Record<string, unknown>
  output: string
  title: string
  metadata: Record<string, unknown>
  time: { start: number; end: number; compacted?: number }
  attachments?: FileContent[]
}

export interface ToolStateError {
  status: 'error'
  input: Record<string, unknown>
  error: string
  metadata?: Record<string, unknown>
  time: { start: number; end: number }
}

// 宽松的 ToolState 类型，用于实际渲染（API 返回的数据可能不完全符合严格类型）
export interface ToolState {
  /**
   * interrupted：前端对账出来的兜底态。后端未回传完成事件（进程卡死/事件丢失），
   * 会话已 idle/error 时把仍 running/pending 的 part 落定为该状态，避免永久转圈。
   * 服务端后续若补发权威完成事件，会被正常覆盖。
   */
  status: 'pending' | 'running' | 'completed' | 'error' | 'interrupted'
  input?: Record<string, unknown>
  output?: string
  title?: string
  error?: string
  time?: { start: number; end?: number; compacted?: number }
  metadata?: Record<string, unknown>
  attachments?: FileContent[]
  /**
   * 工具结果里被**丢弃**的内联文件体积（字节）。
   *
   * v2 的 content[] 可能带 `type: "file"` 块，`uri` 是完整的 base64
   * （实测一张截图 2.3MB）。这些字节不留在前端内存（只拼文本 output），
   * 但它们**仍在服务端上下文里**，会让转发给模型的请求体膨胀 ——
   * 真实故障：5 张截图累计 11MB，触发上游 16MB 上限返回 413。
   *
   * 只记数字用于发送前预警，不保留任何字节。
   */
  omittedFileBytes?: number
  raw?: string
}

export interface ToolContent extends ContentBase {
  type: 'tool'
  callID: string
  tool: string
  state: ToolState
}

// FileContent - 工具完成时携带的产物附件（源自 v2 ToolFileContent，或 v1 file part 折叠）
export interface FileContent {
  uri: string
  mime: string
  name?: string
  /** v1 file part 折叠时保留的原始字段 */
  url?: string
  filename?: string
}

export type Content = TextContent | ReasoningContent | ToolContent

// ============================================
// Message (完整消息)
// ============================================

export interface Message {
  info: MessageInfo
  content: Content[]
  // UI 状态
  isStreaming?: boolean
  /**
   * 历史压缩标记：该消息属于较早的轮次，reasoning 与工具大输出已被清空，
   * 只保留渲染与统计所需的最小投影。展开对应过程折叠块时按需回拉完整 content。
   */
  isCompressed?: boolean
  /** 压缩前的过程统计，供折叠块 header 在压缩态仍能显示规模 */
  compressedStats?: {
    reasoningCount: number
    stepCount: number
    /** 轮次总耗时（ms）：骨架路径由主机 Agent 直接给出，无法从消息反推 */
    durationMs?: number
  }
  /**
   * 本轮改动文件（仅「轮次骨架」路径带回）。
   *
   * 骨架里没有 tool part，所以无法从 content 反推改动文件；由主机 Agent 单独
   * 回填这份最小清单（路径 + 增删行数），供最终回复下的 DiffChips 渲染。
   */
  skeletonChangedFiles?: Array<{ path: string; additions?: number; deletions?: number }>
}

// ============================================
// 辅助类型
// ============================================

/** 检查消息是否为用户消息 */
export function isUserMessage(info: MessageInfo): info is UserMessageInfo {
  return info.role === 'user'
}

/** 检查消息是否为助手消息 */
export function isAssistantMessage(info: MessageInfo): info is AssistantMessageInfo {
  return info.role === 'assistant'
}

/** 检查 content 是否为工具调用 */
export function isToolContent(content: Content): content is ToolContent {
  return content.type === 'tool'
}

/** 检查 content 是否为可见文本 */
export function isVisibleTextContent(content: Content): content is TextContent {
  return content.type === 'text' && !!content.text.trim() && !content.synthetic
}

/** 检查 content 是否为可见 reasoning */
export function isVisibleReasoningContent(content: Content): content is ReasoningContent {
  return content.type === 'reasoning' && !!content.text.trim()
}

/** 检查 content 是否会在信息流里产生实际内容 */
export function isRenderableContent(content: Content): boolean {
  switch (content.type) {
    case 'text':
      return isVisibleTextContent(content)
    case 'reasoning':
      return isVisibleReasoningContent(content)
    case 'tool':
      return true
    default:
      return false
  }
}

export function isAbortedMessage(info: MessageInfo): boolean {
  return info.role === 'assistant' && info.error?.name === 'MessageAbortedError'
}

export function hasRenderableContent(message: Message): boolean {
  // 纯图片/纯附件消息：content[] 里只有一个空 text（正文为空），
  // 但 attachments 里有内容。只判 content 会把这类消息整条过滤掉，
  // 用户看到的就是「我发了图片，但消息不见了」。
  if (message.info.role === 'user') {
    const attachments = (message.info as UserMessageInfo).attachments
    if (attachments && attachments.length > 0) return true
  }
  return message.content.some(isRenderableContent)
}

/** 检查消息是否有可见内容 */
export function hasVisibleContent(message: Message): boolean {
  return hasRenderableContent(message)
}

/** 获取消息的纯文本内容 */
export function getMessageText(message: Message): string {
  return message.content
    .filter((c): c is TextContent => c.type === 'text' && !c.synthetic)
    .map(c => c.text)
    .join('')
}

// 兼容旧名：供仍引用 Part 的模块平滑迁移（过渡期后移除）
/** @deprecated 使用 Content */
export type Part = Content
/** @deprecated 使用 TextContent */
export type TextPart = TextContent
/** @deprecated 使用 ReasoningContent */
export type ReasoningPart = ReasoningContent
/** @deprecated 使用 ToolPart */
export type ToolPart = ToolContent
