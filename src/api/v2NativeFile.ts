// ============================================
// v2 原生 File 访问层
//
// 直接用 @opencode/client（v2 原生）调用 file/find。
// ============================================

import { getV2Client } from './sdkV2'
import { adaptDataList, adaptEnvelope } from './v2/session'
import { adaptFileNode } from './v2/entities'
import { rec, str } from './v2/adapt'
import { extToMime } from '../utils/tauri'
import type { FileContent, FileNode } from './types'

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

/** 头部出现 NUL 基本可判定为二进制(与常见编辑器启发式一致) */
function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8000)
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) return true
  }
  return false
}

/**
 * v2 的 file.read 直接返回字节流(Uint8Array),而 UI 层消费的是 v1 的
 * `{ type, content, encoding?, mimeType? }`。这里做一次归一化:
 * 文本解码成字符串,二进制转 base64 并按扩展名补 mimeType。
 */
export function normalizeFileReadResult(raw: unknown, path: string): unknown {
  const bytes = toBytes(raw)
  if (!bytes) return raw

  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const mimeType = ext ? extToMime(ext) : ''
  const resolvedMime = mimeType || undefined

  if (looksBinary(bytes)) {
    return {
      type: 'binary',
      content: bytesToBase64(bytes),
      encoding: 'base64',
      mimeType: resolvedMime,
    } satisfies FileContent
  }

  return {
    type: 'text',
    content: new TextDecoder().decode(bytes),
    mimeType: resolvedMime,
  } satisfies FileContent
}

/** 跨 realm 安全的字节判定(fetch / TextEncoder 返回的 Uint8Array 可能来自不同全局) */
function toBytes(raw: unknown): Uint8Array | null {
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  }
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  return null
}

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
  return normalizeFileReadResult(adaptEnvelope(res), input.path)
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
