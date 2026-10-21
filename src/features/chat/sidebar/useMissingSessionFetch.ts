// ============================================
// useMissingSessionFetch — 补全「列表里还没有」的会话
//
// 忙碌会话、通知、置顶、选中会话可能不在当前 /session 列表里（属于其它项目
// 或其它手机会话）。这里按需 getSession 补进本地缓存；失败只记一次，避免
// SSE/busy 抖动时把所有请求打成 /session 风暴。
// ============================================

import { useEffect, useMemo, useRef, useState } from 'react'
import { getSession, type ApiSession } from '../../../api'
import { serverStore } from '../../../store/serverStore'
import { pinnedSessionsStore } from '../../../store/pinnedSessionsStore'

export interface MissingSessionCandidate {
  sessionId: string
  directory?: string
  pinned?: boolean
}

export interface UseMissingSessionFetchOptions {
  sessions: ApiSession[]
  busy: ReadonlyArray<{ sessionId: string; directory?: string; title?: string }>
  notifications: ReadonlyArray<{ sessionId: string; directory?: string; title?: string }>
  pinned: ReadonlyArray<{ sessionId: string; directory?: string; title?: string }>
  selectedSessionId: string | null
  currentDirectory?: string
}

export interface UseMissingSessionFetchResult {
  /** sessionId → ApiSession（sessions 列表 + 补全结果） */
  sessionLookup: Map<string, ApiSession>
}

/** 用内容 key 稳定（避免数组引用抖动触发重拉）。 */
function buildMissingKey(candidates: Map<string, MissingSessionCandidate>): string {
  return Array.from(candidates.values())
    .map(e => `${e.sessionId}\0${e.directory ?? ''}\0${e.pinned ? '1' : '0'}`)
    .sort()
    .join('|')
}

export function useMissingSessionFetch({
  sessions,
  busy,
  notifications,
  pinned,
  selectedSessionId,
  currentDirectory,
}: UseMissingSessionFetchOptions): UseMissingSessionFetchResult {
  const [fetchedSessions, setFetchedSessions] = useState<Record<string, ApiSession>>({})
  const inflightRef = useRef(new Set<string>())
  const failedRef = useRef(new Set<string>())

  const sessionLookup = useMemo(() => {
    const map = new Map<string, ApiSession>()
    for (const session of sessions) map.set(session.id, session)
    for (const [id, session] of Object.entries(fetchedSessions)) {
      if (!map.has(id)) map.set(id, session)
    }
    return map
  }, [sessions, fetchedSessions])

  const missingKey = useMemo(() => {
    const byId = new Map<string, MissingSessionCandidate>()
    const add = (sessionId: string, directory?: string, isPinned?: boolean) => {
      if (sessionLookup.has(sessionId)) return
      const existing = byId.get(sessionId)
      if (existing) {
        byId.set(sessionId, {
          sessionId,
          directory: existing.directory || directory,
          pinned: existing.pinned || isPinned,
        })
        return
      }
      byId.set(sessionId, { sessionId, directory, pinned: isPinned })
    }

    for (const entry of busy) add(entry.sessionId, entry.directory)
    for (const entry of notifications) add(entry.sessionId, entry.directory)
    for (const entry of pinned) add(entry.sessionId, entry.directory, true)
    if (selectedSessionId) add(selectedSessionId, currentDirectory || undefined)

    return buildMissingKey(byId)
  }, [busy, notifications, pinned, sessionLookup, selectedSessionId, currentDirectory])

  // 切服务器时清空跨目录缓存，避免串服
  useEffect(() => {
    return serverStore.onServerChange(() => {
      setFetchedSessions({})
      inflightRef.current.clear()
      failedRef.current.clear()
    })
  }, [])

  useEffect(() => {
    const neededIds = new Set<string>()
    const missing: MissingSessionCandidate[] = []

    if (missingKey) {
      for (const token of missingKey.split('|')) {
        const [sessionId, directory, isPinned] = token.split('\0')
        if (!sessionId) continue
        neededIds.add(sessionId)
        if (sessionLookup.has(sessionId)) continue
        if (inflightRef.current.has(sessionId)) continue
        if (failedRef.current.has(sessionId)) continue
        missing.push({ sessionId, directory: directory || undefined, pinned: isPinned === '1' })
      }
    }

    // 不再需要的失败记录清掉，会话再次出现时允许重试
    for (const sessionId of [...failedRef.current]) {
      if (!neededIds.has(sessionId)) failedRef.current.delete(sessionId)
    }

    if (missing.length === 0) return

    for (const entry of missing) inflightRef.current.add(entry.sessionId)

    void Promise.allSettled(
      missing.map(async entry => {
        try {
          const session = await getSession(entry.sessionId, entry.directory)
          inflightRef.current.delete(entry.sessionId)
          setFetchedSessions(prev => (prev[session.id] ? prev : { ...prev, [session.id]: session }))
          if (entry.pinned) {
            pinnedSessionsStore.update(session.id, {
              directory: session.directory || entry.directory,
              title: session.title || `${session.id.slice(0, 12)}...`,
            })
          }
        } catch {
          inflightRef.current.delete(entry.sessionId)
          failedRef.current.add(entry.sessionId)
        }
      }),
    )
  }, [missingKey, sessionLookup])

  return { sessionLookup }
}
