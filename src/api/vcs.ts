// ============================================
// VCS API - 版本控制信息
// ============================================

import { nativeGetVcsInfo, nativeGetVcsDiff } from './v2NativeAgent'
import type { FileDiff } from './types'
import type { VcsDiffMode, VcsInfo } from '../types/domain/vcs'
import { directoryCacheKey } from '../utils/directoryUtils'
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
        return nativeGetVcsInfo(sid, { directory }) as unknown as VcsInfo
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
    },
    // diff 比 info 更容易变（用户可能正在编辑），TTL 更短
    { ttlMs: 1500 },
  )
}
