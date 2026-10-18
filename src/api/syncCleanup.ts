// ============================================
// 同步白名单变更后的一次性清理
// ============================================
//
// 背景：同步白名单已收窄（个性化设置不再跨端同步），但服务端仍残留这些键的
// 历史数据。它们不再被读写，留着只是占空间；这里主动删除。
//
// 三个必须遵守的约束：
//
//   1. **只删服务端，不删本地**。`theme-custom-css`、`font-scale` 等键在本机
//      仍然生效（只是不再同步），删本地会让用户设置直接丢失。
//
//   2. **必须在新版首次同步成功之后执行**。否则本机仍持有这些键，而旧版
//      客户端也会把它们当作「本地新增」推回去 —— 清理等于白做。顺序是先让
//      本机停止上报（白名单已收窄），再删远端。
//
//   3. **幂等**。清理完成后写本地标记，三端各自只执行一次，避免每次启动都
//      打一次 DELETE。
//
// 残留风险：尚未升级的旧版客户端仍会把废弃键写回服务端。这不影响新版行为
// （新版不再读取它们），因此不做墓碑 —— 等旧版设备升级后自然消失。

import { accountRequest, readAccount, type AiAgentAccount } from '../api/aiagent'
import { DEPRECATED_SYNCABLE_KEYS } from '../api/preferencesSync'

const CLEANUP_DONE_KEY = 'opencode-sync-cleanup-deprecated-v1'

/** 单次 DELETE 的键数量上限：与服务端 sanitizePreferenceKeys 的量级保持一致 */
const DELETE_BATCH_SIZE = 32

function alreadyCleaned(): boolean {
  try {
    return localStorage.getItem(CLEANUP_DONE_KEY) === '1'
  } catch {
    return false
  }
}

function markCleaned(): void {
  try {
    localStorage.setItem(CLEANUP_DONE_KEY, '1')
  } catch {
    /* 存储不可用时下次重试，不影响主流程 */
  }
}

/**
 * 删除服务端已下线的同步键。
 *
 * 调用时机：同步引擎完成一次成功同步之后。失败不抛错 —— 清理是可选的
 * 收尾动作，不能因此让同步状态变成 error。
 */
export async function cleanupDeprecatedSyncKeys(account?: AiAgentAccount | null): Promise<number> {
  const current = account ?? readAccount()
  if (!current) return 0
  if (alreadyCleaned()) return 0

  const keys = DEPRECATED_SYNCABLE_KEYS.filter(Boolean)
  if (keys.length === 0) {
    markCleaned()
    return 0
  }

  let removed = 0
  for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
    const batch = keys.slice(i, i + DELETE_BATCH_SIZE)
    const result = await accountRequest<{ removed?: string[] }>(current, '/api/aiagent/preferences', {
      method: 'DELETE',
      body: JSON.stringify({ keys: batch }),
    })
    if (Array.isArray(result?.removed)) removed += result.removed.length
  }

  markCleaned()
  return removed
}

/** 仅测试用：重置清理标记 */
export function resetDeprecatedCleanupForTests(): void {
  try {
    localStorage.removeItem(CLEANUP_DONE_KEY)
  } catch {
    /* ignore */
  }
}
