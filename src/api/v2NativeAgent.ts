// ============================================
// v2 原生 Agent / MCP / VCS / Permission 访问层
//
// 直接用 @opencode/client（v2 原生）调用，不经过 clientFacade。
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
 * 原生列出权限请求（v2 permission.request.list）。
 */
export async function nativeListPermissions(serverId: string | undefined): Promise<PermissionRequest[]> {
  const client = getV2Client(serverId)
  const res = await client.permission.request.list()
  return adaptDataList(res).map(adaptPermission)
}
