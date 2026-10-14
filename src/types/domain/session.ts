// ============================================
// Domain Types - Session (v2 原生形状)
//
// 前端自己的领域类型层（DTA）。UI 只依赖这层，不直接依赖
// @opencode/client 或 @opencode-ai/sdk。基于 v2 原生形状定义。
// ============================================

export interface DomainSession {
  id: string
  projectID?: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  outcome?: 'succeeded' | 'failed' | 'interrupted'
  time: { created: number; updated: number; viewed?: number; archived?: number; idle?: number }
  title?: string
  location: { directory: string; workspaceID?: string }
  subpath?: string
  parentID?: string
}

export interface DomainSessionPage {
  sessions: DomainSession[]
  nextCursor?: string
  prevCursor?: string
}
