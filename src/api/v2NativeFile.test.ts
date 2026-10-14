// 验证 v2 原生 file 访问层在真实 v2 沙盒上工作。

import { describe, expect, it } from 'vitest'
import { serverStore } from '../store/serverStore'
import { nativeListDirectory, nativeFindFiles } from './v2NativeFile'

const URL = import.meta.env.VITE_V2_SANDBOX_URL as string | undefined
const PWD = import.meta.env.VITE_V2_SANDBOX_PASSWORD as string | undefined
const SERVER_ID = 'v2-sandbox-file-test'

const enabled = !!(URL && PWD)
const describeIf = enabled ? describe : describe.skip

async function ensureServer() {
  serverStore.removeServer(SERVER_ID)
  serverStore.addServerWithId(SERVER_ID, { name: 'v2-native', url: URL!, auth: { username: 'opencode', password: PWD! } })
  await serverStore.ensureApiVersion(SERVER_ID)
}

describeIf('v2 原生 file 访问层', () => {
  it('nativeListDirectory 返回文件列表', async () => {
    await ensureServer()
    const files = await nativeListDirectory(SERVER_ID, { directory: '/tmp/opencode/v2-sandbox-isolated/workdir', path: '' })
    expect(Array.isArray(files)).toBe(true)
  })

  it('nativeFindFiles 返回路径', async () => {
    await ensureServer()
    const paths = await nativeFindFiles(SERVER_ID, { directory: '/tmp/opencode/v2-sandbox-isolated/workdir', query: 'package' })
    expect(Array.isArray(paths)).toBe(true)
  })
})
