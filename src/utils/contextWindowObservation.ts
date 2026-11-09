// ============================================
// 上下文窗口的「实测上界」收敛
// ============================================
//
// 背景：圆环的分母取自模型声明的 `limit`。声明值可以是错的 —— 实测有站点
// 把所有模型统一声明成 `context: 1000000`，而真实窗口远小于此。此时
//
//   - 圆环百分比长期偏低，看起来「一直不涨」；
//   - 服务端也按同一个声明窗口算压缩触发线，于是「明明快满了却不压缩」。
//
// 前端无法凭空知道真实窗口，但**有一个硬证据**：provider 返回上下文溢出错误
// （prompt is too long / exceeds context window / 413 …）时，当时的 prompt 用量
// 一定 ≥ 真实窗口。把这个用量记为「上界」，取
//
//   effective = min(声明窗口, 观测上界)
//
// 就能在**第一次真实溢出之后**把分母收敛到接近真值。只降不升（上界只会被
// 更小的证据刷新），因此不会因为一次异常值把分母放大。
//
// 溢出错误同时会让服务端自动压缩（`recoverOverflow`），所以这个观测往往
// 与一次压缩同时发生 —— 压缩后用量骤降，分母却已经收敛，圆环立刻变准。
//
// 纯函数 + localStorage，便于单测；不依赖 React / store。

const STORAGE_KEY = 'opencode-context-window-observed'

/** 观测键：同一后端同一模型共享（窗口是模型属性，与会话无关）。 */
export type WindowKey = string

export function contextWindowKey(
  serverId: string | undefined,
  providerId: string | undefined,
  modelId: string | undefined,
): WindowKey | null {
  const provider = (providerId ?? '').trim()
  const model = (modelId ?? '').trim()
  if (!provider || !model) return null
  return `${serverId ?? 'local'}|${provider}|${model}`
}

/**
 * provider 报「上下文溢出」时的错误文案特征。
 *
 * 与服务端 `packages/ai/src/provider-error.ts` 的 `patterns` 同源，只保留
 * 最常见的几条。
 *
 * ⚠️ 刻意**不**包含 `request entity too large` / `request body too large` /
 * 413：那是网关的**请求体体积**上限（8MiB），与模型的上下文窗口是两回事。
 * 一张大图就可能让 body 超限，而 token 数远未触顶 —— 用它当窗口上界会把
 * 分母错误地压小。
 */
const OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length/i,
  /exceeds the context window/i,
  /maximum context length is \d+/i,
  /context[_ ]length[_ ]exceeded/i,
  /input token count.*exceeds the maximum/i,
  /prompt (?:too long|超长)/i,
  /too large for model with \d+ maximum context length/i,
]

/** 该错误文案是否表示上下文/请求体溢出。 */
export function looksLikeContextOverflow(message: string | undefined | null): boolean {
  if (!message) return false
  return OVERFLOW_PATTERNS.some(pattern => pattern.test(message))
}

type ObservedMap = Record<string, number>

let cache: ObservedMap | null = null
const subscribers = new Set<() => void>()
let version = 0

function load(): ObservedMap {
  if (cache) return cache
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    const result: ObservedMap = {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) result[key] = value
      }
    }
    cache = result
    return result
  } catch {
    cache = {}
    return cache
  }
}

function persist(next: ObservedMap) {
  cache = next
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 配额受限：内存里的观测仍然生效，只是不跨刷新
  }
  version += 1
  subscribers.forEach(cb => cb())
}

/**
 * 记录一次溢出观测。
 *
 * `usedTokens` 是溢出发生时**已知的 prompt 用量**（取最近一次实测值）。
 * 它给出真实窗口的上界，因此只在比已记录值更小时更新 —— 上界要越收越紧。
 * 返回是否发生了变化。
 */
export function recordContextOverflow(key: WindowKey | null, usedTokens: number): boolean {
  if (!key) return false
  if (!Number.isFinite(usedTokens) || usedTokens <= 0) return false
  const current = load()
  const prev = current[key]
  if (prev !== undefined && prev <= usedTokens) return false
  persist({ ...current, [key]: Math.round(usedTokens) })
  return true
}

/** 已观测到的窗口上界；没有则返回 0。 */
export function observedWindow(key: WindowKey | null): number {
  if (!key) return 0
  return load()[key] ?? 0
}

/**
 * 最终使用的窗口：声明值与观测上界取较小者。
 *
 * - 声明值未知（<= 0）：直接用观测值（有证据比没有强）；
 * - 两者都有：取 min，观测只会收紧分母；
 * - 都没有：返回 0，表示未知，调用方不得显示百分比。
 */
export function resolveContextWindow(declared: number, key: WindowKey | null): number {
  const observed = observedWindow(key)
  const safeDeclared = Number.isFinite(declared) && declared > 0 ? declared : 0
  if (observed > 0 && safeDeclared > 0) return Math.min(safeDeclared, observed)
  if (observed > 0) return observed
  return safeDeclared
}

export function subscribeObservedWindow(cb: () => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}

export function observedWindowVersion(): number {
  return version
}

/** 测试/切服务器用：清空观测。 */
export function resetObservedWindows(): void {
  persist({})
}
