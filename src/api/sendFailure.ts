// ============================================
// 发送失败的分类与文案
//
// 从 useChatSession 抽出，便于单测：这里只做「错误对象 → 提示 key」的映射，
// 不涉及 React 与网络。
//
// 依据（2026-11-02 对真实网关实测）：
//   POST /api/aiagent/gw/{id}/api/session/{sid}/prompt
//   请求体 > 8388608 字节 → 413
//     {"code":"AIAGENT_INVALID","error":"request body exceeds 8388608 bytes"}
//
// 而 `@opencode/client` 只把 400/401/404/409 声明为预期状态码，413 会被包成
// `ClientError("UnexpectedStatus", { cause: { status: 413 }, detail: "413" })`
// —— **状态码在 cause.status，不在 message 里**，所以两种形状都要认。
//
// 超时（trackedFetch 的 AbortController）会被包成
// `ClientError("Transport", { cause: AbortError })`，message 为
// "Transport: API request timed out"。
// ============================================

import { REQUEST_BODY_MAX_BYTES, REQUEST_TIMEOUT_MAX_MS, formatRequestBytes } from '../constants/requestLimits'

export interface SendFailureDescription {
  /** i18n key（相对 chat 命名空间） */
  titleKey: string
  bodyKey: string
  params: Record<string, unknown>
}

/** 网关侧的「请求体过大」特征串（实测响应体原文）。 */
const BODY_TOO_LARGE_PATTERN = /request body too large|request body exceeds/i
/** trackedFetch 超时的特征串。 */
const TIMEOUT_PATTERN = /API request timed out/

export function describeSendFailure(error: unknown): SendFailureDescription {
  const err = error as { reason?: string; cause?: { status?: number }; message?: string } | null | undefined
  const status = err?.cause?.status
  const message = err?.message ?? String(error)

  if (status === 413 || BODY_TOO_LARGE_PATTERN.test(message)) {
    const limit = formatRequestBytes(REQUEST_BODY_MAX_BYTES)
    return {
      titleKey: 'errors.sendTooLargeTitle',
      bodyKey: 'errors.sendTooLargeDesc',
      params: { limit, size: `${limit}+` },
    }
  }

  if (TIMEOUT_PATTERN.test(message)) {
    return {
      titleKey: 'errors.sendFailed',
      bodyKey: 'errors.sendTimeoutDesc',
      params: { seconds: Math.round(REQUEST_TIMEOUT_MAX_MS / 1000) },
    }
  }

  if (err?.reason === 'Transport') {
    return {
      titleKey: 'errors.sendFailed',
      bodyKey: 'errors.sendNetworkDesc',
      params: { detail: message.slice(0, 200) },
    }
  }

  return {
    titleKey: 'errors.sendFailed',
    bodyKey: 'errors.sendUnknownDesc',
    params: { detail: message.slice(0, 200) },
  }
}
