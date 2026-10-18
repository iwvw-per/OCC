// ============================================
// Agent API Functions
// 基于 @opencode-ai/sdk: /agent 相关接口
// ============================================

import { nativeListAgents } from './v2NativeAgent'
import { directoryCacheKey } from '../utils/directoryUtils'
import { microCache } from '../utils/microCache'
import { serverStore } from '../store/serverStore'
import type { ApiAgent } from './types'

/**
 * 获取 agent 列表
 *
 * 首屏 useChatSession 与输入框能力探测会各取一次；key 用与传输格式无关的
 * 目录键，避免 pathMode 切换导致重复请求。
 *
 * 用 microCache（在途合并 + 短 TTL）而非 singleFlight：这两处调用往往先后发生
 * 而非同帧并发，singleFlight 合并不到第二批，会多走一次约 1.1s 的隧道往返。
 * agent 清单在一次交互内不变，TTL 内复用是安全的。
 */
export async function getAgents(directory?: string, serverId?: string): Promise<ApiAgent[]> {
  const sid = serverId ?? serverStore.getActiveServerId()
  return microCache(
    `agents:${sid}:${directoryCacheKey(directory)}`,
    async () => {
      return nativeListAgents(sid, { directory })
    },
    { ttlMs: 30_000 },
  )
}

/**
 * 获取可选择的 agent 列表（过滤掉 hidden 的）
 */
export async function getSelectableAgents(directory?: string, serverId?: string): Promise<ApiAgent[]> {
  const agents = await getAgents(directory, serverId)
  return agents.filter(agent => !agent.hidden)
}
