import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
  })
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

describe('serverStore clock calibration', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('derives calibrated now from a server timestamp and monotonic time', async () => {
    const { serverStore } = await import('./serverStore')
    const serverTimestamp = Date.parse('2026-04-22T15:00:00.000Z')
    const perfSpy = vi.spyOn(performance, 'now')

    perfSpy.mockReturnValueOnce(1_000)
    expect(
      serverStore.applyServerConnectedTimestamp(
        serverStore.getActiveServerId(),
        new Date(serverTimestamp).toISOString(),
      ),
    ).toBe(true)

    perfSpy.mockReturnValue(1_750)
    expect(serverStore.getActiveCalibratedNow()).toBe(serverTimestamp + 750)
  })

  it('ignores malformed timestamps', async () => {
    const { serverStore } = await import('./serverStore')

    expect(serverStore.applyServerConnectedTimestamp(serverStore.getActiveServerId(), 'not-a-date')).toBe(false)
    expect(serverStore.getActiveCalibratedNow()).toBeUndefined()
  })

  it('does not reuse calibration after switching to another server without calibration', async () => {
    const { serverStore } = await import('./serverStore')
    const perfSpy = vi.spyOn(performance, 'now')

    perfSpy.mockReturnValue(500)
    serverStore.applyServerConnectedTimestamp(serverStore.getActiveServerId(), '2026-04-22T15:00:00.000Z')

    const remote = serverStore.addServer({
      name: 'Remote',
      url: 'http://remote.test',
    })
    serverStore.setActiveServer(remote.id)

    expect(serverStore.getActiveCalibratedNow()).toBeUndefined()
  })
})

describe('serverStore local runtime URL', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    sessionStorage.clear()
  })

  it('uses the detected local service URL without persisting it as the configured URL', async () => {
    const { serverStore } = await import('./serverStore')

    expect(serverStore.getActiveBaseUrl()).toBe('http://127.0.0.1:4096')

    expect(serverStore.setLocalServerRuntimeUrl('http://127.0.0.1:58231/')).toBe(true)

    expect(serverStore.getActiveBaseUrl()).toBe('http://127.0.0.1:58231')
    expect(serverStore.getLocalServerUrl()).toBe('http://127.0.0.1:58231')
    expect(serverStore.getStoredServers().find(server => server.id === 'local')?.url).toBe('http://127.0.0.1:4096')
  })

  it('notifies listeners when the active local runtime URL changes', async () => {
    const { serverStore } = await import('./serverStore')
    const listener = vi.fn()
    serverStore.onServerChange(listener)

    expect(serverStore.setLocalServerRuntimeUrl('http://127.0.0.1:58231')).toBe(true)

    expect(listener).toHaveBeenCalledWith('local', 'local-runtime-url')
  })

  it('does not notify active endpoint listeners when local URL changes while remote is active', async () => {
    const { serverStore } = await import('./serverStore')
    const remote = serverStore.addServer({ name: 'Remote', url: 'http://remote.test' })
    const listener = vi.fn()

    serverStore.setActiveServer(remote.id)
    listener.mockClear()
    serverStore.onServerChange(listener)

    expect(serverStore.setLocalServerRuntimeUrl('http://127.0.0.1:58231')).toBe(true)

    expect(serverStore.getActiveBaseUrl()).toBe('http://remote.test')
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('serverStore storage recovery', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    sessionStorage.clear()
  })

  it.each(['{}', 'null', '"nope"', '[1,2,3]'])('falls back to the default server for corrupt storage %s', async stored => {
    localStorage.setItem('opencode-servers', stored)
    const { serverStore } = await import('./serverStore')

    expect(serverStore.getStoredServers().map(server => server.id)).toEqual(['local'])
  })

  it('drops entries missing required string fields', async () => {
    localStorage.setItem(
      'opencode-servers',
      JSON.stringify([
        { id: 'ok', name: 'OK', url: 'http://ok.test' },
        { id: '', name: 'Empty id', url: 'http://bad.test' },
        { id: 'no-name', url: 'http://bad.test' },
        { id: 'no-url', name: 'No URL' },
        null,
      ]),
    )
    const { serverStore } = await import('./serverStore')

    expect(serverStore.getStoredServers().map(server => server.id)).toEqual(['ok'])
  })
})

describe('serverStore health check', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn())
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('marks a valid OpenCode health response as online', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ healthy: true, version: '1.16.0' }))
    const { serverStore } = await import('./serverStore')

    const health = await serverStore.checkHealth('local')

    expect(health.status).toBe('online')
    expect(health.version).toBe('1.16.0')
  })

  it('rejects HTML responses even when the status is 200', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('<!doctype html><title>OpenCode</title>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    )
    const { serverStore } = await import('./serverStore')

    const health = await serverStore.checkHealth('local')

    expect(health.status).toBe('error')
  })

  it('rejects JSON that is not an OpenCode health response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ok: true }))
    const { serverStore } = await import('./serverStore')

    const health = await serverStore.checkHealth('local')

    expect(health.status).toBe('error')
    expect(health.error).toBe('Not an OpenCode server')
  })

  it('reports unauthorized credentials separately', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ name: 'Unauthorized' }, { status: 401 }))
    const { serverStore } = await import('./serverStore')

    const health = await serverStore.checkHealth('local')

    expect(health.status).toBe('unauthorized')
  })

  it('sends the bearer token when the server only has a token and no password', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ healthy: true, version: '1.18.30' }))
    const { serverStore } = await import('./serverStore')
    const server = serverStore.addServerWithId('aiagent:inst_1', {
      name: '笔电',
      url: 'http://panel.test/api/aiagent/gw/inst_1',
      auth: { username: 'salen', password: '', token: 'token-abc' },
    })

    const health = await serverStore.checkHealth(server.id)

    expect(health.status).toBe('online')
    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer token-abc')
  })

  it('merges concurrent health checks into a single network request', async () => {
    const firstResponse = createDeferred<Response>()
    vi.mocked(fetch).mockImplementationOnce(() => firstResponse.promise)
    const { serverStore } = await import('./serverStore')

    // 两个并发调用应共享同一在途请求：健康状态本身就是「最近一次的结论」，
    // 并发场景下各发一次既慢（经隧道约 1.1s/次）又无意义。
    const a = serverStore.checkHealth('local')
    const b = serverStore.checkHealth('local')

    firstResponse.resolve(jsonResponse({ healthy: true, version: '1.16.0' }))
    const [ra, rb] = await Promise.all([a, b])

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
    expect(ra.status).toBe('online')
    expect(rb.status).toBe('online')
    expect(serverStore.getHealth('local')?.status).toBe('online')
  })

  it('a slow in-flight check cannot overwrite the result of a later check', async () => {
    // 序号守卫的意义：一次「慢检查」在途期间，若又发起了一次检查且先返回，
    // 慢检查随后落地时不能把新结果覆盖成旧的。
    // 在途合并只覆盖「同一时刻」的并发调用，无法覆盖「第一次已结束登记、
    // 第二次才开始」之外的场景 —— 这里用两轮分离的检查来验证守卫仍在工作。
    const slow = createDeferred<Response>()
    vi.mocked(fetch)
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: '1.17.0' }))

    const { serverStore } = await import('./serverStore')

    // 第一轮：慢检查（不 await，让它挂在在途）
    const staleCheck = serverStore.checkHealth('local')

    // 手动清掉在途登记，模拟「这一轮已结束」后新的一轮开始
    // （真实场景：上一轮返回后组件再次触发探测）
    const inflight = (serverStore as unknown as { healthInflight: Map<string, Promise<unknown>> }).healthInflight
    inflight.delete('local')

    const freshHealth = await serverStore.checkHealth('local')
    expect(freshHealth.status).toBe('online')
    expect(serverStore.getHealth('local')?.status).toBe('online')

    // 旧检查随后返回 HTML → 序号已过期，不能覆盖已确认的 online
    slow.resolve(
      new Response('<!doctype html><title>OpenCode</title>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    )
    const staleHealth = await staleCheck
    expect(staleHealth.status).toBe('error')
    expect(serverStore.getHealth('local')?.status).toBe('online')
  })

  it('shows a checking state only on the first probe', async () => {
    const firstResponse = createDeferred<Response>()
    vi.mocked(fetch)
      .mockImplementationOnce(() => firstResponse.promise)
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: '1.16.0' }))

    const { serverStore } = await import('./serverStore')

    const pending = serverStore.checkHealth('local')
    expect(serverStore.getHealth('local')?.status).toBe('checking')

    firstResponse.resolve(jsonResponse({ healthy: true, version: '1.16.0' }))
    await pending
    expect(serverStore.getHealth('local')?.status).toBe('online')

    const second = serverStore.checkHealth('local')
    // 已有结果时不得回落成 checking，否则状态点会周期性闪烁
    expect(serverStore.getHealth('local')?.status).toBe('online')
    await second
    expect(serverStore.getHealth('local')?.status).toBe('online')
  })

  it('keeps the last status during a silent probe', async () => {
    const silentResponse = createDeferred<Response>()
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ healthy: true, version: '1.16.0' }))
      .mockImplementationOnce(() => silentResponse.promise)

    const { serverStore } = await import('./serverStore')

    await serverStore.checkHealth('local')
    expect(serverStore.getHealth('local')?.status).toBe('online')

    const silent = serverStore.checkHealth('local', { silent: true })
    expect(serverStore.getHealth('local')?.status).toBe('online')

    silentResponse.resolve(jsonResponse({ healthy: true, version: '1.17.0' }))
    await silent
    expect(serverStore.getHealth('local')?.version).toBe('1.17.0')
  })

  it('detects the server version from /api/info', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ version: '2.0.28' }))

    const { serverStore } = await import('./serverStore')
    const health = await serverStore.checkHealth('local')

    expect(health.status).toBe('online')
    expect(health.version).toBe('2.0.28')
    // 只探 /api/info，不再请求 v1 的根路径
    expect(vi.mocked(fetch).mock.calls.every(([input]) => String(input).endsWith('/api/info'))).toBe(true)
  })

  it('reports a non-2.x server as error instead of falling back to v1', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    )

    const { serverStore } = await import('./serverStore')
    const health = await serverStore.checkHealth('local')

    expect(health.status).toBe('error')
  })
})

describe('serverStore enable/disable', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('defaults to enabled when the field is absent', async () => {
    const { serverStore } = await import('./serverStore')
    // 默认 Local 没有写 enabled 字段，应视为启用
    expect(serverStore.isServerEnabled('local')).toBe(true)
    expect(serverStore.getEnabledServers().map(s => s.id)).toContain('local')
  })

  it('disabling a non-active server keeps the active one untouched', async () => {
    const { serverStore } = await import('./serverStore')
    const extra = serverStore.addServer({ name: 'Remote', url: 'http://example.com' })
    const activeBefore = serverStore.getActiveServerId()

    expect(serverStore.setServerEnabled(extra.id, false)).toBe(true)
    expect(serverStore.isServerEnabled(extra.id)).toBe(false)
    expect(serverStore.getActiveServerId()).toBe(activeBefore)
  })

  it('excludes disabled servers from the enabled set', async () => {
    const { serverStore } = await import('./serverStore')
    const extra = serverStore.addServer({ name: 'Remote', url: 'http://example.com' })
    serverStore.setServerEnabled(extra.id, false)

    const ids = serverStore.getEnabledServers().map(s => s.id)
    expect(ids).not.toContain(extra.id)
  })

  it('auto-switches to an enabled server when the active one is disabled', async () => {
    const { serverStore } = await import('./serverStore')
    const extra = serverStore.addServer({ name: 'Remote', url: 'http://example.com' })
    serverStore.setActiveServer('local')

    expect(serverStore.setServerEnabled('local', false)).toBe(true)
    // 活动指针必须离开被停用的服务器，否则 getActiveServerId 的兜底
    // 会一直返回它，而连接集合已排除，形成「活动但无连接」的空转
    expect(serverStore.getActiveServerId()).toBe(extra.id)
    expect(serverStore.isServerEnabled(extra.id)).toBe(true)
  })

  it('refuses to disable the last enabled server', async () => {
    const { serverStore } = await import('./serverStore')
    // 只剩 Local 一台时拒绝停用，避免面板没有可用后端
    serverStore.setActiveServer('local')
    const onlyServer = serverStore.getServers().length === 1
    expect(onlyServer).toBe(true)

    expect(serverStore.setServerEnabled('local', false)).toBe(false)
    expect(serverStore.isServerEnabled('local')).toBe(true)
  })

  it('allows re-enabling and returns true for a no-op toggle', async () => {
    const { serverStore } = await import('./serverStore')
    const extra = serverStore.addServer({ name: 'Remote', url: 'http://example.com' })

    expect(serverStore.setServerEnabled(extra.id, true)).toBe(true)
    serverStore.setServerEnabled(extra.id, false)
    expect(serverStore.setServerEnabled(extra.id, true)).toBe(true)
    expect(serverStore.isServerEnabled(extra.id)).toBe(true)
  })
})
