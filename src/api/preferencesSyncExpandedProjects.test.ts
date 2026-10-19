import { beforeEach, describe, expect, it, vi } from 'vitest'

const SYNC_STAMPS_KEY = 'opencode-preferences-sync-stamps'
const KEY = 'opencode-sidebar-expanded-projects'

/**
 * 项目行展开/收起跨端同步。
 *
 * 用户报的是「展开和收起不一致，状态多端也没有同步」。以前这个键被排除在
 * 白名单外（当成「浏览状态」），于是两端各记各的。但项目行展开是偏好而不是
 * 瞬时状态：用户往往固定只展开当前在做的项目。
 */
describe('expanded projects sync', () => {
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

  function seedBaseline(snapshotValue: string[]) {
    localStorage.setItem(
      SYNC_STAMPS_KEY,
      JSON.stringify({
        stamps: { [KEY]: '2029-01-01T00:00:00Z' },
        known: { __snapshot__: JSON.stringify({ [KEY]: JSON.stringify(snapshotValue) }) },
      }),
    )
  }

  it('is in the sync whitelist', async () => {
    const { isSyncableKey } = await import('./preferencesSync')
    expect(isSyncableKey(KEY)).toBe(true)
  })

  it('merges expanded projects from both devices (union)', async () => {
    const account = await seedAccount()
    localStorage.setItem(KEY, JSON.stringify(['local::OCC']))
    seedBaseline(['local::OCC'])
    stubServer(['local::OCC', 'local::komidash'])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    expect(JSON.parse(localStorage.getItem(KEY) || '[]')).toEqual(['local::OCC', 'local::komidash'])
  })

  it('keeps the same project name on another host independent', async () => {
    const account = await seedAccount()
    // 本机笔电主机展开了 OCC；服务端还有工作机上的同名 OCC —— 两者是不同的项，
    // 旧实现按裸项目名存储时会互相串台。
    localStorage.setItem(KEY, JSON.stringify(['aiagent:inst_laptop::OCC']))
    seedBaseline(['aiagent:inst_laptop::OCC'])
    stubServer(['aiagent:inst_laptop::OCC', 'aiagent:inst_work::OCC'])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    expect(JSON.parse(localStorage.getItem(KEY) || '[]')).toEqual([
      'aiagent:inst_laptop::OCC',
      'aiagent:inst_work::OCC',
    ])
  })

  it('drops legacy bare names coming from the server', async () => {
    const account = await seedAccount()
    // 旧版本写下的裸名无法判断属于哪台主机：若并进本地会随当前活动主机漂移
    localStorage.setItem(KEY, JSON.stringify(['local::OCC']))
    seedBaseline(['local::OCC'])
    stubServer(['local::OCC', 'komidash'])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    expect(JSON.parse(localStorage.getItem(KEY) || '[]')).toEqual(['local::OCC'])
  })

  it('does not resurrect a project the user just collapsed (via the store)', async () => {
    const account = await seedAccount()
    const { layoutStore } = await import('../store/layoutStore')
    // 基线里两个都展开
    seedBaseline(['local::OCC', 'local::komidash'])
    layoutStore.setSidebarExpandedProjects(['local::OCC', 'local::komidash'])
    // 用户主动收起 komidash（记录收起意图）
    layoutStore.setSidebarExpandedProjects(['local::OCC'])
    // 服务端还没收到本地收起
    stubServer(['local::OCC', 'local::komidash'])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    // 收起只影响本机：服务端残留不会把它并回来
    expect(JSON.parse(localStorage.getItem(KEY) || '[]')).toEqual(['local::OCC'])
  })

  it('pushes the expanded list so the other device can pick it up', async () => {
    const account = await seedAccount()
    localStorage.setItem(KEY, JSON.stringify(['local::OCC']))
    localStorage.setItem(SYNC_STAMPS_KEY, JSON.stringify({ stamps: {}, known: {} }))

    let pushed: Record<string, unknown> | undefined
    stubServer(null, values => {
      pushed = values
    })

    const { pushPreferences } = await import('./preferencesSync')
    await pushPreferences(account)

    expect(pushed?.[KEY]).toEqual(['local::OCC'])
  })
})
