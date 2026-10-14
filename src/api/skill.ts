// ============================================
// Skill API
// ============================================

import { getSDKClient, unwrap } from './sdk'
import { nativeListSkills } from './v2NativeCommand'
import { formatPathForApi, directoryCacheKey } from '../utils/directoryUtils'
import { microCache } from '../utils/microCache'
import { serverStore } from '../store/serverStore'
import type { SkillList } from '../types/api/skill'

/**
 * 获取所有可用 Skills
 *
 * 经隧道时这个响应可达 190KB 且固定约 1.1s 往返；实测打开一个会话会被拉 2 次
 * （技能面板 + 工作状态面板）。技能清单在一次会话内基本不变，用较长 TTL 缓存。
 */
export async function getSkills(directory?: string, serverId?: string): Promise<SkillList> {
  const sid = serverId ?? serverStore.getActiveServerId()
  return microCache(
    `skill:${sid}:${directoryCacheKey(directory)}`,
    async () => {
      if (serverStore.getApiVersion(sid) === 'v2') {
        return nativeListSkills(sid, { directory })
      }
      const sdk = getSDKClient(serverId)
      return unwrap(await sdk.app.skills({ directory: formatPathForApi(directory, serverId) }))
    },
    { ttlMs: 60_000 },
  )
}
