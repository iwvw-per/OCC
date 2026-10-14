// ============================================
// v2 原生 Config / Provider 访问层
//
// 直接用 @opencode/client（v2 原生）调用 config/provider/model，
// 不经过 clientFacade 的 v1→v2 facade 层。
// ============================================

import { getV2Client } from './sdkV2'
import { adaptDataList, adaptEnvelope } from './v2/session'
import { adaptProviders } from './v2/entities'
import type { ProvidersResponse } from '../types/api/model'

/**
 * 原生获取配置（v2 config.get 返回 Config.Entry[]，适配为 v1 Config 形状）。
 */
export async function nativeGetConfig(serverId: string | undefined, input: { directory?: string }): Promise<unknown> {
  const client = getV2Client(serverId)
  const res = await client.config.get({
    location: input.directory ? { directory: input.directory } : undefined,
  })
  return adaptEnvelope(res)
}

/**
 * 原生获取 provider + models 合并结果（v2 provider.list + model.list）。
 */
export async function nativeGetProviders(
  serverId: string | undefined,
  input: { directory?: string },
): Promise<ProvidersResponse> {
  const client = getV2Client(serverId)
  const loc = input.directory ? { directory: input.directory } : undefined
  const [providersRes, modelsRes] = await Promise.all([
    client.provider.list({ location: loc }),
    client.model.list({ location: loc }).catch(() => ({ data: [] })),
  ])
  return { providers: adaptProviders(adaptDataList(providersRes), adaptDataList(modelsRes)) } as ProvidersResponse
}
