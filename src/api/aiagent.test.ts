import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('aiagent account integration', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('normalizes domains with and without protocol', async () => {
    const { normalizeDomain } = await import('./aiagent')
    expect(normalizeDomain('panel.example.com')).toBe('https://panel.example.com')
    expect(normalizeDomain('https://panel.example.com/')).toBe('https://panel.example.com')
    expect(normalizeDomain('http://203.0.113.10:3000')).toBe('http://203.0.113.10:3000')
    expect(normalizeDomain('   ')).toBe('')
  })

  it('logs in, persists the account and lists instances', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/aiagent/auth/login')) {
        return new Response(JSON.stringify({ success: true, data: { token: 'tok-abc', expiresAt: '2030-01-01T00:00:00Z' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.endsWith('/api/aiagent/instances')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                id: 'inst_1',
                label: 'home-pc',
                provider: 'opencode',
                providerLabel: 'OpenCode',
                serverId: 'server-001',
                hostName: 'desk',
                port: 4096,
                enabled: true,
                gatewayPath: '/api/aiagent/gw/inst_1',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ success: false, error: 'unexpected' }), { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { login, readAccount, syncInstances, selectInstance } = await import('./aiagent')
    const { serverStore } = await import('../store/serverStore')

    const account = await login('panel.example.com', 'salen', 'secret-pass-1', 'iphone')
    expect(account.domain).toBe('https://panel.example.com')
    expect(account.token).toBe('tok-abc')
    expect(readAccount()?.username).toBe('salen')

    const instances = await syncInstances(account)
    expect(instances).toHaveLength(1)

    const servers = serverStore.getStoredServers()
    const created = servers.find(server => server.name.includes('home-pc'))
    expect(created).toBeTruthy()
    expect(created?.url).toBe('https://panel.example.com/api/aiagent/gw/inst_1')
    expect(created?.auth?.token).toBe('tok-abc')

    expect(selectInstance(instances[0])).toBe(true)
    expect(serverStore.getActiveServerId()).toBe(created?.id)
  })

  it('retries without If-None-Match when the preflight rejects the header', async () => {
    const seen: string[] = []
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers || {})
      const conditional = headers.get('If-None-Match')
      seen.push(conditional ?? '(none)')
      // 预检拒绝 If-None-Match 时，浏览器直接把 fetch 丢掉（TypeError）
      if (conditional) throw new TypeError('Failed to fetch')
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { accountRequestWithMeta } = await import('./aiagent')
    const account = { domain: 'https://panel.example.com', username: 'u', token: 't', loginAt: 0 }

    const first = await accountRequestWithMeta<unknown>(account, '/api/aiagent/preferences', {
      headers: { 'If-None-Match': 'W/"abc"' },
    })
    expect(first.notModified).toBe(false)
    expect(seen).toEqual(['W/"abc"', '(none)'])

    // 第二次直接不带条件头，不再触发一次失败的预检
    seen.length = 0
    await accountRequestWithMeta<unknown>(account, '/api/aiagent/preferences', {
      headers: { 'If-None-Match': 'W/"abc"' },
    })
    expect(seen).toEqual(['(none)'])
  })

  it('sends bearer token when listing instances', async () => {
    const seen: Record<string, string> = {}
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers || {})
      seen[url] = headers.get('Authorization') || ''
      const body = url.endsWith('/api/aiagent/auth/login')
        ? { success: true, data: { token: 'tok-abc' } }
        : { success: true, data: [] }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { login, listInstances, logout } = await import('./aiagent')
    await login('panel.example.com', 'salen', 'secret-pass-1')
    await listInstances()
    expect(seen['https://panel.example.com/api/aiagent/instances']).toBe('Bearer tok-abc')

    await logout()
    const { readAccount, clearAccountServers } = await import('./aiagent')
    expect(readAccount()).toBeNull()
    clearAccountServers()
  })

  it('surfaces login failures with the server message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: false, error: 'invalid credentials' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const { login } = await import('./aiagent')
    await expect(login('panel.example.com', 'salen', 'wrong')).rejects.toThrow('invalid credentials')
  })

  it('prunes stale aiagent servers and falls back to the local server', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/aiagent/auth/login')) {
        return new Response(JSON.stringify({ success: true, data: { token: 'tok-abc' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.endsWith('/api/aiagent/instances')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                id: 'inst_live',
                label: 'work',
                provider: 'opencode',
                serverId: 'server-010',
                port: 4096,
                enabled: true,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ success: false, error: 'unexpected' }), { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { login, ensureServerForInstance, syncInstances } = await import('./aiagent')
    const { serverStore } = await import('../store/serverStore')

    const account = await login('panel.example.com', 'salen', 'secret-pass-1')
    const stale = ensureServerForInstance(account, {
      id: 'inst_gone',
      label: 'old-laptop',
      provider: 'opencode',
      serverId: 'server-011',
      port: 4096,
      enabled: true,
    })
    expect(serverStore.setActiveServer(stale.id)).toBe(true)
    expect(serverStore.getActiveServerId()).toBe('aiagent:inst_gone')

    const instances = await syncInstances(account)
    expect(instances.map(instance => instance.id)).toEqual(['inst_live'])
    expect(serverStore.getStoredServers().some(server => server.id === 'aiagent:inst_gone')).toBe(false)
    expect(serverStore.getStoredServers().some(server => server.id === 'aiagent:inst_live')).toBe(true)
    expect(serverStore.getActiveServerId()).toBe('local')
  })

  it('clears account servers on logout', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, data: { token: 'tok-abc' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { login, ensureServerForInstance, clearAccountServers } = await import('./aiagent')
    const { serverStore } = await import('../store/serverStore')

    const account = await login('panel.example.com', 'salen', 'secret-pass-1')
    ensureServerForInstance(account, {
      id: 'inst_9',
      label: 'work-laptop',
      provider: 'opencode',
      serverId: 'server-002',
      port: 4096,
      enabled: true,
    })
    expect(serverStore.getStoredServers().some(server => server.id === 'aiagent:inst_9')).toBe(true)

    clearAccountServers()
    expect(serverStore.getStoredServers().some(server => server.id === 'aiagent:inst_9')).toBe(false)
  })
})
