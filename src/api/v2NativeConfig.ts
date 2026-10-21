// ============================================
// v2 原生 Config / Provider 访问层
//
// 直接用 @opencode/client（v2 原生）调用 config/provider/model。
// ============================================

import { getV2Client } from './sdkV2'
import { adaptDataList } from './v2/session'
import { adaptProviders } from './v2/entities'
import { rec } from './v2/adapt'
import { deepMergeConfig } from '../utils/deepMerge'
import type { ProvidersResponse } from '../types/api/model'

/**
 * 把 v2 `config.get` 的 `Config.Entry[]` 摊平成前端期望的单个 `Config` 对象。
 *
 * ⚠️ 这是此前一个真实缺陷：`config.get` 返回的是**数组**，元素形如
 *   `{ type: 'document', path: '…/opencode.json', info: {…} }`
 *   `{ type: 'directory', path: '…/opencode' }`
 * 而旧实现直接 `adaptEnvelope(res) as Config` —— `adaptEnvelope` 只在有 `data`
 * 字段时取值，数组没有 `data`，于是原样返回数组。结果 `config.shell`、
 * `config.model` 全是 `undefined`，设置页读到的「当前配置」永远是空对象，
 * 保存时 `createMergePatch(original, snapshot)` 两边都是坏数组 → 写入必然无效。
 *
 * 摊平规则与服务端一致：**从低优先级到高优先级依次深合并**，后者覆盖前者。
 * `type: 'directory'` 条目只是「这个目录下存在配置」的标记（没有 `info`），
 * 不参与合并，仅用于告知调用方配置来源目录。
 */
function flattenConfigEntries(raw: unknown): { config: Record<string, unknown>; sources: string[] } {
  const entries = Array.isArray(raw) ? raw : []
  const sources: string[] = []
  let merged: Record<string, unknown> = {}
  for (const entry of entries) {
    const e = rec(entry)
    const path = typeof e.path === 'string' ? e.path : undefined
    if (path) sources.push(path)
    if (e.type !== 'document') continue
    const info = rec(e.info)
    if (Object.keys(info).length === 0) continue
    merged = deepMergeConfig(merged, info)
  }
  return { config: merged, sources }
}

/**
 * 原生获取配置（v2 config.get 返回 Config.Entry[]，摊平为单个 Config 对象）。
 */
export async function nativeGetConfig(serverId: string | undefined, input: { directory?: string }): Promise<unknown> {
  const client = getV2Client(serverId)
  const res = await client.config.get({
    location: input.directory ? { directory: input.directory } : undefined,
  })
  return flattenConfigEntries(res).config
}

/**
 * 原生获取配置**及来源**（v2 config.get 原始 entries → { config, sources }）。
 *
 * 设置页需要展示「这份配置来自哪些文件」，且必须知道最高优先级的那个文档路径，
 * 才能在保存时写回正确的位置。
 */
export async function nativeGetConfigWithSources(
  serverId: string | undefined,
  input: { directory?: string },
): Promise<{ config: Record<string, unknown>; sources: string[] }> {
  const client = getV2Client(serverId)
  const res = await client.config.get({
    location: input.directory ? { directory: input.directory } : undefined,
  })
  return flattenConfigEntries(res)
}

/**
 * 读取**原始配置条目**（保留每份文档各自的 info，不做合并）。
 *
 * 保存时必须用这个而不是合并结果：`config.get` 会把多份配置（全局 + 项目）
 * 合并成一份「生效配置」。如果把合并结果整体写回某一份文件，就会把低优先级
 * 文件里的内容复制进高优先级文件 —— 用户之后再改低优先级文件就完全不生效了。
 */
export async function nativeGetConfigEntries(
  serverId: string | undefined,
  input: { directory?: string },
): Promise<Array<{ type: 'document' | 'directory'; path?: string; info: Record<string, unknown> }>> {
  const client = getV2Client(serverId)
  const res = await client.config.get({
    location: input.directory ? { directory: input.directory } : undefined,
  })
  const entries = Array.isArray(res) ? res : []
  return entries.map(item => {
    const e = rec(item)
    return {
      type: e.type === 'directory' ? ('directory' as const) : ('document' as const),
      path: typeof e.path === 'string' ? e.path : undefined,
      info: rec(e.info),
    }
  })
}

/**
 * 直接写一个文件到服务端磁盘（v2 `POST /api/experimental/fs/write`）。
 *
 * 这是唯一能把配置真正存下去的路径：`config.update` 的 schema 只有 `shell`
 * 一个字段（见 packages/schema/src/config.ts 的 `Config.Patch`），其余字段
 * 一律被忽略且返回成功 —— 也就是「保存了但没生效」。
 *
 * 目标路径不限于 location 目录（与 fs.read 不同），因此可以写
 * `~/.config/opencode/opencode.json`。
 */
export async function nativeWriteFile(
  serverId: string | undefined,
  input: { path: string; content: string },
): Promise<void> {
  const client = getV2Client(serverId)
  await client.file.write({ path: input.path, body: new TextEncoder().encode(input.content) } as never)
}

/**
 * 让服务端重新加载所有 location 的配置（v2 `location.reload`）。
 *
 * 写盘之后必须调用，否则内存里还是旧配置。注意它会重建所有已加载的 location：
 * 进行中的权限/表单会被取消，运行中的会话在下一个 step 边界换用新服务。
 */
export async function nativeReloadLocations(serverId: string | undefined): Promise<void> {
  const client = getV2Client(serverId)
  await client.location.reload()
}

/**
 * 原生获取 provider + models 合并结果（v2 provider.list + model.list）。
 */
export async function nativeGetProviders(
  serverId: string | undefined,
  input: { directory?: string },
): Promise<ProvidersResponse> {
  const client = getV2Client(serverId)
  const loc = input.directory ? { directory: input.directory } : undefined
  const [providersRes, modelsRes] = await Promise.all([
    client.provider.list({ location: loc }),
    client.model.list({ location: loc }).catch(() => ({ data: [] })),
  ])
  return { providers: adaptProviders(adaptDataList(providersRes), adaptDataList(modelsRes)) } as ProvidersResponse
}
