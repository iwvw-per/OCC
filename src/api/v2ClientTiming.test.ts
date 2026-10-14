// 回归：连 v2 服务器（opencode 2.0.28）时，首屏请求不得打到 v1 根路径。
//
// 笔电症状（v0.6.129 仍复现）：
//   [session] fetch sessions: Error: Request is not supported by this version of
//   OpenCode Server (Server responded with text/html)
// 根因：healthMap（内存态）在应用重启后清空，版本未知时 getSDKClient 按 v1 建
// client，首屏 /session、/agent、/path 打在 v2 服务器的 SPA 兜底上返回 HTML。
// 0.6.129 把 apiVersion 纳入缓存 key，只保证「探测完成后缓存失效」，不能阻止
// 「探测完成前已发出的 v1 请求」。
//
// 用 stub fetch 精确复刻 v2 路由特征（src/api/serverVersion.ts 顶部注释）：
//   GET /global/health -> 200 text/html（SPA 接管，v2 特征）
//   GET /api/info      -> 200 application/json { version }
//   GET /api/*         -> 200 application/json
//   其余根路径          -> 200 text/html（v1 SDK 请求在 v2 上的下场）

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiVersion } from './serverVersion'

const SPA_HTML = '<!doctype html><html><head><title>OpenCode</title></head><body><div id="root"></div></body></html>'

const SERVER_ID = 'aiagent:inst_repro'
const BASE_URL = 'http://v2.test'

let requestLog: string[]

function stubV2Fetch() {
  requestLog = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(input => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const path = new URL(raw).pathname
    requestLog.push(path)

    if (path === '/global/health') {
      return Promise.resolve(new Response(SPA_HTML, { status: 200, headers: { 'content-type': 'text/html' } }))
    }
    if (path === '/api/info') {
      return Promise.resolve(
        new Response(JSON.stringify({ version: '2.0.28' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    if (path.startsWith('/api/')) {
      return Promise.resolve(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    return Promise.resolve(new Response(SPA_HTML, { status: 200, headers: { 'content-type': 'text/html' } }))
  })
}

function seedStorage() {
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem(
    'opencode-servers',
    JSON.stringify([
      { id: SERVER_ID, name: '工作', url: BASE_URL, auth: { username: 'u', password: '', token: 'token-repro' } },
    ]),
  )
  localStorage.setItem('opencode-active-server', SERVER_ID)
  sessionStorage.setItem('opencode-active-server', SERVER_ID)
}

/** v2 facade 暴露 session.experimental；v1 路径 client 则是 session.list。 */
type SessionClient = { session: { list: (q: never) => Promise<unknown> } }

function listSessions(client: unknown) {
  const sdk = client as SessionClient & { session: { experimental?: { list: (q: never) => Promise<unknown> } } }
  if (sdk.session.experimental) return sdk.session.experimental.list({} as never)
  return sdk.session.list({} as never)
}

describe('v2 client timing: no v1-root requests when talking to a v2 server', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    seedStorage()
    stubV2Fetch()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('detects v2 via /global/health + /api/info without any root-path business request', async () => {
    const { serverStore } = await import('../store/serverStore')
    expect(serverStore.getApiVersion(SERVER_ID)).toBeUndefined()

    expect(await serverStore.ensureApiVersion(SERVER_ID)).toBe<ApiVersion>('v2')
    expect(requestLog.every(p => p === '/global/health' || p.startsWith('/api/'))).toBe(true)
  })

  it('after detection the client factory returns the v2 facade, hitting only /api/*', async () => {
    const { serverStore } = await import('../store/serverStore')
    const { getSDKClient } = await import('./sdk')

    await serverStore.ensureApiVersion(SERVER_ID)

    requestLog.length = 0
    await expect(listSessions(getSDKClient(SERVER_ID))).resolves.toBeDefined()
    expect(requestLog.every(p => p.startsWith('/api/'))).toBe(true)
    expect(requestLog).not.toContain('/session')
  })

  it('survives app restart: persisted apiVersion makes the first getSDKClient call a v2 facade', async () => {
    // 第一轮：完整探测，产生 apiVersion 持久化记录
    const { serverStore } = await import('../store/serverStore')
    await serverStore.ensureApiVersion(SERVER_ID)

    // 模拟应用重启：内存 healthMap 清空，store 重新实例化，localStorage 保留
    vi.resetModules()
    stubV2Fetch()
    const { serverStore: store2 } = await import('../store/serverStore')
    const { getSDKClient } = await import('./sdk')

    expect(store2.getApiVersion(SERVER_ID)).toBe<ApiVersion>('v2')

    requestLog.length = 0
    await expect(listSessions(getSDKClient(SERVER_ID))).resolves.toBeDefined()
    expect(requestLog.every(p => p.startsWith('/api/'))).toBe(true)
    expect(requestLog).not.toContain('/session')
  })

  it('keeps the last known version when a health check fails (no downgrade to v1)', async () => {
    const { serverStore } = await import('../store/serverStore')
    await serverStore.ensureApiVersion(SERVER_ID)

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))
    const offline = await serverStore.checkHealth(SERVER_ID)
    expect(offline.status).toBe('offline')
    expect(offline.apiVersion).toBeUndefined()
    expect(serverStore.getApiVersion(SERVER_ID)).toBe<ApiVersion>('v2')
  })

  it('guards the symptom itself: an unprobed v1-path client does fail on root paths', async () => {
    // 修复的价值就是让这条路径不再被走到。这里锁住未探测时的真实行为：
    // v1 SDK 打 /session 拿到 HTML，被响应拦截器抛 text/html。
    const { getSDKClient } = await import('./sdk')
    const { serverStore } = await import('../store/serverStore')
    expect(serverStore.getApiVersion(SERVER_ID)).toBeUndefined()

    requestLog.length = 0
    await expect(listSessions(getSDKClient(SERVER_ID))).rejects.toThrow(/text\/html/)
    expect(requestLog).toContain('/session')
  })
})
