// ============================================
// UI Types - UI 层专用类型
// ============================================
//
// 这些类型扩展了 API 类型，添加了 UI 层特有的状态
//

import type { Message as ApiMessage, Part as ApiPart } from './api'

/**
 * UI 层消息类型
 * 扩展 API 消息，添加 UI 状态
 */
export interface UIMessage {
  /** API 消息信息 */
  info: ApiMessage
  /** 消息内容部分 */
  parts: ApiPart[]
  /** 是否正在流式传输 */
  isStreaming?: boolean
}

// ============================================
// Attachment Types - 从现有组件导出
// ============================================

// 直接从 features/attachment 导出，保持向后兼容
export type { Attachment, AttachmentType } from '../features/attachment/types'

// ============================================
// Model Types
// ============================================

/**
 * 模型信息（UI 层简化版本）
 */
export interface ModelInfo {
  id: string
  name: string
  providerId: string
  providerName: string
  family: string
  contextLimit: number
  /**
   * 模型声明的**输入**窗口（`limit.input`），未声明时为 0。
   *
   * 服务端压缩判据用的是 `limit.input || limit.context`（见
   * opencode 的 `SessionCompaction.calculateCeiling`）。很多模型把 input
   * 声明得比 context 小得多（models.dev 快照中有 789/1563 个 < 0.9，
   * 最低 0.25），只读 context 会让圆环百分比系统性偏低。
   * 取值统一走 `utils/contextWindow.ts` 的 `effectiveContextWindow`。
   */
  inputLimit: number
  outputLimit: number
  supportsReasoning: boolean
  supportsImages: boolean
  supportsPdf: boolean
  supportsAudio: boolean
  supportsVideo: boolean
  supportsToolcall: boolean
  variants: string[]
}

/**
 * 模型文件输入能力 — 决定可以附加哪些文件类型
 */
export interface FileCapabilities {
  image: boolean
  pdf: boolean
  audio: boolean
  video: boolean
  /**
   * 纯文本类文件（text/* 及其它文本编码，如 .md/.txt/.json/.csv）。
   *
   * 与 image/pdf/audio/video 不同，文本附件**不依赖模型的多模态能力**：
   * 服务端会把文本内联进对话内容，任何能读文本的模型都能处理。
   * 实测（2026-11-02）网关对 `text/markdown`、`text/plain`、`application/json`、
   * `application/octet-stream` 四种附件 MIME 均返回 200。
   *
   * 缺省视为 true（见 InputBox 的 caps 合并逻辑）：旧调用方不传该字段时，
   * 「大段文本→作为附件」这条路径仍然可用。
   */
  text?: boolean
}

// ============================================
// Router Types
// ============================================

/**
 * 路由状态
 */
export interface RouteState {
  sessionId: string | null
  directory: string | null
}

// ============================================
// Theme Types
// ============================================

/**
 * 主题模式
 */
export type ThemeMode = 'light' | 'dark' | 'system'

// ============================================
// Revert Types
// ============================================

import type { Attachment } from '../features/attachment/types'

/**
 * 撤销历史项
 */
export interface RevertHistoryItem {
  messageId: string
  text: string
  attachments: Attachment[]
  model?: { providerID: string; modelID: string; variant?: string }
  variant?: string
  agent?: string
}

/**
 * 撤销状态
 */
export interface RevertState {
  messageId: string
  history: RevertHistoryItem[]
}
