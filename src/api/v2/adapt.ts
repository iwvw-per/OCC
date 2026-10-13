// ============================================
// opencode v2 → 内部（v1 形状）适配
//
// v2（2.0.x）与 v1（1.18.x）响应结构不同：
//   - v2 会话实体用 location.directory、无 version；
//   - v2 消息是 {type, content[]}，v1 是 {info, parts[]}；
//   - v2 权限用 action/resources/save，v1 用 permission/patterns/always；
//   - v2「提问」被 Form 体系取代，v1 是 QuestionRequest。
//
// 本模块只做纯映射（v2 原始结构 → 内部类型），不发请求、不依赖 React。
// ============================================

type Rec = Record<string, unknown>

export function rec(value: unknown): Rec {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : {}
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
