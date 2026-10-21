// ============================================
// v2 原生 Agent / MCP / VCS / Permission 访问层
//
// 直接用 @opencode/client（v2 原生）调用。
// ============================================

import { getV2Client } from './sdkV2'
import { adaptDataList, adaptEnvelope } from './v2/session'
import { adaptAgent, adaptMcpStatus } from './v2/entities'
import { rec, str } from './v2/adapt'
import type { ApiAgent, PermissionRequest } from './types'
import { adaptPermission } from './v2/entities'

/**
 * 原生列出 agent（v2 agent.list）。
 */
export async function nativeListAgents(
  serverId: string | undefined,
  input: { directory?: string },
): Promise<ApiAgent[]> {
  const client = getV2Client(serverId)
  const res = await client.agent.list({
    location: input.directory ? { directory: input.directory } : undefined,
  })
  return adaptDataList(res).map(adaptAgent)
}

/**
 * 原生获取 MCP 状态（v2 mcp.list → {name: status} map）。
 */
export async function nativeGetMcpStatus(serverId: string | undefined): Promise<Record<string, unknown>> {
  const client = getV2Client(serverId)
  const res = await client.mcp.list()
  return adaptMcpStatus(adaptDataList(res))
}

/**
 * 原生获取 VCS 信息（v2 vcs.get，branch 对象 → string）。
 */
export async function nativeGetVcsInfo(
  serverId: string | undefined,
  input: { directory?: string },
): Promise<Record<string, unknown>> {
  const client = getV2Client(serverId)
  const info = rec(
    adaptEnvelope(
      await client.vcs.get({ location: input.directory ? { directory: input.directory } : undefined }),
    ),
  )
  const branch = rec(info.branch)
  return {
    ...info,
    branch: str(branch.current) ?? str(info.branch) ?? '',
    default_branch: str(branch.default) ?? '',
  }
}

/**
 * diff 默认的上下文行数。
 *
 * ⚠️ 不要在这里默认传小 `context`：`DiffViewer` 的「展开更多上下文」是**纯本地**
 * 操作（`collapseContextPaired` 把已有全文按 CONTEXT_LINES 折叠，展开只是多保留
 * 几行）。服务端 `context` 一旦收窄，patch 里就只有改动附近的几行，展开按钮会
 * 因为「没有更多内容可展开」而消失 —— 实测传 context=3 时，面板里所有折叠区
 * 都不再出现，属于功能退化。
 *
 * 因此默认**不传** `context`（服务端返回整文件 patch，展开可用）。只有在明确
 * 知道调用方不需要展开时（如超大仓库的批量预取），才显式传小值。
 */
export const DEFAULT_DIFF_CONTEXT: number | undefined = undefined

/**
 * 原生获取 VCS diff（v2 vcs.diff → FileDiff[]）。
 * v2 返回 `{ location, data: FileDiff[] }`，data 内字段与前端 FileDiff
 * （file/patch/additions/deletions/status）一致，直接透传。
 *
 * ⚠️ mode 映射：前端沿用 v1 的 mode 命名（git/branch），v2 只接受
 * `working | branch | committed`。前端 "git changes"（工作区变更）对应 v2 的
 * `working`，否则传 'git' 会 400，变更面板显示 "Failed to load changes"。
 */
export async function nativeGetVcsDiff(
  serverId: string | undefined,
  input: { mode: string; directory?: string; base?: string; context?: number },
): Promise<unknown[]> {
  const client = getV2Client(serverId)
  const mode =
    input.mode === 'git'
      ? 'working'
      : input.mode === 'branch' || input.mode === 'committed'
        ? (input.mode as 'branch' | 'committed')
        : 'working'
  const res = await client.vcs.diff({
    location: input.directory ? { directory: input.directory } : undefined,
    mode,
    base: input.base,
    context: input.context ?? DEFAULT_DIFF_CONTEXT,
  })
  return adaptDataList(res)
}

/**
 * 原生获取工作区未提交改动状态（v2 vcs.status）。
 *
 * 返回每个改动文件的 `{ file, additions, deletions, status }`，是文件树状态标记
 * 与服务端权威 diff 计数的来源。
 */
export async function nativeGetVcsStatus(
  serverId: string | undefined,
  input: { directory?: string },
): Promise<Array<{ file: string; additions: number; deletions: number; status: 'added' | 'deleted' | 'modified' }>> {
  const client = getV2Client(serverId)
  const res = await client.vcs.status({
    location: input.directory ? { directory: input.directory } : undefined,
  })
  const list = adaptDataList(res)
  return list.flatMap(item => {
    const row = rec(item)
    const file = str(row.file)
    if (!file) return []
    const status = str(row.status)
    return [
      {
        file,
        additions: typeof row.additions === 'number' ? row.additions : 0,
        deletions: typeof row.deletions === 'number' ? row.deletions : 0,
        status: status === 'added' || status === 'deleted' ? status : 'modified',
      },
    ]
  })
}

/**
 * 原生列出权限请求（v2 permission.request.list）。
 */
export async function nativeListPermissions(serverId: string | undefined): Promise<PermissionRequest[]> {
  const client = getV2Client(serverId)
  const res = await client.permission.request.list()
  return adaptDataList(res).map(adaptPermission)
}
