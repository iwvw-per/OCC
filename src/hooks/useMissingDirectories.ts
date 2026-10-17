// ============================================
// useExistingDirectories — 已保存项目目录的存在性
// ============================================
//
// 项目目录被迁移/删除后，savedDirectories 里的旧路径仍然保留（这是用户
// 主动保存的列表，不该在磁盘变动时被悄悄删掉）。但侧栏若继续展示一个
// 已经不存在的目录，用户会困惑「迁移后旧项目怎么还在」。
//
// 这里按目录探测存在性，侧栏据此隐藏失效目录（只隐藏，不动存储）：
// 目录重新出现时自动恢复显示，误判也不会造成数据丢失。
// 探测失败（网络抖动、服务器不支持）一律视为存在，避免误隐藏。

import { useEffect, useMemo, useState } from 'react'
import { directoryExists } from '../api'
import { normalizeToForwardSlash } from '../utils'

const CACHE_TTL_MS = 60_000

/** 目录 → { exists, checkedAt } */
const existenceCache = new Map<string, { exists: boolean; checkedAt: number }>()

function cacheKey(serverId: string, directory: string): string {
  return `${serverId}::${normalizeToForwardSlash(directory).toLowerCase()}`
}

function readCached(serverId: string, directory: string): boolean | undefined {
  const entry = existenceCache.get(cacheKey(serverId, directory))
  if (!entry) return undefined
  if (Date.now() - entry.checkedAt > CACHE_TTL_MS) return undefined
  return entry.exists
}

/**
 * 返回「确认不存在」的目录集合（规范化后的路径）。
 *
 * 只把明确探测到不存在的目录放进集合：未探测、探测中、探测失败都不在集合里，
 * 调用方据此过滤侧栏项目行即可。
 */
export function useMissingDirectories(directories: string[], serverId?: string): Set<string> {
  const [missing, setMissing] = useState<Set<string>>(() => new Set())

  const normalized = useMemo(() => {
    const set = new Set<string>()
    for (const directory of directories) {
      const value = normalizeToForwardSlash(directory)
      if (value) set.add(value)
    }
    return Array.from(set).sort()
  }, [directories])
  const key = normalized.join('\u0001')

  useEffect(() => {
    if (!serverId || normalized.length === 0) {
      setMissing(prev => (prev.size === 0 ? prev : new Set()))
      return
    }

    let cancelled = false
    const targets = normalized.filter(directory => readCached(serverId, directory) === undefined)

    // 全部命中缓存：直接用缓存结论，不再发请求。
    const applyFromCache = () => {
      const next = new Set<string>()
      for (const directory of normalized) {
        if (readCached(serverId, directory) === false) next.add(directory)
      }
      return next
    }

    if (targets.length === 0) {
      const next = applyFromCache()
      setMissing(prev => (sameSet(prev, next) ? prev : next))
      return
    }

    void Promise.all(
      targets.map(async directory => {
        const exists = await directoryExists(directory, serverId)
        existenceCache.set(cacheKey(serverId, directory), { exists, checkedAt: Date.now() })
      }),
    ).then(() => {
      if (cancelled) return
      const next = applyFromCache()
      setMissing(prev => (sameSet(prev, next) ? prev : next))
    })

    return () => {
      cancelled = true
    }
    // key 覆盖 normalized 的内容变化；serverId 变化需重探。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, serverId])

  return missing
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) {
    if (!b.has(value)) return false
  }
  return true
}

/** 测试用：清空存在性缓存。 */
export function clearDirectoryExistenceCache(): void {
  existenceCache.clear()
}
