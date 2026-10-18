// v2 沙盒真实连接集成测试
//
// 依赖：本地启动的 opencode v2 沙盒服务器（@opencode/cli@2.0.28）
//   opencode serve --hostname 127.0.0.1 --port 4099
// 服务器 Basic auth：username=opencode，password=<server password>。
//
// 用 vite env 控制是否运行（避免 CI 无沙盒时失败）：
//   VITE_V2_SANDBOX_URL=http://127.0.0.1:4099
//   VITE_V2_SANDBOX_PASSWORD=<password>

import { beforeEach, describe, expect, it } from 'vitest'
import { serverStore } from '../store/serverStore'
import { getSDKClient } from './sdk'
import { detectServerVersion } from './serverVersion'

const V2_SANDBOX_URL = import.meta.env.VITE_V2_SANDBOX_URL as string | undefined
const V2_SANDBOX_PASSWORD = import.meta.env.VITE_V2_SANDBOX_PASSWORD as string | undefined
const SERVER_ID = 'v2-sandbox-test'

const enabled = !!(V2_SANDBOX_URL && V2_SANDBOX_PASSWORD)
const describeIf = enabled ? describe : describe.skip

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`
}

async function registerV2Server() {
  serverStore.removeServer(SERVER_ID)
  serverStore.addServerWithId(SERVER_ID, {
    name: 'v2-sandbox',
    url: V2_SANDBOX_URL!,
    auth: { username: 'opencode', password: V2_SANDBOX_PASSWORD! },
  })
}

async function ensureV2() {
  await registerV2Server()
}

describeIf('v2 沙盒 facade 真实连接', () => {
  beforeEach(async () => {
    serverStore.removeServer(SERVER_ID)
  })

  it('探测为 v2 且 version 为 2.x', async () => {
    const info = await detectServerVersion({
      baseUrl: V2_SANDBOX_URL!,
      headers: { Authorization: basicAuthHeader('opencode', V2_SANDBOX_PASSWORD!) },
      fetch: globalThis.fetch,
      timeoutMs: 5000,
    })
    expect(info.version).toMatch(/^2\./)
  })

  it('session.experimental.list 返回真实会话', async () => {
    await ensureV2()
    const sdk = getSDKClient(SERVER_ID) as {
      experimental: { session: { list: (q: { limit?: number }) => Promise<{ data?: unknown[] }> } }
    }
    const res = await sdk.experimental.session.list({ limit: 5 })
    expect(Array.isArray(res.data)).toBe(true)
  })

  it('config.providers 返回非空 provider/models', async () => {
    await ensureV2()
    const sdk = getSDKClient(SERVER_ID) as {
      config: { providers: (q: { directory?: string }) => Promise<{ data?: { providers: unknown[] } }> }
    }
    const res = await sdk.config.providers({})
    expect(res.data).toBeDefined()
    expect(Array.isArray(res.data!.providers)).toBe(true)
  }, 30000)

  it('session.create 能创建真实会话（对话链路第一步）', async () => {
    await ensureV2()
    const sdk = getSDKClient(SERVER_ID) as { session: { create: (q: { title?: string; directory?: string }) => Promise<{ data?: { id: string } }> } }
    const res = await sdk.session.create({ title: 'v2-sandbox-dialog' })
    expect(res.data?.id).toBeTruthy()
  }, 30000)
})
