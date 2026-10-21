// ============================================
// v2 原生 Config / Provider 访问层
//
// 直接用 @opencode/client（v2 原生）调用 config/provider/model。
// ============================================

import { getV2Client } from './sdkV2'
import { adaptDataList } from './v2/session'
import { adaptProviders } from './v2/entities'
import { rec } from './v2/adapt'
import type { ProvidersResponse } from '../types/api/model'

/**
 * 把 v2 `config.get` 的 `Config.Entry[]` 摊平成前端期望的单个 `Config` 对象。
 *
 * ⚠️ 这是此前一个真实缺陷：`config.get` 返回的是**数组**，元素形如
 *   `{ type: 'document', path: '…/opencode.json', info: {…} }`
 *   `{ type: 'directory', path: '…/opencode' }`
 * 而旧实现直接 `adaptEnvelope(res) as Config` —— `adaptEnvelope` 只在有 `data`
 * 字段时取值，数组没有 `data`，于是原样返回数组。结果 `config.shell`、
 * `config.model` 全是 `undefined`，设置页读到的「当前配置」永远是空对象，
 * 保存时 `createMergePatch(original, snapshot)` 两边都是坏数组 → 写入必然无效。
 *
 * 摊平规则与服务端一致：**从低优先级到高优先级依次深合并**，后者覆盖前者。
 * `type: 'directory'` 条目只是「这个目录下存在配置」的标记（没有 `info`），
 * 不参与合并，仅用于告知调用方配置来源目录。
 */
function flattenConfigEntries(raw: unknown): { config: Record<string, unknown>; sources: string[] } {
  const entries = Array.isArray(raw) ? raw : []
  const sources: string[] = []
  let merged: Record<string, unknown> = {}
  for (const entry of entries) {
    const e = rec(entry)
    const path = typeof e.path === 'string' ? e.path : undefined
    if (path) sources.push(path)
    if (e.type !== 'document') continue
    const info = rec(e.info)
    if (Object.keys(info).length === 0) continue
    merged = deepMerge(merged, info)
  }
  return { config: merged, sources }
}

/** 深合并：对象递归合并，数组与标量整体覆盖（与 JSON merge patch 语义一致）。 */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const prev = out[key]
    if (isPlainObject(prev) && isPlainObject(value)) {
      out[key] = deepMerge(prev, value)
    } else {
      out[key] = value
    }
  }
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 原生获取配置（v2 config.get 返回 Config.Entry[]，摊平为单个 Config 对象）。
 */
export async function nativeGetConfig(serverId: string | undefined, input: { directory?: string }): Promise<unknown> {
  const client = getV2Client(serverId)
  const res = await client.config.get({
    location: input.directory ? { directory: input.directory } : undefined,
  })
  return flattenConfigEntries(res).config
}

/**
 * 原生获取配置**及来源**（v2 config.get 原始 entries → { config, sources }）。
 *
 * 设置页需要展示「这份配置来自哪些文件」，且必须知道最高优先级的那个文档路径，
 * 才能在保存时写回正确的位置。
 */
export async function nativeGetConfigWithSources(
  serverId: string | undefined,
  input: { directory?: string },
): Promise<{ config: Record<string, unknown>; sources: string[] }> {
  const client = getV2Client(serverId)
  const res = await client.config.get({
    location: input.directory ? { directory: input.directory } : undefined,
  })
  return flattenConfigEntries(res)
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
