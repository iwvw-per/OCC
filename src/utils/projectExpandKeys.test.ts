import { describe, expect, it } from 'vitest'
import {
  adoptLegacyProjectExpandKeys,
  isScopedProjectExpandKey,
  makeProjectExpandKey,
  migrateProjectExpandKeys,
} from './projectExpandKeys'

/**
 * 项目行展开键按主机隔离。
 *
 * 用户报的是：两台主机上有同名项目，在一台上展开，另一台上的同名项目跟着展开 /
 * 一起收起。原因就是存储只用了裸项目名（opencode-sidebar-expanded-projects），
 * 而项目列表是按主机分桶的 —— 名字相同就被当成同一项。
 */
describe('projectExpandKeys', () => {
  it('scopes the same project name to different hosts', () => {
    const onWorkHost = makeProjectExpandKey('aiagent:inst_work', 'OCC')
    const onLaptop = makeProjectExpandKey('aiagent:inst_laptop', 'OCC')

    expect(onWorkHost).not.toBe(onLaptop)
    // 同一台主机、同一名字仍然是同一个键（跨设备同步靠这一点）
    expect(makeProjectExpandKey('aiagent:inst_work', 'OCC')).toBe(onWorkHost)
  })

  it('recognizes scoped keys', () => {
    expect(isScopedProjectExpandKey(makeProjectExpandKey('local', 'OCC'))).toBe(true)
    expect(isScopedProjectExpandKey('OCC')).toBe(false)
  })

  it('adopts legacy bare names into the given host', () => {
    expect(adoptLegacyProjectExpandKeys(['OCC', 'komidash'], 'local')).toEqual([
      'local::OCC',
      'local::komidash',
    ])
  })

  it('never double-prefixes already scoped entries', () => {
    expect(adoptLegacyProjectExpandKeys(['local::OCC', 'aiagent:inst_x::OCC'], 'local')).toEqual([
      'local::OCC',
      'aiagent:inst_x::OCC',
    ])
  })

  it('de-duplicates keys that collide after adoption', () => {
    // 裸名 OCC 归给 local 后与已有的 local::OCC 重复
    expect(adoptLegacyProjectExpandKeys(['OCC', 'local::OCC'], 'local')).toEqual(['local::OCC'])
  })

  it('reports whether migration changed anything', () => {
    expect(migrateProjectExpandKeys(['OCC'], 'local')).toEqual({
      values: ['local::OCC'],
      changed: true,
    })
    // 幂等：已迁移过的值再跑一次不应该变化
    expect(migrateProjectExpandKeys(['local::OCC'], 'local')).toEqual({
      values: ['local::OCC'],
      changed: false,
    })
  })

  it('keeps names containing the separator untouched', () => {
    // 项目名里带 :: 属极端情况：不补前缀（不匹配任何项目），也不会串到别的主机
    expect(adoptLegacyProjectExpandKeys(['weird::name'], 'local')).toEqual(['weird::name'])
  })
})
