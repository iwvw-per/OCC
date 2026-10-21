// 验证 v2 原生 session 访问层（v2NativeSession）在真实 v2 沙盒上工作。
// 用 VITE_V2_SANDBOX_URL / VITE_V2_SANDBOX_PASSWORD 控制，无 env 时跳过。

import { describe, expect, it } from 'vitest'
import { serverStore } from '../store/serverStore'
import {
  nativeListSessions,
  nativeGetSession,
  nativeCreateSession,
  nativeUpdateSession,
  nativeRemoveSession,
} from './v2NativeSession'

const URL = import.meta.env.VITE_V2_SANDBOX_URL as string | undefined
const PWD = import.meta.env.VITE_V2_SANDBOX_PASSWORD as string | undefined
const SERVER_ID = 'v2-sandbox-native-test'

const enabled = !!(URL && PWD)
const describeIf = enabled ? describe : describe.skip

describeIf('v2 原生 session 访问层', () => {
  it('nativeListSessions 返回真实会话', async () => {
    serverStore.removeServer(SERVER_ID)
    serverStore.addServerWithId(SERVER_ID, { name: 'v2-native', url: URL!, auth: { username: 'opencode', password: PWD! } })

    const page = await nativeListSessions(SERVER_ID, { limit: 5 })
    expect(Array.isArray(page.sessions)).toBe(true)
    if (page.sessions.length > 0) {
      expect(typeof page.sessions[0].id).toBe('string')
      expect(typeof page.sessions[0].time.created).toBe('number')
    }
  })

  it('nativeCreateSession + nativeGetSession 闭环', async () => {
    serverStore.removeServer(SERVER_ID)
    serverStore.addServerWithId(SERVER_ID, { name: 'v2-native', url: URL!, auth: { username: 'opencode', password: PWD! } })

    const created = await nativeCreateSession(SERVER_ID, { title: 'v2-native-dialog' })
    expect(created.id).toBeTruthy()

    const got = await nativeGetSession(SERVER_ID, created.id)
    expect(got.id).toBe(created.id)
  })

  it('nativeUpdateSession 更新标题', async () => {
    serverStore.removeServer(SERVER_ID)
    serverStore.addServerWithId(SERVER_ID, { name: 'v2-native', url: URL!, auth: { username: 'opencode', password: PWD! } })

    const created = await nativeCreateSession(SERVER_ID, { title: 'orig' })
    const updated = await nativeUpdateSession(SERVER_ID, { sessionID: created.id, title: 'renamed' })
    expect(updated.id).toBe(created.id)
  })

  it('nativeRemoveSession 删除会话', async () => {
    serverStore.removeServer(SERVER_ID)
    serverStore.addServerWithId(SERVER_ID, { name: 'v2-native', url: URL!, auth: { username: 'opencode', password: PWD! } })

    const created = await nativeCreateSession(SERVER_ID, { title: 'to-delete' })
    const ok = await nativeRemoveSession(SERVER_ID, created.id)
    expect(ok).toBe(true)
  })
})
