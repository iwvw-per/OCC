import { beforeEach, describe, expect, it, vi } from 'vitest'

const SYNC_STAMPS_KEY = 'opencode-preferences-sync-stamps'
const TOMBSTONES_KEY = 'opencode-preferences-sync-tombstones'
const KEY = 'srv:aiagent:inst_work:hidden-model-keys'
const HIDDEN_PROJECTS_KEY = 'srv:aiagent:inst_work:opencode-hidden-projects'

/**
 * 模型可见性（hidden-model-keys）跨端同步。
 *
 * 这份数据是「被用户隐藏的模型键」的集合：一端隐藏后，另一端的模型候选里
 * 仍然列着它，用户会当成 bug（"我不是隐藏过吗"）。因此它必须在同步白名单里，
 * 且合并要能表达删除意图。
 */
describe('model visibility sync', () => {
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
              data:
                serverValue === null
                  ? []
                  : [{ key: KEY, value: serverValue, updatedAt: '2030-01-01T00:00:00Z' }],
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
    // 隐藏的派生项目同样要跨端一致（否则一端删掉的噪音会在另一端继续出现）
    expect(isSyncableKey(HIDDEN_PROJECTS_KEY)).toBe(true)
  })

  it('merges hidden models from both sides (union)', async () => {
    const account = await seedAccount()
    localStorage.setItem(KEY, JSON.stringify(['anthropic/claude']))
    seedBaseline(['anthropic/claude'])
    stubServer(['anthropic/claude', 'openai/gpt'])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    expect(JSON.parse(localStorage.getItem(KEY) || '[]')).toEqual(['anthropic/claude', 'openai/gpt'])
  })

  it('does not resurrect a model the user just unhid', async () => {
    const account = await seedAccount()
    // 基线里有两项，本地只剩一项 → 用户取消了 openai/gpt 的隐藏
    localStorage.setItem(KEY, JSON.stringify(['anthropic/claude']))
    seedBaseline(['anthropic/claude', 'openai/gpt'])
    // 服务端还没收到本地删除，仍然带着被取消的那一项
    stubServer(['anthropic/claude', 'openai/gpt'])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    expect(JSON.parse(localStorage.getItem(KEY) || '[]')).toEqual(['anthropic/claude'])
  })

  it('keeps a locally hidden model that the server has not seen yet', async () => {
    const account = await seedAccount()
    // 本地新增隐藏，尚未推送；服务端为空
    localStorage.setItem(KEY, JSON.stringify(['anthropic/claude']))
    seedBaseline([])
    stubServer(null)

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    expect(JSON.parse(localStorage.getItem(KEY) || '[]')).toEqual(['anthropic/claude'])
  })

  it('uploads the local hidden list on push', async () => {
    const account = await seedAccount()
    localStorage.setItem(KEY, JSON.stringify(['anthropic/claude']))
    localStorage.setItem(SYNC_STAMPS_KEY, JSON.stringify({ stamps: {}, known: {} }))

    let pushed: Record<string, unknown> | undefined
    stubServer(null, values => {
      pushed = values
    })

    const { pushPreferences } = await import('./preferencesSync')
    await pushPreferences(account)

    expect(pushed?.[KEY]).toEqual(['anthropic/claude'])
  })

  it('treats a stale tombstone as authoritative only when the server still has it', async () => {
    const account = await seedAccount()
    localStorage.setItem(KEY, JSON.stringify([]))
    seedBaseline(['anthropic/claude'])
    localStorage.setItem(
      TOMBSTONES_KEY,
      JSON.stringify({ [KEY]: { 'anthropic/claude': Date.now() } }),
    )
    stubServer(['anthropic/claude'])

    const { pullPreferences } = await import('./preferencesSync')
    await pullPreferences(account)

    expect(JSON.parse(localStorage.getItem(KEY) || '[]')).toEqual([])
  })
})
