/**
 * sessionListIndexStore.invalidateArchivedView
 *
 * 归档动作只把会话从活跃桶摘掉；归档桶一旦加载过就会一直用旧快照，
 * 表现为「归档后必须刷新页面才能在已归档面板看到」。
 * 这里固定「归档态变化 → 归档桶过期」的行为。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { sessionListIndexStore, type SessionListBucketKey } from './sessionListIndexStore'
import type { ApiSession } from '../api/types'

const SERVER = 'srv-1'

function makeSession(id: string, opts: { archived?: number; directory?: string } = {}): ApiSession {
  return {
    id,
    slug: id,
    projectID: 'p',
    directory: opts.directory ?? '/repo',
    title: id,
    version: '2',
    time: { created: 1, updated: 2, archived: opts.archived },
  } as ApiSession
}

const archivedBucket: SessionListBucketKey = { serverId: SERVER, directory: undefined, view: 'archived' }
const activeBucket: SessionListBucketKey = { serverId: SERVER, directory: undefined, view: 'active' }

beforeEach(() => {
  sessionListIndexStore.reset()
})

describe('invalidateArchivedView', () => {
  it('把已加载的归档桶标为过期，但保留条目', () => {
    sessionListIndexStore.replace(archivedBucket, [makeSession('a', { archived: 10 })], {
      limit: 1,
      hasMore: false,
    })
    expect(sessionListIndexStore.getFetchedAt(archivedBucket)).toBeGreaterThan(0)

    sessionListIndexStore.invalidateArchivedView(SERVER)

    // 过期：fetchedAt 归零，读取侧据此触发静默重拉
    expect(sessionListIndexStore.getFetchedAt(archivedBucket)).toBe(0)
    // 条目仍在：重开面板首帧不闪空白
    expect(sessionListIndexStore.get(archivedBucket)?.map(s => s.id)).toEqual(['a'])
  })

  it('不影响活跃桶', () => {
    sessionListIndexStore.replace(activeBucket, [makeSession('b')], { limit: 1, hasMore: false })
    const before = sessionListIndexStore.getFetchedAt(activeBucket)

    sessionListIndexStore.invalidateArchivedView(SERVER)

    expect(sessionListIndexStore.getFetchedAt(activeBucket)).toBe(before)
  })

  it('不影响其它服务器的归档桶', () => {
    const otherBucket: SessionListBucketKey = { serverId: 'srv-2', directory: undefined, view: 'archived' }
    sessionListIndexStore.replace(otherBucket, [makeSession('c', { archived: 10 })], { limit: 1, hasMore: false })
    const before = sessionListIndexStore.getFetchedAt(otherBucket)

    sessionListIndexStore.invalidateArchivedView(SERVER)

    expect(sessionListIndexStore.getFetchedAt(otherBucket)).toBe(before)
  })

  it('覆盖同一服务器下不同 scope 的归档桶', () => {
    const scoped: SessionListBucketKey = {
      serverId: SERVER,
      directory: undefined,
      view: 'archived',
      scope: 'other',
    }
    sessionListIndexStore.replace(archivedBucket, [makeSession('a', { archived: 10 })], { limit: 1, hasMore: false })
    sessionListIndexStore.replace(scoped, [makeSession('a', { archived: 10 })], { limit: 1, hasMore: false })

    sessionListIndexStore.invalidateArchivedView(SERVER)

    expect(sessionListIndexStore.getFetchedAt(archivedBucket)).toBe(0)
    expect(sessionListIndexStore.getFetchedAt(scoped)).toBe(0)
  })

  it('桶从未加载过时是 no-op（不凭空建桶）', () => {
    sessionListIndexStore.invalidateArchivedView(SERVER)
    expect(sessionListIndexStore.has(archivedBucket)).toBe(false)
    expect(sessionListIndexStore.get(archivedBucket)).toBeUndefined()
  })
})

describe('invalidate', () => {
  it('只让新鲜度失效，不清条目', () => {
    sessionListIndexStore.replace(archivedBucket, [makeSession('a', { archived: 10 })], {
      limit: 1,
      hasMore: false,
    })

    sessionListIndexStore.invalidate(archivedBucket)

    expect(sessionListIndexStore.getFetchedAt(archivedBucket)).toBe(0)
    expect(sessionListIndexStore.get(archivedBucket)).toHaveLength(1)
  })

  it('未加载的桶不会被创建', () => {
    sessionListIndexStore.invalidate(archivedBucket)
    expect(sessionListIndexStore.get(archivedBucket)).toBeUndefined()
  })
})
