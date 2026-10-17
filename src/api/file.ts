// ============================================
// File Search API Functions
// 基于 @opencode-ai/sdk: /file, /find/file, /find/symbol 相关接口
// ============================================

import { getSDKClient, unwrap } from './sdk'
import { nativeListDirectory, nativeReadFile, nativeFindFiles } from './v2NativeFile'
import { formatPathForApi, directoryCacheKey } from '../utils/directoryUtils'
import type { FileNode, FileContent, FileStatusItem, TextSearchMatch } from './types'
import { serverStore } from '../store/serverStore'

const ROOT_DIRECTORY_CACHE_TTL_MS = 10_000

const rootDirectoryCache = new Map<string, { data: FileNode[]; expiresAt: number }>()
const rootDirectoryInflight = new Map<string, Promise<FileNode[]>>()

function isRootDirectoryPath(path: string): boolean {
  return path === '' || path === '.' || path === './'
}

function getRootDirectoryCacheKey(directory?: string, serverId?: string): string {
  // 与传输格式无关的目录键：pathMode 在 auto 检测期间可能切换，
  // 直接拼 formatPathForApi 会让同一目录算出两个 key，缓存与在途合并同时失效。
  return `${serverId ?? serverStore.getActiveServerId()}::${directoryCacheKey(directory)}`
}

async function fetchDirectory(path: string, directory?: string, serverId?: string): Promise<FileNode[]> {
  const sid = serverId ?? serverStore.getActiveServerId()
  if (serverStore.getApiVersion(sid) === 'v2') {
    return nativeListDirectory(sid, { directory, path })
  }
  const sdk = getSDKClient(serverId)
  const isAbsolute = /^[a-zA-Z]:/.test(path) || path.startsWith('/')

  if (isAbsolute && !directory) {
    return unwrap(await sdk.file.list({ directory: formatPathForApi(path, serverId), path: '' }))
  }

  return unwrap(await sdk.file.list({ path, directory: formatPathForApi(directory, serverId) }))
}

/**
 * 目录存在性探测结果。
 *
 * - exists：确认目录存在
 * - missing：确认目录不存在（服务端明确报 404 / 空目录语义）
 * - unknown：请求本身失败（网络、鉴权、路径非法等），无法据此判断
 *
 * 只有「确认不存在」才允许调用方隐藏项目：把 `unknown` 当成不存在会让
 * 一次网络抖动或一个非法路径把整个项目从侧栏抹掉。
 */
export type DirectoryExistence = 'exists' | 'missing' | 'unknown'

/** 从 SDK / fetch 错误里尽量读出 HTTP 状态码 */
function readErrorStatus(error: unknown): number | null {
  const candidates: unknown[] = [
    (error as { status?: unknown })?.status,
    (error as { statusCode?: unknown })?.statusCode,
    (error as { response?: { status?: unknown } })?.response?.status,
    (error as { cause?: { status?: unknown } })?.cause?.status,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'number') return candidate
  }
  return null
}

export async function probeDirectory(path: string, serverId?: string): Promise<DirectoryExistence> {
  if (!path) return 'missing'
  try {
    // 把待测目录当作 location、列其根（path='.'）。
    await listDirectory('.', path, serverId)
    return 'exists'
  } catch (error) {
    const status = readErrorStatus(error)
    // 404/410 明确表示目录不存在；其余（500、网络、非法路径）都无法断定。
    if (status === 404 || status === 410) return 'missing'
    return 'unknown'
  }
}

/** 目录存在性（兼容旧调用）：只有确认不存在时返回 false，探测失败按存在处理。 */
export async function directoryExists(path: string, serverId?: string): Promise<boolean> {
  return (await probeDirectory(path, serverId)) !== 'missing'
}

/**
 * 搜索文件或目录
 */
export async function searchFiles(
  query: string,
  options: {
    directory?: string
    type?: 'file' | 'directory'
    limit?: number
    serverId?: string
  } = {},
): Promise<string[]> {
  const sid = options.serverId ?? serverStore.getActiveServerId()
  if (serverStore.getApiVersion(sid) === 'v2') {
    return nativeFindFiles(sid, { directory: options.directory, query, type: options.type, limit: options.limit })
  }
  const sdk = getSDKClient(options.serverId)
  return unwrap(
    await sdk.find.files({
      query,
      directory: formatPathForApi(options.directory, options.serverId),
      type: options.type,
      limit: options.limit,
    }),
  ) as string[]
}

/**
 * 列出目录内容
 */
export async function listDirectory(path: string, directory?: string, serverId?: string): Promise<FileNode[]> {
  if (!isRootDirectoryPath(path)) {
    return fetchDirectory(path, directory, serverId)
  }

  const key = getRootDirectoryCacheKey(directory, serverId)
  const now = Date.now()
  const cached = rootDirectoryCache.get(key)
  if (cached && cached.expiresAt > now) {
    return cached.data
  }

  const inflight = rootDirectoryInflight.get(key)
  if (inflight) {
    return inflight
  }

  const request = fetchDirectory(path === '' ? '.' : path, directory, serverId)
    .then(data => {
      rootDirectoryCache.set(key, { data, expiresAt: Date.now() + ROOT_DIRECTORY_CACHE_TTL_MS })
      return data
    })
    .finally(() => {
      rootDirectoryInflight.delete(key)
    })

  rootDirectoryInflight.set(key, request)
  return request
}

export async function prefetchRootDirectory(directory?: string, serverId?: string): Promise<void> {
  await listDirectory('.', directory, serverId)
}

/**
 * 读取文件内容
 */
export async function getFileContent(path: string, directory?: string, serverId?: string): Promise<FileContent> {
  const sid = serverId ?? serverStore.getActiveServerId()
  if (serverStore.getApiVersion(sid) === 'v2') {
    return nativeReadFile(sid, { directory, path }) as unknown as FileContent
  }
  const sdk = getSDKClient(serverId)
  return unwrap(await sdk.file.read({ path, directory: formatPathForApi(directory, serverId) }))
}

/**
 * 获取文件 git 状态
 */
export async function getFileStatus(directory?: string, serverId?: string): Promise<FileStatusItem[]> {
  const sdk = getSDKClient(serverId)
  return unwrap(await sdk.file.status({ directory: formatPathForApi(directory, serverId) }))
}

/**
 * 搜索文件正文内容
 */
export async function searchText(pattern: string, directory?: string, serverId?: string): Promise<TextSearchMatch[]> {
  const sdk = getSDKClient(serverId)
  return unwrap(await sdk.find.text({ pattern, directory: formatPathForApi(directory, serverId) }))
}
