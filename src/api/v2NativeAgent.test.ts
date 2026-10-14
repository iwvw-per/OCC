// 验证 v2 原生 agent/mcp/vcs 访问层在真实 v2 沙盒上工作。

import { describe, expect, it } from 'vitest'
import { serverStore } from '../store/serverStore'
import { nativeListAgents, nativeGetMcpStatus, nativeGetVcsInfo } from './v2NativeAgent'

const URL = import.meta.env.VITE_V2_SANDBOX_URL as string | undefined
const PWD = import.meta.env.VITE_V2_SANDBOX_PASSWORD as string | undefined
const SERVER_ID = 'v2-sandbox-agent-test'

const enabled = !!(URL && PWD)
const describeIf = enabled ? describe : describe.skip

async function ensureServer() {
  serverStore.removeServer(SERVER_ID)
  serverStore.addServerWithId(SERVER_ID, { name: 'v2-native', url: URL!, auth: { username: 'opencode', password: PWD! } })
  await serverStore.ensureApiVersion(SERVER_ID)
}

describeIf('v2 原生 agent/mcp/vcs 访问层', () => {
  it('nativeListAgents 返回 agent', async () => {
    await ensureServer()
    const agents = await nativeListAgents(SERVER_ID, { directory: '/tmp/opencode/v2-sandbox-isolated/workdir' })
    expect(Array.isArray(agents)).toBe(true)
  })

  it('nativeGetMcpStatus 返回状态 map', async () => {
    await ensureServer()
    const status = await nativeGetMcpStatus(SERVER_ID)
    expect(status).toBeDefined()
  })

  it('nativeGetVcsInfo 返回 vcs 信息', async () => {
    await ensureServer()
    const vcs = await nativeGetVcsInfo(SERVER_ID, { directory: '/tmp/opencode/v2-sandbox-isolated/workdir' })
    expect(vcs).toBeDefined()
  })
})
