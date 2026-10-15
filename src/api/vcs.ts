// ============================================
// VCS API - 版本控制信息
// ============================================

import { getSDKClient, unwrap } from './sdk'
import { nativeGetVcsInfo, nativeGetVcsDiff } from './v2NativeAgent'
import type { FileDiff } from './types'
import type { VcsDiffMode, VcsInfo } from '../types/api/vcs'
import { formatPathForApi, directoryCacheKey } from '../utils/directoryUtils'
import { microCache } from '../utils/microCache'
import { serverStore } from '../store/serverStore'
import { normalizeFileDiffs } from '../types/api/file'

/**
 * 获取 VCS 信息
 *
 * 实测打开一个会话会拉 2 次（文件面板 + 变更面板）。经隧道时每次约 1.1s 固定
 * 往返，且仓库分支信息在一次交互内不会变，用短 TTL 收敛。
 */
export async function getVcsInfo(directory?: string, serverId?: string): Promise<VcsInfo | null> {
  const sid = serverId ?? serverStore.getActiveServerId()
  return microCache(
    `vcs:info:${sid}:${directoryCacheKey(directory)}`,
    async () => {
      try {
        if (serverStore.getApiVersion(sid) === 'v2') {
          return nativeGetVcsInfo(sid, { directory }) as unknown as VcsInfo
        }
        const sdk = getSDKClient(serverId)
        return unwrap(await sdk.vcs.get({ directory: formatPathForApi(directory, serverId) }))
      } catch {
        // VCS 不可用时返回 null
        return null
      }
    },
    { ttlMs: 5000 },
  )
}

/**
 * 获取 Git 或分支维度的 diff
 */
export async function getVcsDiff(mode: VcsDiffMode, directory?: string, serverId?: string): Promise<FileDiff[]> {
  const sid = serverId ?? serverStore.getActiveServerId()
  return microCache(
    `vcs:diff:${mode}:${sid}:${directoryCacheKey(directory)}`,
    async () => {
      if (serverStore.getApiVersion(sid) === 'v2') {
        const raw = (await nativeGetVcsDiff(sid, { mode: String(mode), directory })) as Array<{
          file?: string
          patch?: string
          additions?: number
          deletions?: number
          status?: 'added' | 'deleted' | 'modified'
        }>
        return normalizeFileDiffs(
          raw.map(diff => ({
            file: diff.file,
            patch: diff.patch,
            additions: diff.additions ?? 0,
            deletions: diff.deletions ?? 0,
            status: diff.status,
          })),
        )
      }
      const sdk = getSDKClient(serverId)
      return normalizeFileDiffs(unwrap(await sdk.vcs.diff({ mode, directory: formatPathForApi(directory, serverId) })))
    },
    // diff 比 info 更容易变（用户可能正在编辑），TTL 更短
    { ttlMs: 1500 },
  )
}
