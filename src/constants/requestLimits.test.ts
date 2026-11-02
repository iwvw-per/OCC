import { describe, expect, it } from 'vitest'
import {
  BASE64_OVERHEAD_RATIO,
  MAX_ATTACHMENT_BYTES,
  PROMPT_BODY_STRUCTURAL_BYTES,
  REQUEST_BODY_MAX_BYTES,
  REQUEST_BODY_WARN_BYTES,
  REQUEST_TIMEOUT_MAX_MS,
  REQUEST_TIMEOUT_MIN_MS,
  dataUrlByteLength,
  estimatePromptBody,
  estimateUtf8Bytes,
  formatRequestBytes,
  timeoutForBodyBytes,
} from './requestLimits'

/**
 * 请求体体积上限与估算。
 *
 * 数值来自 2026-11-02 对真实网关的实测（工作主机 inst_04ae749b…）：
 *   POST /api/aiagent/gw/{id}/api/session/{sid}/prompt
 *   66,659 B → 200；8,186,169 B → 200（19s）；14,325,771 B → 413
 *   413 响应体：{"code":"AIAGENT_INVALID","error":"request body exceeds 8388608 bytes"}
 *
 * 这组测试锁住三件事：
 *   1. 上限常量就是实测的 8388608，不允许被「大概 16MB」之类的印象改回去；
 *   2. 附件单文件上限经 base64 膨胀后仍低于上限（否则「选得进去发不出去」）；
 *   3. 体积估算对中文按 UTF-8 计（1 个汉字 3 字节），不能用 length 凑数。
 */

describe('requestLimits constants', () => {
  it('uses the measured 8MiB gateway limit', () => {
    expect(REQUEST_BODY_MAX_BYTES).toBe(8_388_608)
  })

  it('keeps the warn line below the hard limit so it can actually fire', () => {
    expect(REQUEST_BODY_WARN_BYTES).toBeLessThan(REQUEST_BODY_MAX_BYTES)
  })

  it('keeps a single attachment under the limit even after base64 expansion', () => {
    // 附件以 data URL 进入请求体，base64 会放大 4/3；再加上正文与结构开销仍需留余量
    expect(MAX_ATTACHMENT_BYTES * BASE64_OVERHEAD_RATIO).toBeLessThan(REQUEST_BODY_MAX_BYTES)
  })
})

describe('estimateUtf8Bytes', () => {
  it('counts ASCII as one byte each', () => {
    expect(estimateUtf8Bytes('hello')).toBe(5)
  })

  it('counts CJK as three bytes each', () => {
    expect(estimateUtf8Bytes('女书')).toBe(6)
  })

  it('counts surrogate pairs as four bytes', () => {
    expect(estimateUtf8Bytes('🙂')).toBe(4)
  })

  it('matches TextEncoder for mixed content', () => {
    const sample = '第一 4.1 和 4.4 别写重了 🙂\nnext line'
    expect(estimateUtf8Bytes(sample)).toBe(new TextEncoder().encode(sample).length)
  })
})

describe('estimatePromptBody', () => {
  it('adds the structural overhead', () => {
    expect(estimatePromptBody('').totalBytes).toBe(PROMPT_BODY_STRUCTURAL_BYTES)
  })

  it('does not flag small messages', () => {
    const est = estimatePromptBody('你好')
    expect(est.exceedsLimit).toBe(false)
    expect(est.nearLimit).toBe(false)
    expect(est.textBytes).toBe(6)
  })

  it('flags bodies just above the measured limit', () => {
    // 纯 ASCII 便于精确构造：上限 - 结构开销 + 1 字节
    const chars = REQUEST_BODY_MAX_BYTES - PROMPT_BODY_STRUCTURAL_BYTES + 1
    const est = estimatePromptBody('x'.repeat(chars))
    expect(est.exceedsLimit).toBe(true)
  })

  it('does not flag a body exactly at the limit (limit is inclusive)', () => {
    const chars = REQUEST_BODY_MAX_BYTES - PROMPT_BODY_STRUCTURAL_BYTES
    expect(estimatePromptBody('x'.repeat(chars)).exceedsLimit).toBe(false)
  })

  it('counts attachment bytes so a big attachment trips the limit', () => {
    const dataUrl = `data:text/plain;base64,${'A'.repeat(REQUEST_BODY_MAX_BYTES)}`
    const est = estimatePromptBody('hi', [dataUrl])
    expect(est.attachmentBytes).toBeGreaterThan(REQUEST_BODY_MAX_BYTES)
    expect(est.exceedsLimit).toBe(true)
  })
})

describe('dataUrlByteLength', () => {
  it('decodes base64 payload length', () => {
    // "hello" = 5 bytes → base64 "aGVsbG8="
    expect(dataUrlByteLength('data:text/plain;base64,aGVsbG8=')).toBe(5)
  })

  it('returns 0 for non-data URLs', () => {
    expect(dataUrlByteLength('file:///tmp/a.txt')).toBe(0)
    expect(dataUrlByteLength(undefined)).toBe(0)
  })
})

describe('timeoutForBodyBytes', () => {
  it('keeps the base timeout for small bodies', () => {
    expect(timeoutForBodyBytes(100 * 1024)).toBe(REQUEST_TIMEOUT_MIN_MS)
    expect(timeoutForBodyBytes(1024 * 1024)).toBe(REQUEST_TIMEOUT_MIN_MS)
  })

  it('grows with body size and never exceeds the cap', () => {
    const at5MiB = timeoutForBodyBytes(5 * 1024 * 1024)
    expect(at5MiB).toBeGreaterThan(REQUEST_TIMEOUT_MIN_MS)
    // 实测 8.19MB 用了 19s，放宽后的超时必须明显大于它
    expect(timeoutForBodyBytes(8.19 * 1024 * 1024)).toBeGreaterThan(19_000)
    expect(timeoutForBodyBytes(500 * 1024 * 1024)).toBe(REQUEST_TIMEOUT_MAX_MS)
  })
})

describe('formatRequestBytes', () => {
  it('renders MB above 1MiB and KB below', () => {
    expect(formatRequestBytes(8 * 1024 * 1024)).toBe('8.0 MB')
    expect(formatRequestBytes(512 * 1024)).toBe('512 KB')
  })
})
