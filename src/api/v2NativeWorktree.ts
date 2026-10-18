// ============================================
// v2 原生 Worktree 访问层
//
// v2 的 worktree API 以 projectID 为键（v1 用 directory）。
// 这里先从 location.get 解析当前 projectID，再调 v2 worktree。
// ============================================

import { getV2Client } from './sdkV2'
import { rec, str } from './v2/adapt'

async function resolveProjectID(serverId: string | undefined, input: { directory?: string }): Promise<string> {
  const client = getV2Client(serverId)
  const info = rec(await client.location.get({
    location: input.directory ? { directory: input.directory } : undefined,
  }))
  const project = rec(info.project)
  return str(project.id) ?? str(project.directory) ?? ''
}

/**
 * 原生列出 worktree（v2 worktree.list，需 projectID）。
 */
export async function nativeListWorktrees(
  serverId: string | undefined,
  input: { directory?: string },
): Promise<string[]> {
  const projectID = await resolveProjectID(serverId, input)
  if (!projectID) return []
  const client = getV2Client(serverId)
  const res = await client.worktree.list({ projectID })
  const list = Array.isArray(res) ? res : []
  return list.map(item => {
    const w = rec(item)
    return str(w.directory) ?? str(w.name) ?? ''
  })
}

/**
 * 原生删除 worktree（v2 worktree.remove，按目录名 + 强制）。
 */
export async function nativeRemoveWorktree(
  serverId: string | undefined,
  input: { directory?: string; worktreeDirectory: string; force?: boolean },
): Promise<boolean> {
  const projectID = await resolveProjectID(serverId, input)
  if (!projectID) return false
  const client = getV2Client(serverId)
  await client.worktree.remove({
    projectID,
    directory: input.worktreeDirectory as never,
    force: input.force ?? true,
  })
  return true
}

/**
 * 原生刷新 worktree 列表（v2 worktree.refresh，让服务端重新扫描）。
 */
export async function nativeRefreshWorktrees(
  serverId: string | undefined,
  input: { directory?: string },
): Promise<boolean> {
  const projectID = await resolveProjectID(serverId, input)
  if (!projectID) return false
  const client = getV2Client(serverId)
  await client.worktree.refresh({ projectID })
  return true
}

/**
 * 原生创建 worktree（v2 worktree.create，需 projectID）。
 */
export async function nativeCreateWorktree(
  serverId: string | undefined,
  input: { directory?: string; from?: string; branch?: string; directoryPath?: string; name?: string },
): Promise<Record<string, unknown> | null> {
  const projectID = await resolveProjectID(serverId, input)
  if (!projectID) return null
  const client = getV2Client(serverId)
  const res = await client.worktree.create({
    projectID,
    from: input.from,
    branch: input.branch,
    directory: input.directoryPath,
    name: input.name,
  })
  return rec(res)
}
