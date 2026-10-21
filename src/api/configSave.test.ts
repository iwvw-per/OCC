// ============================================
// 配置保存（fs.write + location.reload）
// ============================================
//
// 这是设置页「能读不能存」的修复。关键约束：
// 1. 只写**用户改动的字段**（merge patch），不能把合并后的生效配置整体回写 ——
//    那会把项目级配置的内容复制进全局配置，用户之后改项目配置就完全不生效。
// 2. 没有改动时不发请求，也不 reload（reload 会重建所有 location）。
// 3. shell 走原生 config.update（唯一被官方支持的字段），不重复写文件。

import { beforeEach, describe, expect, it, vi } from 'vitest'

const configUpdate = vi.fn()
const configGet = vi.fn()
const fileWrite = vi.fn()
const locationReload = vi.fn()

vi.mock('./sdkV2', () => ({
  getV2Client: () => ({
    config: { update: configUpdate, get: configGet },
    file: { write: fileWrite },
    location: { reload: locationReload },
  }),
}))
vi.mock('../store/serverStore', () => ({
  serverStore: { getActiveServerId: () => 'local' },
}))
vi.mock('../features/settings/components/configEditorUtils', () => ({
  createMergePatch: (before: unknown, after: unknown) => {
    const b = (before ?? {}) as Record<string, unknown>
    const a = (after ?? {}) as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(a)) {
      if (JSON.stringify(b[k]) !== JSON.stringify(v)) patch[k] = v
    }
    return patch
  },
}))

const { saveConfig } = await import('./config')

const DOC = '/home/u/.config/opencode/opencode.json'

/** 取最近一次 file.write 实际写入的文本（body 是 Uint8Array） */
function writtenText(): string {
  const call = fileWrite.mock.calls.at(-1)
  if (!call) throw new Error('file.write was not called')
  const body = call[0].body as Uint8Array
  return new TextDecoder().decode(body)
}

describe('saveConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configGet.mockResolvedValue([
      { type: 'document', path: DOC, info: { $schema: 'x', shell: '/bin/zsh', model: 'a/b' } },
      { type: 'directory', path: '/home/u/.config/opencode' },
    ])
    fileWrite.mockResolvedValue({ path: DOC })
    locationReload.mockResolvedValue(undefined)
    configUpdate.mockResolvedValue(undefined)
  })

  it('只把改动字段合入目标文件，保留文件里其它内容', async () => {
    await saveConfig({ model: 'a/b', shell: '/bin/zsh' } as never, { model: 'a/c', shell: '/bin/zsh' } as never)

    expect(fileWrite).toHaveBeenCalledOnce()
    const written = JSON.parse(writtenText())
    expect(written.model).toBe('a/c')
    // 文件原有的键必须保留
    expect(written.shell).toBe('/bin/zsh')
    expect(written.$schema).toBe('x')
    expect(fileWrite.mock.calls[0][0].path).toBe(DOC)
  })

  it('写入后触发 location.reload', async () => {
    await saveConfig({ model: 'a/b' } as never, { model: 'a/c' } as never)
    expect(locationReload).toHaveBeenCalledOnce()
  })

  it('没有改动时不写文件、不 reload', async () => {
    await saveConfig({ model: 'a/b' } as never, { model: 'a/b' } as never)
    expect(fileWrite).not.toHaveBeenCalled()
    expect(locationReload).not.toHaveBeenCalled()
  })

  it('shell 单独走原生 config.update，不从文件里再写一次', async () => {
    await saveConfig({ shell: '/bin/bash' } as never, { shell: '/bin/zsh' } as never)
    expect(configUpdate).toHaveBeenCalledWith({ shell: '/bin/zsh' })
    // 只有 shell 改动时不需要写文件
    expect(fileWrite).not.toHaveBeenCalled()
  })

  it('shell 与其它字段同时改动时，两条路径各管各的', async () => {
    await saveConfig({ shell: '/bin/bash', model: 'a/b' } as never, { shell: '/bin/zsh', model: 'a/c' } as never)
    expect(configUpdate).toHaveBeenCalledWith({ shell: '/bin/zsh' })
    const written = JSON.parse(writtenText())
    expect(written.model).toBe('a/c')
    // shell 已由原生端点处理，不应再出现在文件写入里造成双写
    expect(written.shell).toBe('/bin/zsh')
  })

  it('没有可写文档时抛错，而不是静默失败', async () => {
    configGet.mockResolvedValue([{ type: 'directory', path: '/only/dir' }])
    await expect(saveConfig({ a: 1 } as never, { a: 2 } as never)).rejects.toThrow(/writable config document/)
  })

  it('写入内容以换行结尾，符合 JSON 文件惯例', async () => {
    await saveConfig({ model: 'a/b' } as never, { model: 'a/c' } as never)
    expect(writtenText()).toMatch(/\n$/)
  })
})
