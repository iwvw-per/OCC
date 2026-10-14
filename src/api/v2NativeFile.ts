// ============================================
// v2 原生 File 访问层
//
// 直接用 @opencode/client（v2 原生）调用 file/find，
// 不经过 clientFacade 的 v1→v2 facade 层。
// ============================================

import { getV2Client } from './sdkV2'
import { adaptDataList, adaptEnvelope } from './v2/session'
import { adaptFileNode } from './v2/entities'
import { rec, str } from './v2/adapt'
import type { FileNode } from './types'

/**
 * 原生列出目录（v2 file.list，返回 FileSystem.Entry[]，适配为 FileNode[]）。
 */
export async function nativeListDirectory(
  serverId: string | undefined,
  input: { directory?: string; path?: string },
): Promise<FileNode[]> {
  const client = getV2Client(serverId)
  const res = await client.file.list({
    location: input.directory ? { directory: input.directory } : undefined,
    path: input.path,
  })
  const entries = Array.isArray(adaptEnvelope(res)) ? (adaptEnvelope(res) as unknown[]) : []
  return entries.map(entry => adaptFileNode(entry, { directory: input.directory }))
}

/**
 * 原生读取文件内容（v2 file.read）。
 */
export async function nativeReadFile(
  serverId: string | undefined,
  input: { directory?: string; path: string },
): Promise<unknown> {
  const client = getV2Client(serverId)
  const res = await client.file.read({
    location: input.directory ? { directory: input.directory } : undefined,
    path: input.path,
  })
  return adaptEnvelope(res)
}

/**
 * 原生搜索文件（v2 file.find，返回路径数组）。
 */
export async function nativeFindFiles(
  serverId: string | undefined,
  input: { directory?: string; query: string; type?: string; limit?: number },
): Promise<string[]> {
  const client = getV2Client(serverId)
  const res = await client.file.find({
    location: input.directory ? { directory: input.directory } : undefined,
    query: input.query,
    type: input.type as never,
    limit: input.limit,
  })
  const entries = Array.isArray(adaptDataList(res)) ? (adaptDataList(res) as unknown[]) : []
  return entries.map(entry => str(rec(entry).path) ?? '')
}
