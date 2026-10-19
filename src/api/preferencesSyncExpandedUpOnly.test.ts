import { beforeEach, describe, expect, it, vi } from 'vitest'

const SYNC_STAMPS_KEY = 'opencode-preferences-sync-stamps'
const TOMBSTONES_KEY = 'opencode-preferences-sync-tombstones'
const KEY = 'opencode-sidebar-expanded-projects'

/**
 * 项目行展开状态：**只向上合并**。
 *
 * 用户报的是「手动展开总是会自动收起」。根因：这个键整体参与同步，本地收起
 * 也被当成一次变更上传（并记墓碑），另一端 pull 时按墓碑把刚展开的项排除了。
 *
 * 正确语义：
 *   - 本端展开 → 同步给其它端
 *   - 本端收起 → 只影响本端，不广播、不记墓碑
 */

describe('expanded projects: up-only sync', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  async function seedAccount() {
    const { login } = await import('./aiagent')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/api/aiagent/auth/login')) {
          return new Response(JSON.stringify({ success: true, data: { token: 'tok' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )
    return login('panel.example.com', 'salen', 'secret-pass-1')
  }

  function stubServer(serverValue: unknown, onPut?: (values: Record<string, unknown>) => void) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as { values: Record<string, unknown> }
          onPut?.(body.values)
          return new Response(JSON.stringify({ success: true, data: { written: Object.keys(body.values) } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        const url = String(input)
        if (url.includes('/api/aiagent/preferences')) {
          return new Response(
            JSON.stringify({
              success: true,
              data: serverValue === null ? [] : [{ key: KEY, value: serverValue, updatedAt: '2030-01-01T00:00:00Z' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )
  }

  /** 基线 = 上次同步时的状态 */
  function seedBaseline(snapshotValue: string[]) {
    localStorage.setItem(
      SYNC_STAMPS_KEY,
      JSON.stringify({
        stamps: { [KEY]: '2029-01-01T00:00:00Z' },
        known: { __snapshot__: JSON.stringify({ [KEY]: JSON.stringify(snapshotValue) }) },
      }),
    )
  }

  it('does not upload a local collapse', async () => {
    const account = await seedAccount()
    // 基线里两个都展开，本地只剩一个 → 用户刚收起了 komidash
    seedBaseline(['OCC', 'komidash'])
    localStorage.setItem(KEY, JSON.stringify(['OCC']))

    let pushed: Record<string, unknown> | undefined
    stubServer(null, values => {
      pushed = values
    })

    const { pushPreferences } = await import('./preferencesSync')
    await pushPreferences(account)

    // 收起不是删除意图：上传值仍包含基线里的项
    expect(pushed?.[KEY]).toEqual(['OCC', 'komidash'])
  })

  it('does not create a tombstone for a local collapse', async () => {
    const account = await seedAccount()
    seedBaseline(['OCC', 'komidash'])
    localStorage.setItem(KEY, JSON.stringify(['OCC']))

    stubServer(null)

    const { pushPreferences } = await import('./preferencesSync')
    await pushPreferences(account)

    const tombstones = JSON.parse(localStorage.getItem(TOMBSTONES_KEY) || '{}')
    expect(tombstones[KEY]?.komidash).toBeUndefined()
  })

  it('still uploads a newly expanded project', async () => {
    const account = await seedAccount()
    seedBaseline(['OCC'])
    // 本地新展开一个：这属于「向上」，必须上传
    localStorage.setItem(KEY, JSON.stringify(['OCC', 'komidash']))

    let pushed: Record<string, unknown> | undefined
    stubServer(null, values => {
      pushed = values
    })

    const { pushPreferences } = await import('./preferencesSync')
    await pushPreferences(account)

    expect(pushed?.[KEY]).toEqual(['OCC', 'komidash'])
  })

  it('keeps a local collapse local during pull (other device still expanded)', async () => {
    const account = await seedAccount()
    const { layoutStore } = await import('../store/layoutStore')

    // 基线：两个都展开（先清空收起记录，避免受其它用例影响）
    localStorage.removeItem('opencode-sidebar-collapsed-projects')
    seedBaseline(['OCC', 'komidash'])
    layoutStore.setSidebarExpandedProjects(['OCC', 'komidash'])
    // 用户主动收起 komidash（经由 store，会记录收起意图）
    layoutStore.setSidebarExpandedProjects(['OCC'])
    expect(JSON.parse(localStorage.getItem(KEY) || '[]')).toEqual(['OCC'])
    expect(JSON.parse(localStorage.getItem('opencode-sidebar-collapsed-projects') || '[]')).toContain('komidash')

    // 服务端仍是两个都展开（另一端的视角）
    stubServer(['OCC', 'komidash'])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    // 本地为准：刚收起的那项不能被服务端残留并回来
    expect(JSON.parse(localStorage.getItem(KEY) || '[]')).toEqual(['OCC'])
  })

  it('still accepts a project expanded on the other device during pull', async () => {
    const account = await seedAccount()
    const { layoutStore } = await import('../store/layoutStore')

    seedBaseline(['OCC'])
    layoutStore.setSidebarExpandedProjects(['OCC'])
    // 另一端新展开了一个：属于「向上」，应当同步过来
    stubServer(['OCC', 'komidash'])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    expect(JSON.parse(localStorage.getItem(KEY) || '[]')).toEqual(['OCC', 'komidash'])
  })

  it('does not record a tombstone on pull after a local collapse', async () => {
    const account = await seedAccount()
    seedBaseline(['OCC', 'komidash'])
    localStorage.setItem(KEY, JSON.stringify(['OCC']))
    stubServer(['OCC', 'komidash'])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    const tombstones = JSON.parse(localStorage.getItem(TOMBSTONES_KEY) || '{}')
    expect(tombstones[KEY]?.komidash).toBeUndefined()
  })
})
