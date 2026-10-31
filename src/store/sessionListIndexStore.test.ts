import { beforeEach, describe, expect, it } from 'vitest'
import { sessionListIndexStore, type SessionListBucketKey } from './sessionListIndexStore'

function makeSession(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    slug: id,
    projectID: 'project-1',
    directory: '/workspace/demo',
    title: `Session ${id}`,
    version: '1',
    time: { created: 1, updated: 2 },
    ...overrides,
  } as never
}

const active: SessionListBucketKey = { serverId: 'srv-a', directory: '/workspace/demo', view: 'active' }
const archived: SessionListBucketKey = { serverId: 'srv-a', directory: '/workspace/demo', view: 'archived' }
const globalActive: SessionListBucketKey = { serverId: 'srv-a', directory: undefined, view: 'active' }

describe('sessionListIndexStore', () => {
  beforeEach(() => {
    sessionListIndexStore.reset()
  })

  it('reads back what was written and reports loaded limit', () => {
    sessionListIndexStore.replace(active, [makeSession('a'), makeSession('b')], { limit: 5, hasMore: true })

    expect(sessionListIndexStore.get(active)?.map(s => s.id)).toEqual(['a', 'b'])
    expect(sessionListIndexStore.getLoadedLimit(active)).toBe(5)
    expect(sessionListIndexStore.getHasMore(active)).toBe(true)
    expect(sessionListIndexStore.has(active)).toBe(true)
  })

  it('treats directories with different slash style as the same bucket', () => {
    sessionListIndexStore.replace(active, [makeSession('a')], { limit: 5, hasMore: false })

    const backslashKey: SessionListBucketKey = {
      serverId: 'srv-a',
      directory: '\\workspace\\demo\\',
      view: 'active',
    }

    expect(sessionListIndexStore.get(backslashKey)?.map(s => s.id)).toEqual(['a'])
  })

  it('does not create a bucket from events for a directory never loaded', () => {
    sessionListIndexStore.applySessionChanged('srv-a', makeSession('a'))

    expect(sessionListIndexStore.get(active)).toBeUndefined()
  })

  it('keeps pagination limit across reads', () => {
    sessionListIndexStore.replace(active, [makeSession('a')], { limit: 5, hasMore: true })
    sessionListIndexStore.setLoadedLimit(active, 15, false)

    expect(sessionListIndexStore.getLoadedLimit(active)).toBe(15)
    expect(sessionListIndexStore.getHasMore(active)).toBe(false)
  })

  it('migrates a session from active to archived bucket', () => {
    sessionListIndexStore.replace(active, [makeSession('a')], { limit: 5, hasMore: false })
    sessionListIndexStore.replace(archived, [], { limit: 5, hasMore: false })

    sessionListIndexStore.applySessionChanged('srv-a', makeSession('a', { time: { created: 1, updated: 3, archived: 99 } }))

    expect(sessionListIndexStore.get(active)).toEqual([])
    expect(sessionListIndexStore.get(archived)?.map(s => s.id)).toEqual(['a'])
  })

  it('migrates a restored session back to active bucket', () => {
    sessionListIndexStore.replace(active, [], { limit: 5, hasMore: false })
    sessionListIndexStore.replace(archived, [makeSession('a', { time: { created: 1, updated: 3, archived: 99 } })], {
      limit: 5,
      hasMore: false,
    })

    sessionListIndexStore.applySessionChanged('srv-a', makeSession('a', { time: { created: 1, updated: 4, archived: 0 } }))

    expect(sessionListIndexStore.get(active)?.map(s => s.id)).toEqual(['a'])
    expect(sessionListIndexStore.get(archived)).toEqual([])
  })

  it('does not resurrect an archived session via a stale active-bucket response (D3)', () => {
    sessionListIndexStore.replace(active, [makeSession('a')], { limit: 5, hasMore: false })
    // 记录归档前的成员版本，模拟一份「归档前发出、归档后返回」的列表响应
    const staleMembership = sessionListIndexStore.getMembershipRevision(active)

    // 会话归档：从 active 桶摘掉并记墓碑
    sessionListIndexStore.applySessionChanged('srv-a', makeSession('a', { time: { created: 1, updated: 3, archived: 99 } }))
    expect(sessionListIndexStore.get(active)).toEqual([])

    // 晚归响应仍带着这条会话，但成员版本已变 → replace 直接丢弃
    sessionListIndexStore.replace(active, [makeSession('a')], {
      limit: 5,
      hasMore: false,
      expectedMembershipRevision: staleMembership,
    })
    expect(sessionListIndexStore.get(active)).toEqual([])
  })

  it('ignores child sessions', () => {
    sessionListIndexStore.replace(active, [], { limit: 5, hasMore: false })

    sessionListIndexStore.applySessionChanged('srv-a', makeSession('child', { parentID: 'parent-1' }))

    expect(sessionListIndexStore.get(active)).toEqual([])
  })

  it('routes a session to the matching directory bucket only', () => {
    const other: SessionListBucketKey = { serverId: 'srv-a', directory: '/workspace/other', view: 'active' }
    sessionListIndexStore.replace(active, [], { limit: 5, hasMore: false })
    sessionListIndexStore.replace(other, [], { limit: 5, hasMore: false })

    sessionListIndexStore.applySessionChanged('srv-a', makeSession('a'))

    expect(sessionListIndexStore.get(active)?.map(s => s.id)).toEqual(['a'])
    expect(sessionListIndexStore.get(other)).toEqual([])
  })

  it('appends sessions to the global bucket regardless of directory', () => {
    sessionListIndexStore.replace(globalActive, [], { limit: 5, hasMore: false })

    sessionListIndexStore.applySessionChanged('srv-a', makeSession('a', { directory: '/anywhere' }))

    expect(sessionListIndexStore.get(globalActive)?.map(s => s.id)).toEqual(['a'])
  })

  it('does not let a late response resurrect a deleted session', () => {
    sessionListIndexStore.replace(active, [makeSession('a'), makeSession('b')], { limit: 5, hasMore: false })

    sessionListIndexStore.applyDeleted('srv-a', 'a')

    // 晚归的整桶响应把它带回来，但墓碑挡下
    sessionListIndexStore.replace(active, [makeSession('a'), makeSession('b')], { limit: 5, hasMore: false })

    expect(sessionListIndexStore.get(active)?.map(s => s.id)).toEqual(['b'])
  })

  it('discards a response whose membership changed while in flight', () => {
    sessionListIndexStore.replace(active, [makeSession('a')], { limit: 5, hasMore: false })
    const expected = sessionListIndexStore.getMembershipRevision(active)

    // 期间发生删除
    sessionListIndexStore.applyDeleted('srv-a', 'a')

    // 晚归响应携带旧 revision，应被丢弃
    sessionListIndexStore.replace(active, [makeSession('a'), makeSession('b')], {
      limit: 5,
      hasMore: false,
      expectedMembershipRevision: expected,
    })

    expect(sessionListIndexStore.get(active)).toEqual([])
  })

  it('clears tombstones after a successful full replace', () => {
    sessionListIndexStore.replace(active, [makeSession('a')], { limit: 5, hasMore: false })
    sessionListIndexStore.applyDeleted('srv-a', 'a')
    // 新一轮全量：服务端确认它已不存在
    sessionListIndexStore.replace(active, [], { limit: 5, hasMore: false })
    // 墓碑已清，随后事件可以重新加入
    sessionListIndexStore.applySessionChanged('srv-a', makeSession('a'))

    expect(sessionListIndexStore.get(active)?.map(s => s.id)).toEqual(['a'])
  })

  it('drops all buckets of a removed server', () => {
    sessionListIndexStore.replace(active, [makeSession('a')], { limit: 5, hasMore: false })
    sessionListIndexStore.replace(
      { serverId: 'srv-b', directory: '/workspace/demo', view: 'active' },
      [makeSession('b')],
      { limit: 5, hasMore: false },
    )

    sessionListIndexStore.dropServer('srv-a')

    expect(sessionListIndexStore.get(active)).toBeUndefined()
    expect(sessionListIndexStore.get({ serverId: 'srv-b', directory: '/workspace/demo', view: 'active' })).toHaveLength(1)
  })

  it('notifies subscribers on change', () => {
    let calls = 0
    const unsubscribe = sessionListIndexStore.subscribe(() => {
      calls++
    })

    sessionListIndexStore.replace(active, [makeSession('a')], { limit: 5, hasMore: false })
    expect(calls).toBe(1)

    unsubscribe()
    sessionListIndexStore.replace(active, [], { limit: 5, hasMore: false })
    expect(calls).toBe(1)
  })

  it('caps sessions per bucket', () => {
    const many = Array.from({ length: 520 }, (_, i) => makeSession(`s${i}`))
    sessionListIndexStore.replace({ serverId: 'srv-x', directory: '/big', view: 'active' }, many, {
      limit: 600,
      hasMore: false,
    })

    expect(sessionListIndexStore.get({ serverId: 'srv-x', directory: '/big', view: 'active' })?.length).toBe(500)
  })

  it('accepts incremental events after an empty-but-loaded replace (D15)', () => {
    // 空列表是合法的「已加载但为空」（如归档面板当前无归档会话）
    sessionListIndexStore.replace(active, [], { limit: 0, hasMore: false })

    // 此后的增量不应被丢弃
    sessionListIndexStore.applySessionChanged('srv-a', makeSession('a'))

    expect(sessionListIndexStore.get(active)?.map(s => s.id)).toEqual(['a'])
  })

  it('still ignores events for a bucket that was never loaded (D15)', () => {
    // 未加载过：单条事件不建桶
    sessionListIndexStore.applySessionChanged('srv-a', makeSession('a'))

    expect(sessionListIndexStore.get(active)).toBeUndefined()
  })

  /**
   * 归档写在 `session.metadata.updated` 上，该事件只带 metadata，没有 location。
   * 事件目录为空时，按目录过滤会把整条增量跳过 —— 归档的会话留在活跃列表，
   * 恢复的不回来，要等整桶重拉（刷新）才同步。
   */
  it('applies an event without directory by falling back to the known entry directory', () => {
    sessionListIndexStore.replace(active, [makeSession('a')], { limit: 5, hasMore: false })
    // 归档桶必须先「已加载」才会接收迁移（未加载的桶不建条目，等面板自己拉）
    sessionListIndexStore.replace(archived, [], { limit: 0, hasMore: false })

    sessionListIndexStore.applySessionChanged(
      'srv-a',
      makeSession('a', { directory: '', time: { created: 1, updated: 3, archived: 99 } }),
    )

    expect(sessionListIndexStore.get(active)?.map(s => s.id)).toEqual([])
    expect(sessionListIndexStore.get(archived)?.map(s => s.id)).toEqual(['a'])
  })

  /**
   * 增量 payload 常是残缺对象（只带变更字段）。整条替换会把 time.archived
   * 与 directory 冲掉，表现为「归档不生效、标题再也不更新」。
   */
  it('merges partial payloads instead of overwriting known fields', () => {
    sessionListIndexStore.replace(active, [makeSession('a')], { limit: 5, hasMore: false })
    sessionListIndexStore.replace(archived, [], { limit: 0, hasMore: false })

    // 只带 metadata 的事件（目录、标题都不带）
    sessionListIndexStore.applySessionChanged('srv-a', {
      id: 'a',
      time: { archived: 99 },
    } as never)

    const archivedItem = sessionListIndexStore.get(archived)?.[0] as unknown as {
      directory?: string
      title?: string
      time?: { created?: number; archived?: number }
    }
    expect(archivedItem?.directory).toBe('/workspace/demo')
    expect(archivedItem?.title).toBe('Session a')
    expect(archivedItem?.time?.created).toBe(1)
    expect(archivedItem?.time?.archived).toBe(99)
  })

  it('keeps the sibling time fields when patching a rename or archive in place', () => {
    sessionListIndexStore.replace(active, [makeSession('a', { time: { created: 1, updated: 2, idle: 7 } })], {
      limit: 5,
      hasMore: false,
    })

    sessionListIndexStore.patchAll('srv-a', 'a', { time: { archived: 42 } } as never)

    const item = sessionListIndexStore.get(active)?.[0] as unknown as { time?: Record<string, number> }
    expect(item?.time?.idle).toBe(7)
    expect(item?.time?.archived).toBe(42)
    expect(item?.time?.created).toBe(1)
  })
})
