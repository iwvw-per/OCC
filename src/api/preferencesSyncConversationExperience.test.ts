import { beforeEach, describe, expect, it, vi } from 'vitest'

const SYNC_STAMPS_KEY = 'opencode-preferences-sync-stamps'

/**
 * 「对话体验」设置跨端同步。
 *
 * 这些键此前被刻意排除在同步之外(属个性化设置),现在纳入白名单。除了白名单
 * 命中,更重要的是**拉取后本端 store 要立刻反映新值** —— themeStore /
 * largeTextPasteStore 只在内存里维护快照,不订阅 localStorage,不重读就会
 * 表现为「同步显示成功但这一刻没生效」。
 */
describe('conversation experience sync', () => {
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

  function stubServer(items: Array<{ key: string; value: unknown }>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/aiagent/preferences')) {
          return new Response(
            JSON.stringify({
              success: true,
              data: items.map(item => ({ ...item, updatedAt: '2030-01-01T00:00:00Z' })),
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

  it('is in the sync whitelist', async () => {
    const { isSyncableKey } = await import('./preferencesSync')
    for (const key of ['collapse-user-messages', 'reasoning-display-mode', 'opencode:large-text-paste']) {
      expect(isSyncableKey(key), key).toBe(true)
    }
  })

  it('writes pulled values and refreshes the in-memory stores', async () => {
    const account = await seedAccount()
    stubServer([
      { key: 'collapse-user-messages', value: false },
      { key: 'reasoning-display-mode', value: 'ticker' },
      { key: 'opencode:large-text-paste', value: { behavior: 'attach' } },
    ])
    localStorage.setItem(SYNC_STAMPS_KEY, JSON.stringify({ stamps: {}, known: {} }))

    const { pullPreferences } = await import('./preferencesSync')
    const { themeStore } = await import('../store/themeStore')
    const { largeTextPasteStore } = await import('../store/largeTextPasteStore')

    const written = await pullPreferences(account)

    expect(written).toBeGreaterThan(0)
    // 落盘值与 store 内存快照都应反映服务端的值
    expect(localStorage.getItem('collapse-user-messages')).toBe('false')
    expect(themeStore.getState().collapseUserMessages).toBe(false)
    expect(themeStore.getState().reasoningDisplayMode).toBe('ticker')
    expect(largeTextPasteStore.getSnapshot().behavior).toBe('attach')
  })
})
