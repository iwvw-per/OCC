import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  sessionActivityStore,
  getSessionAnchorTime,
  sortSessionsByAnchor,
  insertSessionByAnchor,
} from './sessionActivityStore'
import type { ApiSession } from '../api'

function makeSession(id: string, updated: number, created = updated): ApiSession {
  return {
    id,
    slug: id,
    projectID: 'p',
    directory: '/workspace/demo',
    title: id,
    version: '1',
    time: { created, updated },
  } as ApiSession
}

describe('sessionActivityStore', () => {
  beforeEach(() => {
    sessionActivityStore.reset()
    localStorage.removeItem('opencode-project-last-used')
  })

  it('records a session anchor and notifies subscribers', () => {
    const listener = vi.fn()
    sessionActivityStore.subscribe(listener)

    sessionActivityStore.recordActivity('s1', 100, '/workspace/demo', 'local')

    expect(sessionActivityStore.getSessionAnchor('s1')).toBe(100)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale (older) timestamp without notifying', () => {
    const listener = vi.fn()
    sessionActivityStore.recordActivity('s1', 100)
    sessionActivityStore.subscribe(listener)

    sessionActivityStore.recordActivity('s1', 50)

    expect(sessionActivityStore.getSessionAnchor('s1')).toBe(100)
    expect(listener).not.toHaveBeenCalled()
  })

  it('tracks the directory anchor as the max across sessions', () => {
    sessionActivityStore.recordActivity('s1', 100, '/workspace/demo', 'local')
    sessionActivityStore.recordActivity('s2', 200, '/workspace/demo', 'local')

    expect(sessionActivityStore.getDirectoryAnchor('local', '/workspace/demo')).toBe(200)

    // 旧会话的新活动也应抬高目录锚点
    sessionActivityStore.recordActivity('s1', 300, '/workspace/demo', 'local')
    expect(sessionActivityStore.getDirectoryAnchor('local', '/workspace/demo')).toBe(300)
  })

  it('normalizes slashes and trailing slash in the directory key', () => {
    sessionActivityStore.recordActivity('s1', 100, 'C:\\Work\\Demo\\', 'local')
    expect(sessionActivityStore.getDirectoryAnchor('local', 'C:/Work/Demo')).toBe(100)
  })

  it('getSessionAnchorTime falls back to session.time when no anchor', () => {
    expect(getSessionAnchorTime(makeSession('s1', 42))).toBe(42)

    sessionActivityStore.recordActivity('s1', 99)
    expect(getSessionAnchorTime(makeSession('s1', 42))).toBe(99)
  })

  it('sorts sessions by anchor descending (newest first)', () => {
    sessionActivityStore.recordActivity('a', 10)
    sessionActivityStore.recordActivity('b', 30)
    sessionActivityStore.recordActivity('c', 20)

    const sorted = sortSessionsByAnchor([makeSession('a', 1), makeSession('b', 1), makeSession('c', 1)])
    expect(sorted.map(s => s.id)).toEqual(['b', 'c', 'a'])
  })

  it('sorts by time.idle before time.updated (multi-device consistency)', () => {
    /**
     * 用户要求「多端顺序完全一致」。
     *
     * `time.updated` 会被 assistant 的每次流式输出持续抬高，两端在不同时刻
     * 拉到就得到不同数值 → 同一批会话在两端排出不同顺序。`time.idle` 是
     * 一轮结束的权威时间，一轮内不变，因此两端读到同一个值。
     *
     * 这里构造一个典型分歧：A 的 updated 更晚（还在流式），但 idle 更早；
     * B 的 updated 更早，但 idle 更晚。按 idle 排 B 应当在前。
     */
    const a = { ...makeSession('a', 100), time: { created: 1, updated: 900, idle: 100 } }
    const b = { ...makeSession('b', 200), time: { created: 1, updated: 500, idle: 800 } }

    const sorted = sortSessionsByAnchor([a, b])

    // 按 updated 会得到 [a, b]；按 idle 必须是 [b, a]
    expect(sorted.map(s => s.id)).toEqual(['b', 'a'])
  })

  it('falls back to time.updated when idle is missing (never ran a full turn)', () => {
    const a = { ...makeSession('a', 100), time: { created: 1, updated: 100 } }
    const b = { ...makeSession('b', 200), time: { created: 1, updated: 200 } }

    const sorted = sortSessionsByAnchor([a, b])
    expect(sorted.map(s => s.id)).toEqual(['b', 'a'])
  })

  it('uses a stable id tie-break for equal anchors', () => {
    const sorted = sortSessionsByAnchor([makeSession('c', 5), makeSession('a', 5), makeSession('b', 5)])
    expect(sorted.map(s => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('inserts a new session by anchor order', () => {
    sessionActivityStore.recordActivity('a', 10)
    sessionActivityStore.recordActivity('c', 30)
    sessionActivityStore.recordActivity('m', 20)

    let list = sortSessionsByAnchor([makeSession('a', 1), makeSession('c', 1)])
    list = insertSessionByAnchor(list, makeSession('m', 1))
    expect(list.map(s => s.id)).toEqual(['c', 'm', 'a'])
  })

  it('does not mutate the input array', () => {
    const input = [makeSession('a', 1), makeSession('b', 2)]
    const snapshot = input.map(s => s.id)
    sortSessionsByAnchor(input)
    expect(input.map(s => s.id)).toEqual(snapshot)
  })

  // ---- 跨端水位 opencode-project-last-used ----

  const WATERMARK_KEY = 'opencode-project-last-used'

  it('persists a bare-key watermark when recording directory activity', () => {
    sessionActivityStore.recordActivity('s1', 100, '/workspace/demo', 'local')

    expect(JSON.parse(localStorage.getItem(WATERMARK_KEY) ?? '{}')).toEqual({ '/workspace/demo': 100 })
    expect(sessionActivityStore.getProjectLastUsed('/workspace/demo')).toBe(100)
  })

  it('watermark only ever rises (monotonic)', () => {
    sessionActivityStore.recordActivity('s1', 200, '/workspace/demo', 'local')
    sessionActivityStore.recordActivity('s2', 100, '/workspace/demo', 'local')

    expect(sessionActivityStore.getProjectLastUsed('/workspace/demo')).toBe(200)
  })

  it('getDirectoryAnchor takes the max of local bucket and cross-device watermark', () => {
    // 本机分桶锚点（local 前缀）
    sessionActivityStore.recordActivity('s1', 300, '/workspace/demo', 'local')
    // 模拟另一端 pull 到更高值写入裸键
    localStorage.setItem(WATERMARK_KEY, JSON.stringify({ '/workspace/demo': 900 }))
    sessionActivityStore.reload()

    expect(sessionActivityStore.getDirectoryAnchor('local', '/workspace/demo')).toBe(900)
  })

  it('prefers the local bucket when it is higher, but reload never lowers the watermark', () => {
    // 本机分桶锚点 300 高于外部水位 100
    sessionActivityStore.recordActivity('s1', 300, '/workspace/demo', 'local')
    localStorage.setItem(WATERMARK_KEY, JSON.stringify({ '/workspace/demo': 100 }))
    sessionActivityStore.reload()

    expect(sessionActivityStore.getDirectoryAnchor('local', '/workspace/demo')).toBe(300)
    // 内存水位只增不降：外部较低值不会把它压低
    expect(sessionActivityStore.getProjectLastUsed('/workspace/demo')).toBe(300)
  })

  it('recovers a directory anchor from the watermark without a local bucket', () => {
    localStorage.setItem(WATERMARK_KEY, JSON.stringify({ '/workspace/fresh': 777 }))
    sessionActivityStore.reload()

    // 新设备冷启动：本机无锚点，靠水位恢复（不依赖 time.updated 兜底）
    expect(sessionActivityStore.getDirectoryAnchor('local', '/workspace/fresh')).toBe(777)
  })

  it('normalizes case and slashes for the watermark key (D29)', () => {
    // 服务端返回的目录与用户保存的 worktree 大小写/斜杠可能不同
    sessionActivityStore.recordActivity('s1', 100, 'C:\\Work\\Demo', 'local')

    expect(sessionActivityStore.getDirectoryAnchor('local', 'c:/work/demo')).toBe(100)
    expect(sessionActivityStore.getProjectLastUsed('C:/WORK/DEMO')).toBe(100)
  })

  it('matches the watermark written by another device regardless of path casing', () => {
    localStorage.setItem(WATERMARK_KEY, JSON.stringify({ 'c:/work/demo': 900 }))
    sessionActivityStore.reload()

    expect(sessionActivityStore.getDirectoryAnchor('local', 'C:\\Work\\Demo')).toBe(900)
  })

  it('reload merges external watermarks by max, never lowering in-memory values', () => {
    sessionActivityStore.recordActivity('s1', 500, '/workspace/demo', 'local')
    // 外部写入较低值 + 一个新目录
    localStorage.setItem(WATERMARK_KEY, JSON.stringify({ '/workspace/demo': 100, '/workspace/other': 400 }))
    sessionActivityStore.reload()

    expect(sessionActivityStore.getProjectLastUsed('/workspace/demo')).toBe(500)
    expect(sessionActivityStore.getProjectLastUsed('/workspace/other')).toBe(400)
  })

  it('reload does not notify when nothing changed', () => {
    const listener = vi.fn()
    sessionActivityStore.subscribe(listener)
    sessionActivityStore.reload()
    expect(listener).not.toHaveBeenCalled()
  })
})
