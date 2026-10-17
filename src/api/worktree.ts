// ============================================
// Worktree API - Git Worktree 管理
// ============================================

import { getSDKClient, unwrap } from './sdk'
import { nativeListWorktrees, nativeCreateWorktree } from './v2NativeWorktree'
import type { Worktree, WorktreeCreateInput, WorktreeRemoveInput, WorktreeResetInput } from '../types/api/worktree'
import { formatPathForApi } from '../utils/directoryUtils'
import { serverStore } from '../store/serverStore'

/**
 * 获取所有 worktree 列表
 */
export async function listWorktrees(directory?: string, serverId?: string): Promise<string[]> {
  const sid = serverId ?? serverStore.getActiveServerId()
  if (serverStore.getApiVersion(sid) === 'v2') {
    return nativeListWorktrees(sid, { directory })
  }
  const sdk = getSDKClient(serverId)
  return unwrap(await sdk.worktree.list({ directory: formatPathForApi(directory, serverId) }))
}

/**
 * 创建新的 worktree
 */
export async function createWorktree(params: WorktreeCreateInput, directory?: string, serverId?: string): Promise<Worktree> {
  const sid = serverId ?? serverStore.getActiveServerId()
  if (serverStore.getApiVersion(sid) === 'v2') {
    const created = await nativeCreateWorktree(sid, {
      directory,
      name: params.name,
    })
    return created as unknown as Worktree
  }
  const sdk = getSDKClient(sid)
  return unwrap(await sdk.worktree.create({ directory: formatPathForApi(directory, sid), worktreeCreateInput: params }))
}

/**
 * 删除 worktree
 */
export async function removeWorktree(params: WorktreeRemoveInput, directory?: string): Promise<boolean> {
  const sid = serverStore.getActiveServerId()
  const sdk = getSDKClient(sid)
  unwrap(await sdk.worktree.remove({ directory: formatPathForApi(directory, sid), worktreeRemoveInput: params }))
  return true
}

/**
 * 重置 worktree
 */
export async function resetWorktree(params: WorktreeResetInput, directory?: string): Promise<boolean> {
  const sid = serverStore.getActiveServerId()
  const sdk = getSDKClient(sid)
  unwrap(await sdk.worktree.reset({ directory: formatPathForApi(directory, sid), worktreeResetInput: params }))
  return true
}
