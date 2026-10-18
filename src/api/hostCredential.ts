// ============================================
// 服务器凭据的宿主托管（桌面端）
//
// 参考 OpenCode Desktop 的模型：渲染进程只知道服务地址，密码由宿主进程保存，
// 请求发出前由宿主补 Authorization。渲染进程因此：
//   - 读不到密码（XSS 拿不到）；
//   - 不带 Authorization（GET 保持 CORS-simple，可省掉预检）。
//
// 浏览器没有宿主进程，本模块在生产环境恒为「未启用」，调用方走原有路径。
// ============================================

import { isTauri } from '../utils/tauri'
import { invoke } from '@tauri-apps/api/core'
import { readHostBootstrap } from '../utils/hostBootstrap'
import { makeAuthHeader, type ServerAuth } from '../store/serverStore'

/** 宿主凭据通道是否可用。 */
export function hostCredentialsAvailable(): boolean {
  if (!isTauri()) return false
  const host = readHostBootstrap().host
  // 宿主标识存在说明窗口由宿主创建，可以走宿主任命令
  return host === 'tauri'
}

/**
 * 把凭据交给宿主保存（首次迁移 / 修改密码时调用）。
 *
 * 失败时返回 false，调用方继续使用渲染进程内的凭据，不阻断使用。
 */
export async function handOffCredential(serverId: string, auth: ServerAuth): Promise<boolean> {
  if (!hostCredentialsAvailable()) return false
  try {
    await invoke('credential_set', {
      serverId,
      authorization: makeAuthHeader(auth),
    })
    return true
  } catch {
    return false
  }
}

/** 从宿主删除凭据（删除服务器时调用）。 */
export async function forgetHostCredential(serverId: string): Promise<void> {
  if (!hostCredentialsAvailable()) return
  await invoke('credential_delete', { serverId }).catch(() => undefined)
}

/**
 * 请求是否应交给「宿主补头」的路径。
 *
 * 返回 true 时调用方不应再自行拼接 Authorization —— 否则会出现两份凭据。
 */
export async function hostOwnsCredential(serverId: string): Promise<boolean> {
  if (!hostCredentialsAvailable()) return false
  try {
    return await invoke<boolean>('credential_has', { serverId })
  } catch {
    return false
  }
}
