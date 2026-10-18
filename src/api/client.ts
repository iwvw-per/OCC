// ============================================
// API Client for OpenCode Backend
// 基于 @opencode-ai/sdk: /config, /project, /provider 相关接口
// ============================================

import { getSDKClient, unwrap } from './sdk'
import { nativeGetCurrentProject, nativeListProjects, nativeInitGit } from './v2NativeProject'
import { formatPathForApi, directoryCacheKey } from '../utils/directoryUtils'
import { serverStore } from '../store/serverStore'
import { ttlCacheGet, ttlCacheSet } from '../utils/ttlCache'
import { singleFlight } from '../utils/singleFlight'
import type { ModelInfo, ApiProject, ApiPath } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (isRecord(value)) return value
  throw new Error(message)
}

function requireArray<T = unknown>(value: unknown, message: string): T[] {
  if (Array.isArray(value)) return value as T[]
  throw new Error(message)
}

// Re-export all types
export * from './types'

// Re-export from Attachment feature
export { fromFilePart, fromAgentPart } from '../features/attachment'

// Re-export from sub-modules
export * from './session'
export * from './message'
export * from './permission'
export * from './file'
export * from './agent'
export * from './skill'
export * from './events'
export * from './config'
export * from './vcs'
export * from './mcp'
export * from './pty'
export * from './worktree'
export * from './command'
export * from './global'
export * from './tool'
export * from './lsp'

// ============================================
// Model API Functions
// 基于 SDK: config.providers()
// ============================================

export async function getActiveModels(directory?: string, serverId?: string): Promise<ModelInfo[]> {
  const sdk = getSDKClient(serverId)
  const data = requireRecord(
    unwrap(await sdk.config.providers({ directory: formatPathForApi(directory, serverId) })),
    'Invalid OpenCode providers response',
  )
  const providers = requireArray<Record<string, unknown>>(data.providers, 'Invalid OpenCode providers response')
  const models: ModelInfo[] = []

  for (const provider of providers) {
    const providerModels = isRecord(provider.models) ? provider.models : {}
    for (const [, rawModel] of Object.entries(providerModels)) {
      if (!isRecord(rawModel)) continue
      const model = rawModel
      if (model.status === 'active') {
        const limit = isRecord(model.limit) ? model.limit : {}
        const capabilities = isRecord(model.capabilities) ? model.capabilities : {}
        const inputCapabilities = isRecord(capabilities.input) ? capabilities.input : {}
        const variants = isRecord(model.variants) ? Object.keys(model.variants) : []
        const modelId = typeof model.id === 'string' ? model.id : ''
        if (!modelId) continue

        models.push({
          id: modelId,
          name: typeof model.name === 'string' ? model.name : modelId,
          providerId: typeof provider.id === 'string' ? provider.id : '',
          providerName:
            typeof provider.name === 'string' ? provider.name : typeof provider.id === 'string' ? provider.id : '',
          family: typeof model.family === 'string' ? model.family : '',
          contextLimit: typeof limit.context === 'number' ? limit.context : 0,
          outputLimit: typeof limit.output === 'number' ? limit.output : 0,
          supportsReasoning: capabilities.reasoning === true,
          supportsImages: inputCapabilities.image === true,
          supportsPdf: inputCapabilities.pdf === true,
          supportsAudio: inputCapabilities.audio === true,
          supportsVideo: inputCapabilities.video === true,
          supportsToolcall: capabilities.toolcall === true,
          variants,
        })
      }
    }
  }

  return models
}

// ============================================
// Project API Functions
// 基于 SDK: project.*
// ============================================

/**
 * 获取当前项目
 *
 * 首屏多个组件各自调用；合并同 key 在途请求。
 */
export async function getCurrentProject(directory?: string, serverId?: string): Promise<ApiProject> {
  const sid = serverId ?? serverStore.getActiveServerId()
  return singleFlight(`project-current:${sid}:${directoryCacheKey(directory)}`, async () => {
    return nativeGetCurrentProject(sid, { directory }) as unknown as ApiProject
  })
}

/**
 * 获取项目列表
 *
 * 首屏 useProject 与侧栏项目分组会各拉一次；合并同 key 在途请求。
 */
export async function getProjects(directory?: string, serverId?: string): Promise<ApiProject[]> {
  const sid = serverId ?? serverStore.getActiveServerId()
  return singleFlight(`project-list:${sid}:${directoryCacheKey(directory)}`, async () => {
    return nativeListProjects(sid, { directory }) as unknown as ApiProject[]
  })
}

/**
 * 初始化 Git 仓库
 */
export async function initGitProject(_directory?: string, serverId?: string): Promise<ApiProject> {
  // v2 的 initGit 以服务器当前 project 为作用域，不接受 directory 参数；
  // 保留形参是为了不打断调用方签名。
  const sid = serverId ?? serverStore.getActiveServerId()
  return nativeInitGit(sid) as unknown as ApiProject
}

// ============================================
// Path API Functions
// ============================================

/** /path 在服务器运行期基本不变，用短 TTL 合并同一服务器的重复调用 */
const PATH_CACHE_TTL_MS = 60_000
const PATH_CACHE_PREFIX = 'server-path:'

export async function getPath(serverId?: string): Promise<ApiPath> {
  const cacheServerId = serverId ?? serverStore.getActiveServerId()
  const cacheKey = `${PATH_CACHE_PREFIX}${cacheServerId}`
  const cached = ttlCacheGet<ApiPath>(cacheKey, PATH_CACHE_TTL_MS)
  if (cached) return cached

  const sdk = getSDKClient(serverId)
  const info = requireRecord(unwrap(await sdk.path.get()), 'Invalid OpenCode path response') as unknown as ApiPath
  ttlCacheSet(cacheKey, info, PATH_CACHE_TTL_MS)
  return info
}
