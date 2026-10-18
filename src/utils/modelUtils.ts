/**
 * 模型工具函数
 * - 唯一标识管理
 * - 使用频率记录和排序
 */

import type { ModelInfo } from '../api'
import { z } from 'zod'
import { createStore } from '../storage/createStore'
import { serverStore } from '../store/serverStore'

// ============================================
// 模型唯一标识
// ============================================

/**
 * 生成模型的唯一标识符
 * 格式: providerId:modelId
 */
export function getModelKey(model: ModelInfo): string {
  return `${model.providerId}:${model.id}`
}

/**
 * 从唯一标识符解析 providerId 和 modelId
 */
export function parseModelKey(key: string): { providerId: string; modelId: string } | null {
  const idx = key.indexOf(':')
  if (idx === -1) return null
  return {
    providerId: key.slice(0, idx),
    modelId: key.slice(idx + 1),
  }
}

/**
 * 根据 key 找到对应的模型
 */
export function findModelByKey(models: ModelInfo[], key: string): ModelInfo | undefined {
  const parsed = parseModelKey(key)
  if (!parsed) return undefined
  return models.find(m => m.providerId === parsed.providerId && m.id === parsed.modelId)
}

// ============================================
// 使用频率存储
// ============================================

const STORAGE_KEY = 'model-usage-stats'
const VARIANT_STORAGE_KEY = 'model-variant-prefs'
const PINNED_STORAGE_KEY = 'model-pinned'
const SESSION_SELECTION_STORAGE_KEY = 'session-model-selection'

// ---- 持久化（统一走 createStore：单写入口 + schema 校验 + 切服 rebind） ----
const usageSchema: z.ZodType<ModelUsageStats> = z
  .record(z.string(), z.unknown())
  .transform(raw =>
    Object.fromEntries(
      Object.entries(raw).flatMap(([k, v]) => {
        const rec = v as { count?: unknown; lastUsed?: unknown } | null
        if (!rec || typeof rec.count !== 'number' || typeof rec.lastUsed !== 'number') return []
        return [[k, { count: rec.count, lastUsed: rec.lastUsed }]]
      }),
    ),
  )

const variantSchema: z.ZodType<ModelVariantPrefs> = z
  .record(z.string(), z.unknown())
  .transform(raw => Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string')))

const selectionSchema: z.ZodType<SessionModelSelections> = z
  .record(z.string(), z.unknown())
  .transform(raw =>
    Object.fromEntries(
      Object.entries(raw).flatMap(([sid, v]) => {
        const rec = v as { modelKey?: unknown; variant?: unknown } | null
        if (!rec || typeof rec.modelKey !== 'string') return []
        return [[sid, typeof rec.variant === 'string' ? { modelKey: rec.modelKey, variant: rec.variant } : { modelKey: rec.modelKey }]]
      }),
    ),
  )

const pinnedSchema: z.ZodType<string[]> = z.array(z.unknown()).transform(items =>
  items.filter((i): i is string => typeof i === 'string'),
)

const usageStore = createStore({
  key: STORAGE_KEY,
  scope: { kind: 'server', serverId: serverStore.getActiveServerId() },
  schema: usageSchema,
  defaultValue: {},
})
const variantStore = createStore({
  key: VARIANT_STORAGE_KEY,
  scope: { kind: 'server', serverId: serverStore.getActiveServerId() },
  schema: variantSchema,
  defaultValue: {},
})
const selectionStore = createStore({
  key: SESSION_SELECTION_STORAGE_KEY,
  scope: { kind: 'server', serverId: serverStore.getActiveServerId() },
  schema: selectionSchema,
  defaultValue: {},
})
const pinnedStore = createStore({
  key: PINNED_STORAGE_KEY,
  scope: { kind: 'server', serverId: serverStore.getActiveServerId() },
  schema: pinnedSchema,
  defaultValue: [],
})

// 惰性绑定：模块加载时 serverStore 可能尚未就绪（测试、SSR、启动早期），
// 首次访问时再对齐到当前活动服务器，避免在模块顶层产生副作用。
let boundServerId = ''
let watchingServerChange = false
function ensureServerBinding(): void {
  if (!watchingServerChange) {
    watchingServerChange = true
    serverStore.onServerChange(() => {
      // 切换服务器：先清空绑定，下次读取时重新对齐
      boundServerId = ''
      ensureServerBinding()
    })
  }
  const sid = serverStore.getActiveServerId()
  if (sid === boundServerId) return
  boundServerId = sid
  usageStore.rebind(sid)
  variantStore.rebind(sid)
  selectionStore.rebind(sid)
  pinnedStore.rebind(sid)
}

interface ModelUsageStats {
  [modelKey: string]: {
    count: number
    lastUsed: number
  }
}

interface ModelVariantPrefs {
  [modelKey: string]: string // modelKey -> variant
}

interface SessionModelSelections {
  [sessionId: string]: {
    modelKey: string
    variant?: string
  }
}

/**
 * 获取所有模型的使用统计
 */
export function getModelUsageStats() {
  ensureServerBinding()
  return usageStore.get()
}

/**
 * 记录模型使用
 */
export function recordModelUsage(model: ModelInfo): void {
  ensureServerBinding()
  const key = getModelKey(model)
  usageStore.commit(stats => {
    const prev = stats[key] ?? { count: 0, lastUsed: 0 }
    return { ...stats, [key]: { count: prev.count + 1, lastUsed: Date.now() } }
  })
}

// ============================================
// Variant 偏好存储
// ============================================

/**
 * 获取所有模型的 variant 偏好
 */
export function getModelVariantPrefs() {
  ensureServerBinding()
  return variantStore.get()
}

/**
 * 保存模型的 variant 偏好
 */
export function saveModelVariantPref(modelKey: string, variant: string | undefined): void {
  ensureServerBinding()
  variantStore.commit(prefs => {
    if (variant) return { ...prefs, [modelKey]: variant }
    if (!(modelKey in prefs)) return prefs
    const next = { ...prefs }
    delete next[modelKey]
    return next
  })
}

/**
 * 获取模型的 variant 偏好
 */
export function getModelVariantPref(modelKey: string): string | undefined {
  const prefs = getModelVariantPrefs()
  return prefs[modelKey]
}

// ============================================
// Session 模型选择存储
// ============================================

export function getSessionModelSelections(): SessionModelSelections {
  return selectionStore.get()
}

export function getSessionModelSelection(sessionId: string): { modelKey: string; variant?: string } | undefined {
  const selections = getSessionModelSelections()
  return selections[sessionId]
}

export function saveSessionModelSelection(sessionId: string, modelKey: string, variant: string | undefined): void {
  ensureServerBinding()
  selectionStore.commit(selections => ({
    ...selections,
    [sessionId]: variant ? { modelKey, variant } : { modelKey },
  }))
}

// ============================================
// 模型排序
// ============================================

/**
 * 根据使用频率排序模型
 * - 最近使用的优先
 * - 使用次数多的优先
 * - 未使用过的按原始顺序
 */
export function sortModelsByFrequency(models: ModelInfo[]): ModelInfo[] {
  const stats = getModelUsageStats()

  return [...models].sort((a, b) => {
    const keyA = getModelKey(a)
    const keyB = getModelKey(b)
    const statsA = stats[keyA]
    const statsB = stats[keyB]

    // 都没使用过，保持原始顺序
    if (!statsA && !statsB) return 0

    // 只有一个使用过，使用过的排前面
    if (!statsA) return 1
    if (!statsB) return -1

    // 都使用过，按使用次数排序，次数相同按最近使用时间
    if (statsA.count !== statsB.count) {
      return statsB.count - statsA.count
    }
    return statsB.lastUsed - statsA.lastUsed
  })
}

// ============================================
// 模型分组（用于 UI 展示）
// ============================================

export interface ModelGroup {
  providerId: string
  providerName: string
  models: ModelInfo[]
}

/**
 * 将模型按 provider 分组，常用的 provider 在前
 */
export function groupModelsByProvider(models: ModelInfo[]): ModelGroup[] {
  const stats = getModelUsageStats()

  // 按 providerName 分组 (合并同名 Provider)
  const groupMap = models.reduce(
    (acc, model) => {
      const key = model.providerName // 使用 Name 作为分组键
      if (!acc[key]) {
        acc[key] = {
          providerId: model.providerId, // 这里的 ID 仅作参考，可能不唯一
          providerName: model.providerName,
          models: [],
        }
      }
      acc[key].models.push(model)
      return acc
    },
    {} as Record<string, ModelGroup>,
  )

  // 按 provider 使用频率排序 (累加该 Name 下所有模型的使用次数)
  const groups = Object.values(groupMap).sort((a, b) => {
    // 计算 Group A 的总权重
    const weightA = a.models.reduce((sum, m) => sum + (stats[getModelKey(m)]?.count ?? 0), 0)
    // 计算 Group B 的总权重
    const weightB = b.models.reduce((sum, m) => sum + (stats[getModelKey(m)]?.count ?? 0), 0)

    return weightB - weightA
  })

  // 每个 provider 内部按使用频率排序
  for (const group of groups) {
    group.models = sortModelsByFrequency(group.models)
  }

  return groups
}

/**
 * 获取最近使用的模型列表（用于快速访问）
 */
export function getRecentModels(models: ModelInfo[], limit = 5): ModelInfo[] {
  const stats = getModelUsageStats()

  // 过滤出使用过的模型并按最近使用时间排序
  // 只要有记录且 count > 0 就视为使用过
  const usedModels = models
    .filter(m => {
      const s = stats[getModelKey(m)]
      return s && (s.count > 0 || s.lastUsed > 0)
    })
    .sort((a, b) => {
      const statsA = stats[getModelKey(a)]
      const statsB = stats[getModelKey(b)]
      // 优先按时间倒序
      return (statsB?.lastUsed ?? 0) - (statsA?.lastUsed ?? 0)
    })

  return usedModels.slice(0, limit)
}

// ============================================
// 模型置顶
// ============================================

/**
 * 获取所有置顶的模型 key 列表（有序）
 */
export function getPinnedModelKeys(): string[] {
  ensureServerBinding()
  return pinnedStore.get()
}

/**
 * 判断模型是否已置顶
 */
export function isModelPinned(model: ModelInfo): boolean {
  const key = getModelKey(model)
  return getPinnedModelKeys().includes(key)
}

/**
 * 切换模型置顶状态
 */
export function toggleModelPin(model: ModelInfo): boolean {
  ensureServerBinding()
  const key = getModelKey(model)
  const nowPinned = !getPinnedModelKeys().includes(key)
  pinnedStore.commit(pinned =>
    nowPinned ? [...pinned, key] : pinned.filter(k => k !== key),
  )
  return nowPinned
}

/**
 * 获取置顶模型列表（保持置顶顺序）
 */
export function getPinnedModels(models: ModelInfo[]): ModelInfo[] {
  const pinnedKeys = getPinnedModelKeys()
  if (pinnedKeys.length === 0) return []

  const keySet = new Set(pinnedKeys)
  const modelMap = new Map<string, ModelInfo>()
  for (const m of models) {
    const k = getModelKey(m)
    if (keySet.has(k)) modelMap.set(k, m)
  }

  // 保持置顶顺序
  return pinnedKeys.map(k => modelMap.get(k)).filter((m): m is ModelInfo => !!m)
}
