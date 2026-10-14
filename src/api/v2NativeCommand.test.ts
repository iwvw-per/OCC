// 验证 v2 原生 command/skill 访问层在真实 v2 沙盒上工作。

import { describe, expect, it } from 'vitest'
import { serverStore } from '../store/serverStore'
import { nativeListCommands, nativeListSkills } from './v2NativeCommand'

const URL = import.meta.env.VITE_V2_SANDBOX_URL as string | undefined
const PWD = import.meta.env.VITE_V2_SANDBOX_PASSWORD as string | undefined
const SERVER_ID = 'v2-sandbox-cmd-test'

const enabled = !!(URL && PWD)
const describeIf = enabled ? describe : describe.skip

async function ensureServer() {
  serverStore.removeServer(SERVER_ID)
  serverStore.addServerWithId(SERVER_ID, { name: 'v2-native', url: URL!, auth: { username: 'opencode', password: PWD! } })
  await serverStore.ensureApiVersion(SERVER_ID)
}

describeIf('v2 原生 command/skill 访问层', () => {
  it('nativeListCommands 返回命令', async () => {
    await ensureServer()
    const commands = await nativeListCommands(SERVER_ID, { directory: '/tmp/opencode/v2-sandbox-isolated/workdir' })
    expect(Array.isArray(commands)).toBe(true)
  })

  it('nativeListSkills 返回 skill', async () => {
    await ensureServer()
    const skills = await nativeListSkills(SERVER_ID, { directory: '/tmp/opencode/v2-sandbox-isolated/workdir' })
    expect(Array.isArray(skills)).toBe(true)
  })
})
