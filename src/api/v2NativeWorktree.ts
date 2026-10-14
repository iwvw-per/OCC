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
