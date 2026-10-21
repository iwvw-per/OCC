import { describe, expect, it } from 'vitest'
import { getErrorInfo } from './errorInfo'
import type { MessageError } from '../../../types/message'

/**
 * 错误文案分级。
 *
 * 重点是 413：这个错误本身对用户完全不可理解。真实故障是用户只发了
 * 「继续」两个字却收到 `API Error (413) http: request body too large`，
 * 真正原因（agent 读的截图以 base64 留在服务端上下文，转发给模型时超过
 * 上游 16MB 上限）在错误文本里完全看不出来。
 *
 * 所以 413 必须翻译成「为什么 + 怎么办」，而不是直接甩状态码。
 */

const t = (key: string, opts?: Record<string, unknown>) =>
  `${key}${opts ? JSON.stringify(opts) : ''}`

const apiError = (data: Partial<MessageError['data']> = {}): MessageError =>
  ({
    name: 'APIError',
    data: { message: 'http: request body too large', isRetryable: true, ...data },
  }) as MessageError

describe('getErrorInfo', () => {
  it('explains 413 with an actionable message instead of a raw status code', () => {
    const info = getErrorInfo(apiError({ statusCode: 413 }), t)
    expect(info.title).toContain('payloadTooLarge')
    expect(info.description).toContain('payloadTooLargeDesc')
    // 原始报文仍然保留在 details 里，便于排查
    expect(info.details).toBe('http: request body too large')
    // 这是「可恢复但需用户介入」的情况，不该标成致命错误
    expect(info.severity).toBe('warning')
  })

  it('keeps the generic API error path for other status codes', () => {
    const info = getErrorInfo(apiError({ statusCode: 500 }), t)
    expect(info.title).toContain('apiErrorWithCode')
    expect(info.title).toContain('500')
    expect(info.details).toBeUndefined()
  })

  it('falls back to a plain API error when there is no status code', () => {
    const info = getErrorInfo(apiError(), t)
    expect(info.title).toBe('errors.apiError')
  })
})