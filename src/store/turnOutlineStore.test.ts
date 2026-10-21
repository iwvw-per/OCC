import { beforeEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => {
  const data = new Map<string, string>()
  return {
    data,
    getJSONFor: vi.fn((key: string, serverId: string) => {
      const raw = data.get(`${serverId}:${key}`)
      return raw ? (JSON.parse(raw) as unknown) : null
    }),
    setJSONFor: vi.fn((key: string, value: unknown, serverId: string) => {
      data.set(`${serverId}:${key}`, JSON.stringify(value))
    }),
    remove: vi.fn(),
  }
})

vi.mock('../utils/perServerStorage', () => ({ serverStorage: storage }))

import { turnOutlineStore } from './turnOutlineStore'

describe('turnOutlineStore', () => {
  beforeEach(() => {
    turnOutlineStore.reset()
    storage.data.clear()
    storage.getJSONFor.mockClear()
    storage.setJSONFor.mockClear()
  })

  it('merges entries and keeps them sorted by createdAt', () => {
    turnOutlineStore.merge('srv', 'ses-1', [
      { messageId: 'u2', title: 'second', createdAt: 20 },
      { messageId: 'u1', title: 'first', createdAt: 10 },
    ])

    const entries = turnOutlineStore.getEntries('srv', 'ses-1')
    expect(entries.map(e => e.messageId)).toEqual(['u1', 'u2'])
  })

  it('deduplicates by messageId and updates changed titles in place', () => {
    turnOutlineStore.merge('srv', 'ses-1', [{ messageId: 'u1', title: 'old', createdAt: 10 }])
    const changed = turnOutlineStore.merge('srv', 'ses-1', [
      { messageId: 'u1', title: 'new', createdAt: 10 },
      { messageId: 'u2', title: 'second', createdAt: 20 },
    ])

    expect(changed).toBe(true)
    const entries = turnOutlineStore.getEntries('srv', 'ses-1')
    expect(entries).toHaveLength(2)
    expect(entries.find(e => e.messageId === 'u1')?.title).toBe('new')
  })

  it('returns false when merging identical entries', () => {
    turnOutlineStore.merge('srv', 'ses-1', [{ messageId: 'u1', title: 'first', createdAt: 10 }])
    expect(turnOutlineStore.merge('srv', 'ses-1', [{ messageId: 'u1', title: 'first', createdAt: 10 }])).toBe(false)
  })

  it('persists per server and reloads from storage', () => {
    turnOutlineStore.merge('srv', 'ses-1', [{ messageId: 'u1', title: 'first', createdAt: 10 }])
    expect(storage.setJSONFor).toHaveBeenCalled()

    // 模拟重挂：清内存态后应能从磁盘懒加载回来
    turnOutlineStore.reset()
    const entries = turnOutlineStore.getSnapshot('srv', 'ses-1')
    expect(entries.map(e => e.messageId)).toEqual(['u1'])
  })

  it('keeps sessions isolated within a server', () => {
    turnOutlineStore.merge('srv', 'ses-1', [{ messageId: 'u1', title: 'one', createdAt: 1 }])
    turnOutlineStore.merge('srv', 'ses-2', [{ messageId: 'u2', title: 'two', createdAt: 2 }])

    expect(turnOutlineStore.getEntries('srv', 'ses-1').map(e => e.messageId)).toEqual(['u1'])
    expect(turnOutlineStore.getEntries('srv', 'ses-2').map(e => e.messageId)).toEqual(['u2'])
  })

  it('clears a single session and drops a server', () => {
    turnOutlineStore.merge('srv', 'ses-1', [{ messageId: 'u1', title: 'one', createdAt: 1 }])
    turnOutlineStore.clearSession('srv', 'ses-1')
    expect(turnOutlineStore.getEntries('srv', 'ses-1')).toHaveLength(0)

    turnOutlineStore.merge('srv', 'ses-1', [{ messageId: 'u1', title: 'one', createdAt: 1 }])
    turnOutlineStore.dropServer('srv')
    expect(turnOutlineStore.getEntries('srv', 'ses-1')).toHaveLength(0)
  })
})

/**
 * 持久化必须与磁盘上已有的会话**合并**，不能整段覆盖。
 *
 * 曾经的 bug：每次 persist 都只用「本次运行访问过的会话」生成 payload，
 * 于是任何一次合并都会把其它会话已存的大纲抹掉。真实表现是：后台补全把
 * 138 个轮次写进存储后，下一次合并只带内存里的 2 条，直接把 138 条覆盖成 2 条
 * —— 侧边时间轴永远只剩当前加载的那两轮。
 */
describe('turnOutlineStore persistence merge', () => {
  beforeEach(() => {
    turnOutlineStore.reset()
    storage.data.clear()
  })

  /** 磁盘上的原始 payload（模拟另一个标签页 / 上次运行留下的数据） */
  const diskPayload = () => {
    const raw = storage.data.get('srv:turn-outline')
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  }

  it('does not wipe other sessions that are only on disk', () => {
    // 先在磁盘上留下一个「本次运行没访问过」的会话
    storage.data.set(
      'srv:turn-outline',
      JSON.stringify({ 'ses-other': [{ messageId: 'o1', title: 'other', createdAt: 1 }] }),
    )

    turnOutlineStore.merge('srv', 'ses-1', [{ messageId: 'u1', title: 'one', createdAt: 2 }])

    const raw = diskPayload()
    // 新会话写入，老会话仍在
    expect(raw['ses-1']).toHaveLength(1)
    expect(raw['ses-other']).toEqual([{ messageId: 'o1', title: 'other', createdAt: 1 }])
  })

  it('removes a session from disk when its outline is cleared', () => {
    turnOutlineStore.merge('srv', 'ses-1', [{ messageId: 'u1', title: 'one', createdAt: 1 }])
    turnOutlineStore.merge('srv', 'ses-2', [{ messageId: 'u2', title: 'two', createdAt: 2 }])

    turnOutlineStore.clearSession('srv', 'ses-1')

    const raw = diskPayload()
    expect(raw['ses-1']).toBeUndefined()
    expect(raw['ses-2']).toHaveLength(1)
  })
})
