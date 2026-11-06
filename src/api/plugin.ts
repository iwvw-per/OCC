// ============================================
// Plugin API - 插件运行时加载状态
// ============================================
//
// 与设置页的 `plugins` 配置段不同：这里读的是服务端**实际加载结果**
// （`plugin.list`），能看出某个插件是否加载失败。

import { getV2Client } from './sdkV2'
import { adaptPluginList } from './v2/plugin'
import { directoryCacheKey } from '../utils/directoryUtils'
import { microCache, invalidateMicroCache } from '../utils/microCache'
import { serverStore } from '../store/serverStore'
import type { PluginStatus } from '../types/api/plugin'

/**
 * 缓存的 key。
 *
 * 插件状态按「服务器 + 目录」区分：不同项目目录可以配置不同插件
 * （opencode.json 在项目内也生效），混用会显示成别人的插件列表。
 */
function pluginScopeKey(directory?: string, serverId?: string): string {
  const sid = serverId ?? serverStore.getActiveServerId()
  return `plugin:list:${sid}:${directoryCacheKey(directory)}`
}

/**
 * 获取插件加载状态（含内置插件，由调用方决定是否展示）。
 *
 * 经隧道时每个请求约 1.1s 固定成本，而工作状态面板与设置页可能在同一轮交互里
 * 各拉一次，因此走与 MCP 状态相同的「在途合并 + 极短 TTL」缓存。
 */
export async function getPluginStatus(directory?: string, serverId?: string): Promise<PluginStatus[]> {
  const sid = serverId ?? serverStore.getActiveServerId()
  return microCache(pluginScopeKey(directory, serverId), async () => {
    const client = getV2Client(sid)
    const res = await client.plugin.list({
      location: directory ? { directory } : undefined,
    })
    // v2 的列表接口统一是 { location, data } 信封；data 缺失时适配层返回空数组。
    return adaptPluginList((res as { data?: unknown } | null | undefined)?.data)
  })
}

/** 插件集合发生变化（安装/更新/重载）后调用，避免继续返回旧状态。 */
export function invalidatePluginStatus(directory?: string, serverId?: string): void {
  const sid = serverId ?? serverStore.getActiveServerId()
  invalidateMicroCache(`plugin:list:${sid}:${directoryCacheKey(directory)}`)
}
