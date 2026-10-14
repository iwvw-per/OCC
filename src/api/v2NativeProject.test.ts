// 验证 v2 原生 project 访问层在真实 v2 沙盒上工作。

import { describe, expect, it } from 'vitest'
import { serverStore } from '../store/serverStore'
import { nativeGetCurrentProject, nativeListProjects } from './v2NativeProject'

const URL = import.meta.env.VITE_V2_SANDBOX_URL as string | undefined
const PWD = import.meta.env.VITE_V2_SANDBOX_PASSWORD as string | undefined
const SERVER_ID = 'v2-sandbox-project-test'

const enabled = !!(URL && PWD)
const describeIf = enabled ? describe : describe.skip

async function ensureServer() {
  serverStore.removeServer(SERVER_ID)
  serverStore.addServerWithId(SERVER_ID, { name: 'v2-native', url: URL!, auth: { username: 'opencode', password: PWD! } })
  await serverStore.ensureApiVersion(SERVER_ID)
}

describeIf('v2 原生 project 访问层', () => {
  it('nativeListProjects 返回项目列表', async () => {
    await ensureServer()
    const projects = await nativeListProjects(SERVER_ID, { directory: 'C:\\Users\\DSUK' })
    expect(Array.isArray(projects)).toBe(true)
  })

  it('nativeGetCurrentProject 返回当前项目', async () => {
    await ensureServer()
    const project = await nativeGetCurrentProject(SERVER_ID, { directory: 'C:\\Users\\DSUK' })
    expect(project).toBeDefined()
    expect(typeof project.id).toBe('string')
  })
})
