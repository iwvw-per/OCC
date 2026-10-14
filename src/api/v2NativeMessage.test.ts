// 验证 v2 原生 message 访问层（v2NativeMessage）在真实 v2 沙盒上工作。
// 用 VITE_V2_SANDBOX_URL / VITE_V2_SANDBOX_PASSWORD 控制，无 env 时跳过。

import { describe, expect, it } from 'vitest'
import { serverStore } from '../store/serverStore'
import { nativeListMessages, nativePrompt } from './v2NativeMessage'

const URL = import.meta.env.VITE_V2_SANDBOX_URL as string | undefined
const PWD = import.meta.env.VITE_V2_SANDBOX_PASSWORD as string | undefined
const SERVER_ID = 'v2-sandbox-message-test'

const enabled = !!(URL && PWD)
const describeIf = enabled ? describe : describe.skip

async function ensureServer() {
  serverStore.removeServer(SERVER_ID)
  serverStore.addServerWithId(SERVER_ID, { name: 'v2-native', url: URL!, auth: { username: 'opencode', password: PWD! } })
  await serverStore.ensureApiVersion(SERVER_ID)
}

describeIf('v2 原生 message 访问层', () => {
  it('nativeListMessages 返回消息页', async () => {
    await ensureServer()
    const client = (await import('./sdkV2')).getV2Client(SERVER_ID)
    const res = await client.session.list({ limit: 1 })
    const session = res?.data?.[0]
    if (!session) return // 无会话则跳过
    const page = await nativeListMessages(SERVER_ID, { sessionID: session.id, limit: 5 })
    expect(Array.isArray(page.messages)).toBe(true)
  })

  it('nativePrompt 能发送消息（不抛错）', async () => {
    await ensureServer()
    const client = (await import('./sdkV2')).getV2Client(SERVER_ID)
    const created = await client.session.create({ title: 'v2-native-message' })
    const sid = created.id
    // 发送一条 prompt（即使模型执行中断，prompt 调用本身不应抛错）
    await expect(
      nativePrompt(SERVER_ID, {
        sessionID: sid,
        text: '你好，请回复ok',
        model: { providerID: 'opencode', modelID: 'cat-jam-free' },
      }),
    ).resolves.toBeDefined()
  })
})
