// ============================================
// Worktree API - Git Worktree 管理
// ============================================

import { nativeListWorktrees, nativeCreateWorktree, nativeRemoveWorktree, nativeRefreshWorktrees } from './v2NativeWorktree'
import type { Worktree, WorktreeCreateInput } from '../types/api/worktree'
import { serverStore } from '../store/serverStore'

/**
 * 获取所有 worktree 列表
 */
export async function listWorktrees(directory?: string, serverId?: string): Promise<string[]> {
  const sid = serverId ?? serverStore.getActiveServerId()
  return nativeListWorktrees(sid, { directory })
}

/**
 * 创建新的 worktree
 */
export async function createWorktree(params: WorktreeCreateInput, directory?: string, serverId?: string): Promise<Worktree> {
  const sid = serverId ?? serverStore.getActiveServerId()
  const created = await nativeCreateWorktree(sid, {
    directory,
    name: params.name,
  })
  return created as unknown as Worktree
}

/**
 * 删除 worktree
 */
/**
 * 删除 worktree
 */
export async function removeWorktree(directory: string, baseDirectory?: string, serverId?: string): Promise<boolean> {
  const sid = serverId ?? serverStore.getActiveServerId()
  return nativeRemoveWorktree(sid, { directory: baseDirectory, worktreeDirectory: directory, force: true })
}

/**
 * 刷新 worktree 列表（v2 无 v1 的 reset 语义，这里等价于让服务端重新扫描）
 */
export async function resetWorktree(_directory: string, baseDirectory?: string, serverId?: string): Promise<boolean> {
  const sid = serverId ?? serverStore.getActiveServerId()
  return nativeRefreshWorktrees(sid, { directory: baseDirectory })
}
