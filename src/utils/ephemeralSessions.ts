// ============================================
// Ephemeral Sessions — 内部临时会话登记
// ============================================
//
// AI 重命名等内部操作会创建「用完即删」的临时会话。这些会话不应该出现在
// 侧栏列表、搜索、历史记录等任何面向用户的会话视图里。全局事件（SSE）
// 与列表索引以同一份登记为准，创建方先登记、删除后注销。
//
// 键：临时会话的原始 id（sessionID，非复合 key）。

const ephemeralSessionIds = new Set<string>()

export function markEphemeralSession(sessionId: string): void {
  ephemeralSessionIds.add(sessionId)
}

export function unmarkEphemeralSession(sessionId: string): void {
  ephemeralSessionIds.delete(sessionId)
}

export function isEphemeralSession(sessionId: string): boolean {
  return ephemeralSessionIds.has(sessionId)
}
