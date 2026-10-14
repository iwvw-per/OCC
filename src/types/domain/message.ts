// ============================================
// Domain Types - Message (v2 原生形状)
//
// v2 消息模型与 v1 完全不同：
//   - v1: Message { info, parts: Part[] }（12 种 part）
//   - v2: SessionMessage.Info，按 type 标签区分；assistant 用 content[]，
//         元素是 { type: 'text' | 'reasoning' | 'tool', ... }
//
// 前端领域类型直接采用 v2 原生形状，UI 据此渲染。
// ============================================

export type DomainMessageType =
  | 'user'
  | 'assistant'
  | 'synthetic'
  | 'system'
  | 'skill'
  | 'shell'
  | 'compaction'
  | 'idle'
  | 'agent-switched'
  | 'model-switched'
  | 'location-switched'

export interface DomainMessageTime {
  created: number
  streamed?: number
  completed?: number
}

export interface DomainModelRef {
  id: string
  providerID: string
  variant?: string
}

// ---------- assistant content 元素 ----------

export interface DomainTextContent {
  type: 'text'
  text: string
  state?: Record<string, unknown>
}

export interface DomainReasoningContent {
  type: 'reasoning'
  text: string
  state?: Record<string, unknown>
  time?: { created: number; completed?: number }
}

export interface DomainToolContent {
  type: 'tool'
  id: string
  name: string
  executed?: boolean
  providerState?: Record<string, unknown>
  providerResultState?: Record<string, unknown>
  state: DomainToolState
  time: { created: number; ran?: number; completed?: number }
}

export type DomainToolState =
  | { status: 'streaming'; input: string }
  | { status: 'running'; input: Record<string, unknown>; metadata: Record<string, unknown> }
  | {
      status: 'completed'
      input: Record<string, unknown>
      content: Array<{ type: 'text'; text: string } | { type: 'file'; uri: string; mime: string; name?: string }>
      metadata?: Record<string, unknown>
    }
  | {
      status: 'error'
      input: Record<string, unknown>
      error: { type: string; message: string; status?: number; response?: { body: string } }
      content?: Array<{ type: 'text'; text: string } | { type: 'file'; uri: string; mime: string; name?: string }>
      metadata?: Record<string, unknown>
    }

export type DomainAssistantContent = DomainTextContent | DomainReasoningContent | DomainToolContent

// ---------- 消息 ----------

export interface DomainAssistantMessage {
  id: string
  sessionID: string
  type: 'assistant'
  content?: DomainAssistantContent[]
  agent?: string
  model?: DomainModelRef
  finish?: string
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  error?: { name: string; message: string; data?: unknown }
  time: DomainMessageTime
  parentID?: string
}

export interface DomainUserMessage {
  id: string
  sessionID: string
  type: 'user'
  text?: string
  files?: Array<{ data: string; mime: string; name?: string }>
  time: DomainMessageTime
  parentID?: string
}

export type DomainMessage = DomainAssistantMessage | DomainUserMessage
