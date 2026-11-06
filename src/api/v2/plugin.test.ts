import { describe, expect, it } from 'vitest'
import { adaptPluginList } from './plugin'

/**
 * v2 `plugin.list` 的返回形状见 @opencode/schema 的 Plugin.Info：
 *   { id?, source, features, state }
 * 本机实测 93 个插件里 90 个是 builtin，全部 active。
 */
describe('adaptPluginList', () => {
  it('maps a local plugin with an active state', () => {
    const list = adaptPluginList([
      {
        id: 'opencode-bg',
        source: { type: 'local', path: '/root/.config/opencode/plugins/opencode-bg.ts' },
        features: { server: true },
        state: { status: 'active' },
      },
    ])
    expect(list).toEqual([
      {
        id: 'opencode-bg',
        source: { type: 'local', path: '/root/.config/opencode/plugins/opencode-bg.ts' },
        features: { server: true, tui: false, rpc: false },
        state: { status: 'active' },
      },
    ])
  })

  it('keeps failed state together with error and ref', () => {
    const list = adaptPluginList([
      {
        id: 'broken',
        source: { type: 'local', path: '/x/broken.ts' },
        features: { server: true },
        state: { status: 'failed', error: 'boom', ref: '/x/broken.ts:12' },
      },
    ])
    expect(list[0].state).toEqual({ status: 'failed', error: 'boom', ref: '/x/broken.ts:12' })
  })

  it('falls back to an empty error when a failed entry omits it', () => {
    // schema 要求 failed 必须带 error，但适配层不假设服务端守约
    const list = adaptPluginList([{ source: { type: 'local', path: '/x/a.ts' }, state: { status: 'failed' } }])
    expect(list[0].state).toEqual({ status: 'failed', error: '', ref: undefined })
  })

  it('carries package metadata (version / outdated / updating)', () => {
    const list = adaptPluginList([
      {
        id: 'pkg',
        source: { type: 'package', target: 'foo@1.2.3', version: '1.2.3', outdated: true, updating: true },
        state: { status: 'active' },
      },
    ])
    expect(list[0].source).toEqual({
      type: 'package',
      target: 'foo@1.2.3',
      version: '1.2.3',
      outdated: true,
      updating: true,
    })
  })

  it('does not treat builtin plugins as a display filter', () => {
    // 适配层不负责过滤：显示与否属于展示决策，放在渲染层
    const list = adaptPluginList([
      { id: 'a', source: { type: 'builtin' }, state: { status: 'active' } },
      { id: 'b', source: { type: 'local', path: '/x/b.ts' }, state: { status: 'active' } },
    ])
    expect(list).toHaveLength(2)
    expect(list[0].source.type).toBe('builtin')
  })

  /**
   * `Plugin.Info.id` 在 schema 里是可选的。缺 id 时若直接跳过，失败的插件会被
   * 静默吞掉 —— 面板显示「一切正常」，恰恰掩盖了问题。因此按来源推导稳定标识。
   */
  it('derives an id when the server omits it', () => {
    const list = adaptPluginList([
      { source: { type: 'local', path: '/root/.config/opencode/plugins/opencode-bg.ts' }, state: { status: 'active' } },
      { source: { type: 'package', target: 'foo@1.0.0' }, state: { status: 'active' } },
    ])
    expect(list[0].id).toBe('opencode-bg.ts')
    expect(list[1].id).toBe('foo@1.0.0')
  })

  it('handles a malformed payload without throwing', () => {
    expect(adaptPluginList(undefined)).toEqual([])
    expect(adaptPluginList(null)).toEqual([])
    expect(adaptPluginList({})).toEqual([])
    // 缺 source / state 时不崩溃，且默认成 active（不伪造失败）
    const list = adaptPluginList([{ id: 'x' }])
    expect(list[0].state).toEqual({ status: 'active' })
  })
})
