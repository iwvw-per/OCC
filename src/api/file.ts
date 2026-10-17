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
 * 探测某绝对目录在服务器上是否存在（只列一层，失败即视为不存在）。
 *
 * 用于识别「项目根目录已迁移/删除」：opencode 按 git 仓库身份记项目，
 * 仓库整体搬家后 project.current 仍返回旧 worktree，靠它判断会一直把
 * 新目录挂到旧项目下。该请求失败（目录不存在时服务端返回 500）即判定不存在。
 */
export async function directoryExists(path: string, serverId?: string): Promise<boolean> {
  if (!path) return false
  try {
    // 把待测目录当作 location、列其根（path='.'）：目录不存在时服务端返回 500。
    await listDirectory('.', path, serverId)
    return true
  } catch {
    return false
  }
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
