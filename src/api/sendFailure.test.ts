import { describe, expect, it } from 'vitest'
import { describeSendFailure } from './sendFailure'

/**
 * 发送失败 → 用户可读提示的映射。
 *
 * 错误对象形状取自 `@opencode/client` 的实现：
 *   - 413：responseError() → ClientError('UnexpectedStatus', { cause: { status: 413 }, detail: '413' })
 *   - 超时：fetch 抛 AbortError → ClientError('Transport', { cause: AbortError })
 *   - 断网：fetch 抛 TypeError → ClientError('Transport', { cause: TypeError })
 */
describe('describeSendFailure', () => {
  it('maps a 413 to the request-body-limit explanation', () => {
    const err = Object.assign(new Error('UnexpectedStatus: 413'), {
      reason: 'UnexpectedStatus',
      cause: { status: 413 },
    })
    const d = describeSendFailure(err)
    expect(d.titleKey).toBe('errors.sendTooLargeTitle')
    expect(d.params.limit).toBe('8.0 MB')
  })

  it('maps the gateway message text when the status is not surfaced', () => {
    const d = describeSendFailure(new Error('{"error":"request body exceeds 8388608 bytes"}'))
    expect(d.titleKey).toBe('errors.sendTooLargeTitle')
  })

  it('maps a timeout to the timeout explanation', () => {
    const err = Object.assign(new Error('Transport: API request timed out'), { reason: 'Transport' })
    const d = describeSendFailure(err)
    expect(d.bodyKey).toBe('errors.sendTimeoutDesc')
    expect(d.params.seconds).toBe(180)
  })

  it('maps other transport failures to the network explanation', () => {
    const err = Object.assign(new Error('Transport: Failed to fetch'), { reason: 'Transport' })
    const d = describeSendFailure(err)
    expect(d.bodyKey).toBe('errors.sendNetworkDesc')
  })

  it('falls back to a generic explanation for unknown errors', () => {
    const d = describeSendFailure(new Error('boom'))
    expect(d.bodyKey).toBe('errors.sendUnknownDesc')
    expect(d.params.detail).toBe('boom')
  })

  it('never throws on non-Error inputs', () => {
    expect(describeSendFailure(undefined).bodyKey).toBe('errors.sendUnknownDesc')
    expect(describeSendFailure('boom').bodyKey).toBe('errors.sendUnknownDesc')
  })
})
