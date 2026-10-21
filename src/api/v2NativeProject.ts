// ============================================
// v2 原生 Project / Location 访问层
//
// 直接用 @opencode/client（v2 原生）调用 project/location。
// ============================================

import { getV2Client } from './sdkV2'
import { adaptEnvelope } from './v2/session'
import { rec, str } from './v2/adapt'

/** 规范化路径：统一分隔符、去尾斜杠；foldCase 时再折叠大小写（Windows 盘符/路径大小写不敏感）。 */
function normalizePath(p: string | undefined, foldCase: boolean): string {
  if (!p) return ''
  const out = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return foldCase ? out.toLowerCase() : out
}

/** 两个路径是否同一处：先按规范化原样比，再折叠大小写比（覆盖 Windows 大小写/反斜杠）。 */
function pathMatches(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const an = normalizePath(a, false)
  const bn = normalizePath(b, false)
  if (!an || !bn) return false
  return an === bn || an.toLowerCase() === bn.toLowerCase()
}

/**
 * 原生获取当前项目。
 *
 * ⚠️ 不能用 location.get 的 project 字段判断 git：v2 的 location.get 返回
 * `{ id, directory, canonical }`，**不含 `vcs`**。vcs 只在 project.list 的项目
 * 上有（`vcs: "git"`）。此前用 location.get 近似，git 仓库也永远识别不到，
 * 变更面板一直显示「初始化 Git 仓库」、变更标签降级成文件树。
 *
 * 检测顺序（从最可靠到兜底）：
 *   1. project.list 里 **同 id** 的项目（id 是哈希，不受 Windows 反斜杠 /
 *      大小写 / 会话目录是仓库子目录等影响）；
 *   2. 按规范化路径匹配 canonical/directory/worktree；
 *   3. vcs.get 的 provider === 'git'（信息面板同款链路，最直接）。
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
  const locationId = str(project.id) ?? ''
  const directory = str(project.directory)
  const canonical = str(project.canonical)
  const base = {
    id: locationId || directory || '',
    worktree: canonical ?? directory ?? '',
    name: str(project.name),
  }

  let vcs: 'git' | undefined

  // 1) project.list 同 id，或规范化路径匹配（list 才带 vcs）
  try {
    const list = await client.project.list({})
    if (Array.isArray(list)) {
      const matched =
        (locationId ? list.find(p => str(rec(p).id) === locationId) : undefined) ??
        list.find(p => {
          const r = rec(p)
          return (
            pathMatches(str(r.canonical), canonical) ||
            pathMatches(str(r.directory), directory) ||
            pathMatches(str(r.canonical), directory) ||
            pathMatches(str(r.worktree), canonical)
          )
        })
      if (matched && str(rec(matched).vcs) === 'git') vcs = 'git'
    }
  } catch {
    // project.list 不可用，继续用 vcs.get 兜底
  }

  // 2) vcs.get 的 provider 兜底（与信息面板「分支」同源，Windows 上也可靠）
  if (!vcs) {
    try {
      const v = rec(adaptEnvelope(await client.vcs.get({
        location: input.directory ? { directory: input.directory } : undefined,
      })))
      if (str(v.provider) === 'git') vcs = 'git'
    } catch {
      // 非 git 或不可用 → 保持 undefined
    }
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
