import { beforeEach, describe, expect, it } from 'vitest'
import {
  contextWindowKey,
  looksLikeContextOverflow,
  observedWindow,
  recordContextOverflow,
  resetObservedWindows,
  resolveContextWindow,
} from './contextWindowObservation'

beforeEach(() => {
  localStorage.clear()
  resetObservedWindows()
})

describe('contextWindowKey', () => {
  it('按 server + provider + model 组合', () => {
    expect(contextWindowKey('local', 'dsukhub', 'deepseek-v4.1-flash')).toBe('local|dsukhub|deepseek-v4.1-flash')
  })

  it('缺少 provider 或 model 时返回 null（无法定位窗口）', () => {
    expect(contextWindowKey('local', '', 'm')).toBeNull()
    expect(contextWindowKey('local', 'p', '')).toBeNull()
    expect(contextWindowKey('local', undefined, undefined)).toBeNull()
  })

  it('serverId 缺省时用 local', () => {
    expect(contextWindowKey(undefined, 'p', 'm')).toBe('local|p|m')
  })
})

describe('looksLikeContextOverflow', () => {
  it('识别常见的上下文超长文案', () => {
    expect(looksLikeContextOverflow("This model's maximum context length is 128000 tokens")).toBe(true)
    expect(looksLikeContextOverflow('prompt is too long: 200000 tokens > 128000 maximum')).toBe(true)
    expect(looksLikeContextOverflow('Input is too long for requested model')).toBe(true)
    expect(looksLikeContextOverflow('Prompt 超长')).toBe(true)
  })

  it('不把请求体体积超限当成上下文超限', () => {
    // 网关 8MiB 是「请求体字节数」上限：一张大图就能触发，token 远未触顶。
    // 用它当窗口上界会把分母压小，圆环反而虚高。
    expect(looksLikeContextOverflow('http: request body too large')).toBe(false)
    expect(looksLikeContextOverflow('request entity too large')).toBe(false)
    expect(looksLikeContextOverflow('413 Request Entity Too Large')).toBe(false)
  })

  it('普通错误不误判', () => {
    expect(looksLikeContextOverflow('rate limit exceeded')).toBe(false)
    expect(looksLikeContextOverflow(undefined)).toBe(false)
    expect(looksLikeContextOverflow('')).toBe(false)
  })
})

describe('recordContextOverflow / resolveContextWindow', () => {
  const KEY = 'local|p|m'

  it('首次观测直接生效', () => {
    expect(recordContextOverflow(KEY, 130_000)).toBe(true)
    expect(observedWindow(KEY)).toBe(130_000)
  })

  it('只在更小的观测上更新（上界越收越紧）', () => {
    recordContextOverflow(KEY, 130_000)
    expect(recordContextOverflow(KEY, 200_000)).toBe(false)
    expect(observedWindow(KEY)).toBe(130_000)
    expect(recordContextOverflow(KEY, 120_000)).toBe(true)
    expect(observedWindow(KEY)).toBe(120_000)
  })

  it('非法用量不记录', () => {
    expect(recordContextOverflow(KEY, 0)).toBe(false)
    expect(recordContextOverflow(KEY, -5)).toBe(false)
    expect(recordContextOverflow(KEY, Number.NaN)).toBe(false)
    expect(recordContextOverflow(null, 1000)).toBe(false)
    expect(observedWindow(KEY)).toBe(0)
  })

  it('声明值偏大时收敛到观测上界（复现「显示 60% 其实满了」）', () => {
    // 站点配置把窗口写死 1,000,000；真实窗口约 128k，溢出时实测 130k
    recordContextOverflow(KEY, 130_000)
    expect(resolveContextWindow(1_000_000, KEY)).toBe(130_000)
    // 收敛后百分比才反映真实水位
    expect((130_000 / resolveContextWindow(1_000_000, KEY)) * 100).toBe(100)
  })

  it('声明值准确时不被放大', () => {
    recordContextOverflow(KEY, 500_000)
    expect(resolveContextWindow(200_000, KEY)).toBe(200_000)
  })

  it('声明值未知时用观测值', () => {
    recordContextOverflow(KEY, 64_000)
    expect(resolveContextWindow(0, KEY)).toBe(64_000)
  })

  it('两者都未知时返回 0（调用方不得显示百分比）', () => {
    expect(resolveContextWindow(0, KEY)).toBe(0)
    expect(resolveContextWindow(0, null)).toBe(0)
  })

  it('观测按模型隔离', () => {
    recordContextOverflow('local|p|m1', 100_000)
    expect(observedWindow('local|p|m2')).toBe(0)
    expect(resolveContextWindow(1_000_000, 'local|p|m2')).toBe(1_000_000)
  })

  it('观测跨刷新保留（写进 localStorage）', () => {
    recordContextOverflow(KEY, 96_000)
    const raw = localStorage.getItem('opencode-context-window-observed')
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw!)[KEY]).toBe(96_000)
  })
})
