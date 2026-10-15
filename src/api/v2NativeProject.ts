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
 * 原生获取当前项目。
 *
 * ⚠️ 不能用 location.get 的 project 字段判断 git：v2 的 location.get 返回
 * `{ id, directory, canonical }`，**不含 `vcs`**。vcs 只在 project.list 的项目
 * 上有（`vcs: "git"`）。此前用 location.get 近似，git 仓库也永远识别不到，
 * 变更面板一直显示「初始化 Git 仓库」、变更标签降级成文件树。
 *
 * 这里以 location.get 建立基本结构，再按 directory/canonical 从 project.list
 * 匹配同名项目补上 vcs。
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
  const base = {
    id: str(project.id) ?? str(project.directory) ?? '',
    worktree: str(project.canonical) ?? str(project.directory) ?? '',
    name: str(project.name),
  }
  // 按目录匹配 project.list 里的项目（list 才带 vcs），补 git 检测
  const target = input.directory ?? base.worktree
  const normalized = target.replace(/[/\\]+$/, '')
  let vcs: 'git' | undefined
  try {
    const list = await client.project.list({})
    if (Array.isArray(list)) {
      const matched = list.find(
        p =>
          rec(p).directory === normalized ||
          rec(p).canonical === normalized ||
          str(rec(p).directory) === normalized ||
          str(rec(p).canonical) === normalized,
      )
      vcs = str(rec(matched).vcs) === 'git' ? 'git' : undefined
    }
  } catch {
    // project.list 不可用时退回 location.get 的结果（vcs 为空）
  }
  return { ...base, vcs }
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
