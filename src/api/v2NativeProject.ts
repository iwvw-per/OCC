// ============================================
// v2 原生 Project / Location 访问层
//
// 直接用 @opencode/client（v2 原生）调用 project/location，
// 不经过 clientFacade 的 v1→v2 facade 层。
// ============================================

import { getV2Client } from './sdkV2'
import { adaptEnvelope } from './v2/session'
import { rec, str } from './v2/adapt'

/**
 * 原生获取当前项目（v2 用 location.get 的 project 字段近似）。
 */
export async function nativeGetCurrentProject(
  serverId: string | undefined,
  input: { directory?: string },
): Promise<{ id: string; worktree: string; vcs?: 'git'; name?: string }> {
  const client = getV2Client(serverId)
  const info = rec(await client.location.get({
    location: input.directory ? { directory: input.directory } : undefined,
  }))
  const project = rec(info.project)
  return {
    id: str(project.id) ?? str(project.directory) ?? '',
    worktree: str(project.canonical) ?? str(project.directory) ?? '',
    vcs: project.vcs as 'git' | undefined,
    name: str(project.name),
  }
}

/**
 * 原生获取项目列表（v2 project.list）。
 */
export async function nativeListProjects(serverId: string | undefined, _input: { directory?: string }): Promise<unknown[]> {
  const client = getV2Client(serverId)
  const res = await client.project.list({})
  return Array.isArray(res) ? res : []
}

/**
 * 原生初始化 Git（v2 vcs.init）。
 */
export async function nativeInitGit(serverId: string | undefined): Promise<unknown> {
  const client = getV2Client(serverId)
  const res = await client.vcs.init({})
  return adaptEnvelope(res)
}
