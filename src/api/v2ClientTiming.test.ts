// 回归：连 opencode 2.x 服务器时，所有请求都走 /api/* 前缀。
//
// 历史症状：版本探测窗口里 getSDKClient 按 v1 建 client，首屏 /session、/agent
// 打在 v2 服务器的 SPA 兜底上返回 HTML，报
//   Request is not supported by this version of OpenCode Server。
// 现在 OCC 只支持 2.x：客户端工厂恒为 v2 facade，健康检查只探 /api/info。
//
// 用 stub fetch 复刻 v2 路由特征：
//   GET /global/health -> 200 text/html（SPA 接管，v2 特征）
//   GET /api/info      -> 200 application/json { version }
//   GET /api/*         -> 200 application/json
//   其余根路径          -> 200 text/html（v1 请求在 v2 上的下场）

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('v2 client: only /api/* requests', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    seedStorage()
    stubV2Fetch()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('detects the server via /api/info without any root-path business request', async () => {
    const { serverStore } = await import('../store/serverStore')

    const health = await serverStore.checkHealth(SERVER_ID)
    expect(health.status).toBe('online')
    expect(health.version).toBe('2.0.28')
    expect(requestLog).toEqual(['/api/info'])
  })

  it('the v2 client hits only /api/*', async () => {
    const { getV2Client } = await import('./sdkV2')

    requestLog.length = 0
    await expect(getV2Client(SERVER_ID).session.list({ limit: 5 })).resolves.toBeDefined()
    expect(requestLog.every(p => p.startsWith('/api/'))).toBe(true)
    expect(requestLog).not.toContain('/session')
  })

  it('a server without /api/info is reported as error, still without root requests', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(SPA_HTML, { status: 200, headers: { 'content-type': 'text/html' } })),
    )
    const { serverStore } = await import('../store/serverStore')

    const health = await serverStore.checkHealth(SERVER_ID)
    expect(health.status).toBe('error')
  })
})
