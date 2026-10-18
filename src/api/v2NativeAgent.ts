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
  input: { mode: string; directory?: string; base?: string },
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
  })
  return adaptDataList(res)
}

/**
 * 原生列出权限请求（v2 permission.request.list）。
 */
export async function nativeListPermissions(serverId: string | undefined): Promise<PermissionRequest[]> {
  const client = getV2Client(serverId)
  const res = await client.permission.request.list()
  return adaptDataList(res).map(adaptPermission)
}
