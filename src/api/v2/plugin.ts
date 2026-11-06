// ============================================
// v2 Plugin → 内部 PluginStatus
// ============================================
//
// 纯映射，不发请求。`plugin.list` 的返回形状见 @opencode/schema 的 Plugin.Info：
//
//   { id?, source: {type: 'builtin'|'package'|'local'|'sdk', …},
//     features: {server?, tui?, rpc?},
//     state: {status: 'active'} | {status: 'failed', error, ref?} }

import { rec, str } from './adapt'
import type { PluginSourceInfo, PluginStateInfo, PluginStatus } from '../../types/api/plugin'

function adaptSource(raw: unknown): PluginSourceInfo {
  const s = rec(raw)
  const type = str(s.type)
  switch (type) {
    case 'package':
      return {
        type: 'package',
        target: str(s.target),
        version: str(s.version),
        outdated: s.outdated === true,
        updating: s.updating === true,
      }
    case 'local':
      return { type: 'local', path: str(s.path) }
    case 'sdk':
      return { type: 'sdk' }
    case 'builtin':
      return { type: 'builtin' }
    default:
      // 未来可能出现新的来源类型：按 builtin 处理会让它看起来像内置插件而在
      // 面板里被过滤掉。归为 sdk（同样是「无归属信息」的一种）更不容易误导。
      return { type: 'sdk' }
  }
}

function adaptState(raw: unknown): PluginStateInfo {
  const s = rec(raw)
  if (str(s.status) === 'failed') {
    return {
      status: 'failed',
      // schema 要求 failed 必须带 error，但适配层不假设服务端守约：
      // 缺字段时给空串，渲染层会退回通用文案。
      error: str(s.error) ?? '',
      ref: str(s.ref),
    }
  }
  return { status: 'active' }
}

/**
 * 插件 id 的兜底。
 *
 * `Plugin.Info.id` 在 schema 里是**可选**的（plugin.d.ts:37）。本机实测 93 个
 * 插件全都带 id，但缺少时若直接跳过，失败的插件会被静默吞掉 —— 用户看到的
 * 是「一切正常」。因此按来源推导一个稳定标识，至少能定位是哪个文件/包。
 */
function deriveId(source: PluginSourceInfo, index: number): string {
  if (source.type === 'package' && source.target) return source.target
  if (source.type === 'local' && source.path) {
    // 取最后一段作为显示名，避免长路径把行撑满
    const segments = source.path.split(/[\\/]/)
    return segments[segments.length - 1] || source.path
  }
  return `plugin-${index}`
}

/**
 * `plugin.list` 的 data[] → PluginStatus[]。
 *
 * 只做归一，**不在这里过滤 builtin** —— 「面板要显示什么」属于展示决策，
 * 放在渲染层，调用方（或未来的详情页）仍能拿到全量。
 */
export function adaptPluginList(raw: unknown): PluginStatus[] {
  const list = Array.isArray(raw) ? raw : []
  return list.map((entry, index) => {
    const p = rec(entry)
    const source = adaptSource(p.source)
    const id = str(p.id) || deriveId(source, index)
    const features = rec(p.features)
    return {
      id,
      source,
      features: {
        server: features.server === true,
        tui: features.tui === true,
        rpc: features.rpc === true,
      },
      state: adaptState(p.state),
    }
  })
}
