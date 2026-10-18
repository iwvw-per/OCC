// ============================================
// Config API - 配置管理
// ============================================

import { getV2Client } from './sdkV2'
import { nativeGetConfig, nativeGetProviders } from './v2NativeConfig'
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
 * 更新配置
 *
 * v2 的 config.update 仅支持 shell，其余字段忽略（返回成功但不生效）。
 */
export async function updateConfig(config: Config, _directory?: string): Promise<Config> {
  const sid = serverStore.getActiveServerId()
  const shell = config.shell
  if (shell !== undefined) await getV2Client(sid).config.update({ shell })
  return config
}

/**
 * 更新用户全局配置。
 * 官方接口是 deep merge patch：支持新增/修改，不支持删除任意字段。
 */
export async function updateGlobalConfig(config: Config): Promise<Config> {
  return updateConfig(config)
}

/**
 * 获取 provider 配置列表
 */
export async function getProviderConfigs(directory?: string): Promise<ProvidersResponse> {
  const sid = serverStore.getActiveServerId()
  return nativeGetProviders(sid, { directory })
}
