import type {
  AgentPart as SDKAgentPart,
  AgentPartInput as SDKAgentPartInput,
  AssistantMessage as SDKAssistantMessage,
  CompactionPart as SDKCompactionPart,
  FilePart as SDKFilePart,
  FilePartInput as SDKFilePartInput,
  PatchPart as SDKPatchPart,
  ReasoningPart as SDKReasoningPart,
  RetryPart as SDKRetryPart,
  SnapshotPart as SDKSnapshotPart,
  StepFinishPart as SDKStepFinishPart,
  StepStartPart as SDKStepStartPart,
  SubtaskPart as SDKSubtaskPart,
  TextPart as SDKTextPart,
  TextPartInput as SDKTextPartInput,
  ToolPart as SDKToolPart,
  ToolState as SDKToolState,
  UserMessage as SDKUserMessage,
} from '@opencode-ai/sdk/v2/client'

export type MessageSummary = NonNullable<SDKUserMessage['summary']>

export type UserMessage = SDKUserMessage

export type AssistantMessage = SDKAssistantMessage

export type Message = UserMessage | AssistantMessage

export type TextPart = SDKTextPart

export type ReasoningPart = SDKReasoningPart

export type ToolState = SDKToolState

export type ToolPart = SDKToolPart



export type FilePart = SDKFilePart

export type AgentPart = SDKAgentPart

export type StepStartPart = SDKStepStartPart

export type StepFinishPart = SDKStepFinishPart

export type SnapshotPart = SDKSnapshotPart

export type PatchPart = SDKPatchPart

export type SubtaskPart = SDKSubtaskPart

export type RetryPart = SDKRetryPart

export type CompactionPart = SDKCompactionPart

export type Part =
  | TextPart
  | ReasoningPart
  | ToolPart
  | FilePart
  | AgentPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | SubtaskPart
  | RetryPart
  | CompactionPart

export interface MessageWithParts {
  info: Message
  parts: Part[]
  /**
   * 轻量投影统计：主机 Agent 命中 X-Lightweight 投影时会剥掉 reasoning 与工具
   * 大输出，并在消息上回填过程规模，供折叠块 header 在压缩态仍显示「N 步 / N 段思考」。
   * 存在即表示该消息为压缩投影（前端标记 isCompressed）。
   *
   * `changedFiles` 只在「轮次骨架」档出现：骨架里没有 tool part，本轮改动文件
   * （路径 + 增删行数）由 Agent 单独回填，供最终回复下的 DiffChips 渲染。
   */
  lightweight?: {
    reasoningCount?: number
    stepCount?: number
    /** 轮次总耗时（ms）：骨架路径由主机 Agent 直接给出 */
    durationMs?: number
    changedFiles?: Array<{ path: string; additions?: number; deletions?: number }>
  }
}

export type TextPartInput = SDKTextPartInput

export type FilePartInput = SDKFilePartInput

export type AgentPartInput = SDKAgentPartInput

