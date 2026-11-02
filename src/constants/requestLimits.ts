// ============================================
// 请求体体积上限（发送前的可判别事实）
// ============================================
//
// 背景（2026-11-02 实测，工作主机 64.181.246.5 / inst_04ae749b…）：
// `POST {domain}/api/aiagent/gw/{id}/api/session/{sid}/prompt` 的请求体上限是
// **8 MiB（8388608 字节，含 JSON 外壳）**，超出即返回
//
//     HTTP 413 {"code":"AIAGENT_INVALID","error":"request body exceeds 8388608 bytes"}
//
// 实测分档（同一份纯中文正文，经真实网关）：
//
//   66,659 B → 200 / 1.2s
//   515,147 B → 200 / 4.4s
//   2,046,567 B → 200 / 8.3s
//   8,186,169 B → 200 / 19.0s   ← 已逼近 30s 客户端超时
//   14,325,771 B → 413 / 0.1s
//
// 两个直接后果，本文件的常量就是为此存在：
//   1. 超限必然失败，且 SDK 把它当「未声明的状态码」抛出，界面上看不出原因；
//   2. 接近上限的请求耗时线性增长，和 `API_REQUEST_TIMEOUT_MS`（30s）撞车，
//      表现为「有时候发得出去、有时候没反应」。
// ============================================

/** 网关请求体硬上限（实测值，不是估算）。 */
export const REQUEST_BODY_MAX_BYTES = 8 * 1024 * 1024

/**
 * 发送前的「预警线」。
 *
 * 取上限的 3/4：留出 JSON 结构、字段名、工具定义等我们无法精确计入的开销，
 * 也给上行链路抖动留时间余量。超过它仍可发送，但会提示用户体积偏大。
 */
export const REQUEST_BODY_WARN_BYTES = 6 * 1024 * 1024

/**
 * 附件选择阶段的单文件上限。
 *
 * 附件以 data URL 进入请求体，base64 相对原始字节膨胀 4/3。要让一个附件
 * 单独就不超上限：8MiB ÷ 4/3 ≈ 6MiB，再留出正文与结构的余量，取 5.5MiB。
 *
 * ⚠️ 此前的 20MB 是纯错误值：6.1MB 的文件 base64 后就已经超过 8MiB 上限，
 * 「选得进去」和「发得出去」是两件事。
 */
export const MAX_ATTACHMENT_BYTES = Math.floor(5.5 * 1024 * 1024)
export const MAX_ATTACHMENT_LABEL = `${(MAX_ATTACHMENT_BYTES / (1024 * 1024)).toFixed(1)}MB`

/** base64 相对原始字节的体积倍率（4/3，向上取整到 1/3 的精度足够）。 */
export const BASE64_OVERHEAD_RATIO = 4 / 3

/**
 * v2 prompt 请求体的固定开销估算（字节）。
 *
 * 覆盖 `{sessionID, id, text, files:[{uri,name}], agents, delivery}` 这些字段名、
 * JSON 标点，以及网关侧附加的少量头/包装。取 4KB：对 8MiB 的量级可以忽略，
 * 但能保证「刚好卡在边界」的场景判到正确的一侧。
 */
export const PROMPT_BODY_STRUCTURAL_BYTES = 4 * 1024

/**
 * 发送 / 读取类大请求的超时下限（毫秒）。
 *
 * 常规请求沿用 30s（`API_REQUEST_TIMEOUT_MS`）；prompt 这类可能上传数 MB 的
 * 请求按体积放大超时，否则实测 8.19MB / 19s 的链路稍微抖一下就会超时，
 * 而超时的表现是「点了发送什么也没发生」。
 */
export const REQUEST_TIMEOUT_MIN_MS = 30_000
/** 每 MiB 额外放宽的超时（毫秒）：按实测 ~2.3s/MiB 留出约 2 倍余量。 */
export const REQUEST_TIMEOUT_PER_MIB_MS = 5_000
/** 超时上限（毫秒），防止异常体积把请求挂死在界面上。 */
export const REQUEST_TIMEOUT_MAX_MS = 180_000

/** UTF-8 字节数（不分配 Buffer，纯计数，可安全在浏览器/Worker 中调用）。 */
export function estimateUtf8Bytes(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      // 配对的高位代理 + 低位代理 = 一个 4 字节码点
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

/** data URL 解码后的原始字节数；非 data URL 返回 0。 */
export function dataUrlByteLength(url: string | undefined): number {
  if (!url || !url.startsWith('data:')) return 0
  const comma = url.indexOf(',')
  if (comma === -1) return 0
  const meta = url.slice(0, comma)
  const payload = url.length - comma - 1
  if (!meta.includes(';base64')) return payload
  const padding = url.endsWith('==') ? 2 : url.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((payload * 3) / 4) - padding)
}

/** 一次 prompt 请求体的体积估算结果。 */
export interface PromptBodyEstimate {
  /** 估算的总字节数（含结构开销） */
  totalBytes: number
  /** 正文（text）占的字节数 */
  textBytes: number
  /** 附件经 base64 后占的字节数 */
  attachmentBytes: number
  /** 是否已经超过网关硬上限 */
  exceedsLimit: boolean
  /** 是否达到预警线（可发送但偏大） */
  nearLimit: boolean
}

/**
 * 估算一次 prompt 请求体大小。
 *
 * 只统计「可由前端确定」的部分：正文的 UTF-8 字节 + 附件 URL 的实际字节。
 * 服务端上下文（历史消息里的内联图片）不在其中 —— 那类超限由 413 兜底，
 * 见 features/chat/heavyContent.ts。
 */
export function estimatePromptBody(text: string, attachmentUrls: Array<string | undefined> = []): PromptBodyEstimate {
  const textBytes = estimateUtf8Bytes(text)
  let attachmentBytes = 0
  for (const url of attachmentUrls) attachmentBytes += url ? estimateUtf8Bytes(url) : 0
  const totalBytes = textBytes + attachmentBytes + PROMPT_BODY_STRUCTURAL_BYTES
  return {
    totalBytes,
    textBytes,
    attachmentBytes,
    exceedsLimit: totalBytes > REQUEST_BODY_MAX_BYTES,
    nearLimit: totalBytes > REQUEST_BODY_WARN_BYTES,
  }
}

/**
 * 按请求体体积推算超时（毫秒）。
 *
 * 小于 1MiB 的请求不值得特殊对待，直接用调用方的基准超时；
 * 之后每 MiB 增加 `REQUEST_TIMEOUT_PER_MIB_MS`，并在上限处截断。
 */
export function timeoutForBodyBytes(bodyBytes: number, baseMs: number = REQUEST_TIMEOUT_MIN_MS): number {
  const mib = bodyBytes / (1024 * 1024)
  if (mib <= 1) return baseMs
  const extra = Math.ceil(mib - 1) * REQUEST_TIMEOUT_PER_MIB_MS
  return Math.min(REQUEST_TIMEOUT_MAX_MS, baseMs + extra)
}

/** 人类可读体积（与 heavyContent 的格式保持一致，便于文案复用）。 */
export function formatRequestBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}
