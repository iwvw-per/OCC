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

/**
 * 取工具结果的 metadata。
 *
 * v2 的 task（子代理）工具把子会话 id 放在结果 metadata 里（`metadata.sessionId`）。
 * 不同事件在 data.metadata / data.structured / data.result 之一携带，取第一个非空对象。
 * 事件适配层与 SSE 归一层共用，避免两处候选列表不一致。
 */
export function toolResultMetadata(data: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const candidate of [data.metadata, data.structured, data.result]) {
    const value = rec(candidate)
    if (Object.keys(value).length > 0) return value
  }
  return undefined
}

/**
 * 把 v2 的 `SessionStructuredError`（`{ type, message, status?, response? }`）映射为
 * 前端 `MessageError['name']`。
 *
 * v2 用 `type`（如 `provider.quota` / `provider.auth` / `aborted`），v1/前端用 `name`
 * （`APIError` / `ProviderAuthError` / `MessageAbortedError` …）。此前误读 `error.name`
 * 导致语义丢失（额度超限等被显示成通用 UnknownError）。
 *
 * 放在 adapt.ts 而不是 events.ts：**实时事件**（`session.step.failed`）与
 * **历史快照**（`message.list` 里的 `error` 字段）都要走同一套映射，否则同一个
 * 错误在刷新前后会呈现成两种形态。
 */
export function mapV2ErrorName(error: Record<string, unknown>): string {
  const type = str(error.type) ?? ''
  const status = num(error.status)
  if (type === 'aborted' || type === 'interrupted') return 'MessageAbortedError'
  if (type === 'provider.auth' || status === 401 || status === 403) return 'ProviderAuthError'
  if (type === 'provider.quota' || type === 'provider.rate_limit' || status === 429) return 'APIError'
  if (type.startsWith('provider.') || type.startsWith('tool.') || status !== undefined) return 'APIError'
  return 'UnknownError'
}

/**
 * 把 v2 结构化错误转成前端 `MessageError`（name + data），供错误视图渲染。
 * data 字段对齐 MessageErrorView：message / statusCode / isRetryable / responseBody。
 */
export function toMessageError(error: Record<string, unknown>): { name: string; data: Record<string, unknown> } {
  const name = mapV2ErrorName(error)
  const response = rec(error.response)
  return {
    name,
    data: {
      message: str(error.message) ?? str(error.type) ?? 'error',
      statusCode: num(error.status),
      isRetryable: name === 'APIError',
      responseBody: str(response.body),
      providerID: str(error.providerID),
    },
  }
}
