// ============================================
// config.get 返回值摊平
// ============================================
//
// 回归用例：v2 `config.get` 返回的是 `Config.Entry[]`（数组），不是对象。
// 旧实现直接把它 `as Config`，导致设置页读到的配置恒为空对象、保存必然无效。
// 这里锁住摊平语义：按顺序深合并所有 document 条目，directory 条目只记录来源。

import { describe, expect, it, vi } from 'vitest'

const getMock = vi.fn()

vi.mock('./sdkV2', () => ({
  getV2Client: () => ({ config: { get: getMock } }),
}))

const { nativeGetConfig, nativeGetConfigWithSources } = await import('./v2NativeConfig')

function entriesResponse() {
  return [
    { type: 'document', path: '/home/u/.config/opencode/opencode.json', info: { model: 'a/b', shell: '/bin/zsh' } },
    { type: 'directory', path: '/home/u/.config/opencode' },
    { type: 'document', path: '/proj/opencode.json', info: { model: 'c/d' } },
  ]
}

describe('nativeGetConfig', () => {
  it('把 entries 数组摊平成单个对象，后出现的文档覆盖先出现的', async () => {
    getMock.mockResolvedValue(entriesResponse())
    const config = (await nativeGetConfig(undefined, {})) as Record<string, unknown>
    expect(Array.isArray(config)).toBe(false)
    expect(config.model).toBe('c/d')
    // 低优先级文档独有的键必须保留
    expect(config.shell).toBe('/bin/zsh')
  })

  it('directory 条目不参与合并，也不会把 info 混进来', async () => {
    getMock.mockResolvedValue(entriesResponse())
    const config = (await nativeGetConfig(undefined, {})) as Record<string, unknown>
    expect(config.type).toBeUndefined()
    expect(config.path).toBeUndefined()
  })

  it('嵌套对象深合并，而不是整体覆盖', async () => {
    getMock.mockResolvedValue([
      { type: 'document', path: '/a.json', info: { media: { image: { max_width: 1000, auto_resize: true } } } },
      { type: 'document', path: '/b.json', info: { media: { image: { max_width: 2000 } } } },
    ])
    const config = (await nativeGetConfig(undefined, {})) as {
      media: { image: { max_width: number; auto_resize?: boolean } }
    }
    expect(config.media.image.max_width).toBe(2000)
    // 深层未被覆盖的兄弟键要保留
    expect(config.media.image.auto_resize).toBe(true)
  })

  it('数组整体覆盖（不做元素级合并）', async () => {
    getMock.mockResolvedValue([
      { type: 'document', path: '/a.json', info: { instructions: ['a.md', 'b.md'] } },
      { type: 'document', path: '/b.json', info: { instructions: ['c.md'] } },
    ])
    const config = (await nativeGetConfig(undefined, {})) as { instructions: string[] }
    expect(config.instructions).toEqual(['c.md'])
  })

  it('空响应或非数组返回空对象，不抛错', async () => {
    getMock.mockResolvedValue({ data: [] })
    expect(await nativeGetConfig(undefined, {})).toEqual({})
    getMock.mockResolvedValue(null)
    expect(await nativeGetConfig(undefined, {})).toEqual({})
  })

  it('记录所有来源路径', async () => {
    getMock.mockResolvedValue(entriesResponse())
    const { sources } = await nativeGetConfigWithSources(undefined, {})
    expect(sources).toEqual(['/home/u/.config/opencode/opencode.json', '/home/u/.config/opencode', '/proj/opencode.json'])
  })
})
