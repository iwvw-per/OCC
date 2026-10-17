import type { GitWorkspaceMeta } from '../../../hooks'
import { isSameDirectory, normalizeToForwardSlash, type SessionSortField } from '../../../utils'

export function isWorkspaceRootDirectory(directory: string, meta: GitWorkspaceMeta | undefined) {
  if (!meta?.isGit) return false
  return meta.workspaces.some(workspace => isSameDirectory(workspace, directory))
}

/**
 * 解析一个目录所属的项目分组身份。
 *
 * 当 git 根目录已不存在（仓库整体搬家：project.current 仍返回旧 worktree，
 * 旧路径磁盘上已没有）时，**不再**聚合到旧根，直接以目录自身为身份。
 * 否则新目录会被挂进旧项目行，行上的 worktree 仍是旧路径 —— 表现为
 * 「在新位置导入项目，新建对话/会话列表却回到旧目录」。
 */
export function getProjectGroupIdentity(
  directory: string,
  meta: GitWorkspaceMeta | undefined,
) {
  const normalizedDirectory = normalizeToForwardSlash(directory)

  if (isWorkspaceRootDirectory(normalizedDirectory, meta) && meta && meta.rootExists !== false) {
    return {
      projectId: meta.rootDirectory,
      workspaceDirectories: meta.workspaces,
    }
  }

  // 根已失效：只保留本目录自己，sandboxes 里其它仍存在的目录各自成组，
  // 不要把失效旧根继续塞进工作区列表。
  const liveWorkspaces = meta?.isGit && meta.rootExists === false
    ? meta.workspaces.filter(workspace => normalizeToForwardSlash(workspace) !== meta.rootDirectory)
    : undefined

  return {
    projectId: normalizedDirectory,
    workspaceDirectories: liveWorkspaces && liveWorkspaces.length > 1 ? liveWorkspaces : undefined,
  }
}

interface SortableProject {
  worktree?: string
  name: string
  /** 项目被保存到侧栏的时间（稳定，不随会话活动变化） */
  addedAt?: number
}

/**
 * 项目文件夹排序（仅作用于「已保存项目」，派生项目由调用方剥离）。
 *
 * - created：按项目保存时间排序。保存时间是稳定值，会话活动不会改变它。
 * - updated：按最后一次对话时间排序（用户最后一条消息的锚点，单调只增，
 *   多个会话并行运行时也不会来回跳）。
 *
 * 时间相同按名称兜底，保证稳定。纯函数，便于单测。
 */
export function sortProjects<T extends SortableProject>(
  projects: T[],
  field: SessionSortField,
  lastUsedAt: Record<string, number>,
  desc: boolean,
): T[] {
  const sortTime = (project: SortableProject): number => {
    if (field === 'created') return project.addedAt ?? 0
    return lastUsedAt[normalizeToForwardSlash(project.worktree || '')] ?? 0
  }

  return [...projects].sort((a, b) => {
    const ta = sortTime(a)
    const tb = sortTime(b)
    if (ta !== tb) return desc ? tb - ta : ta - tb
    return a.name.localeCompare(b.name)
  })
}

/**
 * 合并项目行「最后对话时间」的三个来源，得到 worktree → 时间戳。
 *
 * 优先级：会话活动锚点（用户最后一条消息时间，单调只增）最高；锚点缺失时
 * （冷启动尚未加载用户消息）回退到服务端按目录拉取的最大 time.updated，再兜底
 * 本地点击记录 recentProjects。
 *
 * 关键：不能对锚点与服务端 time.updated 取 max。assistant 流式输出会持续抬高
 * time.updated，多个项目并行运行时两边数值交替超越，项目顺序来回交换。锚点才是
 * 抗抖动的稳定排序依据；time.updated 仅作冷启动的一次性基线。
 */
export function mergeProjectLastUsed(
  worktrees: string[],
  recentProjects: Record<string, number>,
  fetchedLastUsed: Record<string, number>,
  getAnchor: (worktree: string) => number | undefined,
): Record<string, number> {
  const map: Record<string, number> = { ...recentProjects }
  for (const [directory, updated] of Object.entries(fetchedLastUsed)) map[directory] = updated
  for (const worktree of worktrees) {
    const anchor = getAnchor(worktree)
    if (anchor !== undefined) map[worktree] = anchor
  }
  return map
}
