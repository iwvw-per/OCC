// ============================================
// Config API - 配置管理
// ============================================

import { getV2Client } from './sdkV2'
import {
  nativeGetConfig,
  nativeGetConfigEntries,
  nativeGetProviders,
  nativeReloadLocations,
  nativeWriteFile,
} from './v2NativeConfig'
import { createMergePatch } from '../features/settings/components/configEditorUtils'
import { deepMergeConfig } from '../utils/deepMerge'
import { serverStore } from '../store/serverStore'
import type { Config } from '../types/api/config'
import type { ProvidersResponse } from '../types/api/model'

/**
 * 获取当前配置
 */
export async function getConfig(directory?: string): Promise<Config> {
  const sid = serverStore.getActiveServerId()
  return nativeGetConfig(sid, { directory }) as Config
}

/**
 * 获取用户全局配置（官方桌面设置写入的配置源）
 */
export async function getGlobalConfig(): Promise<Config> {
  const sid = serverStore.getActiveServerId()
  return nativeGetConfig(sid, {}) as Config
}

/**
 * 更新配置。
 *
 * v2 的 `config.update` schema 只有 `shell` 一个字段（`Config.Patch`），其余字段
 * 一律被忽略但返回成功 —— 也就是「保存了但没生效」。真正的写入路径是：
 *
 *   1. 读出**目标文件**的原始内容（不能拿合并后的生效配置，否则会把低优先级
 *      文件的内容复制进高优先级文件）
 *   2. 只把用户实际改动的字段合进去（merge patch）
 *   3. `fs.write` 写回该文件
 *   4. `location.reload` 让服务端重新加载
 *
 * `shell` 仍走原生 `config.update`：这是唯一被官方支持的字段，交给服务端处理
 * 更稳（它会自己挑最高优先级的全局配置文档）。
 */
export async function updateConfig(config: Config, _directory?: string): Promise<Config> {
  const sid = serverStore.getActiveServerId()
  const shell = config.shell
  if (shell !== undefined) await getV2Client(sid).config.update({ shell })
  return config
}

/**
 * 把配置改动写回服务端文件并重载。
 *
 * @param original 编辑前的**生效配置**（用于算 patch）
 * @param snapshot 编辑后的生效配置
 * @returns 写入的文件路径
 */
export async function saveConfig(original: Config, snapshot: Config): Promise<{ path: string }> {
  const sid = serverStore.getActiveServerId()
  const patch = createMergePatch(original, snapshot)
  // 没有任何改动：不发写请求，也不 reload（reload 会重建所有 location，代价不小）
  if (Object.keys(patch).length === 0) {
    return { path: '' }
  }

  // shell 交给原生端点：它是唯一被 config.update 支持的字段，且服务端知道该写哪份文档。
  // 从 patch 里摘掉，避免同一字段既走 PATCH 又走文件写入。
  const { shell, ...rest } = patch
  if (shell !== undefined) await getV2Client(sid).config.update({ shell: shell as string | null })

  if (Object.keys(rest).length === 0) return { path: '' }

  // 目标文件：优先写「全局配置文档」（用户在这个界面改的就是它）。
  // config.get 的 entries 按优先级从低到高排列，最后一个 document 就是最高优先级
  // 的那份 —— 但项目级文档也在其中。用户从设置页保存时应落在全局文档上，因此
  // 这里按「不带 directory 查询」得到全局文档集合，取其中最后一份。
  const entries = await nativeGetConfigEntries(sid, {})
  const documents = entries.filter(entry => entry.type === 'document' && entry.path)
  const target = documents.at(-1)
  if (!target?.path) throw new Error('No writable config document found')

  const current = target.info
  const merged = deepMergeConfig(current, rest)
  await nativeWriteFile(sid, { path: target.path, content: `${JSON.stringify(merged, null, 2)}\n` })
  await nativeReloadLocations(sid)
  return { path: target.path }
}

/**
 * 获取 provider 配置列表
 */
export async function getProviderConfigs(directory?: string): Promise<ProvidersResponse> {
  const sid = serverStore.getActiveServerId()
  return nativeGetProviders(sid, { directory })
}
