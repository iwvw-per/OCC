import type { ApiSession } from '../../types'
import { rec, str, num } from './adapt'

/** v2 SessionInfo → v1 Session（补 directory/version 占位，避免 UI 读 undefined） */
export function adaptSession(raw: unknown): ApiSession {
  const s = rec(raw)
  const location = rec(s.location)
  const time = rec(s.time)
  const meta = rec(s.metadata)
  const tokens = rec(s.tokens)
  const cache = rec(tokens.cache)
  return {
    id: String(s.id ?? ''),
    slug: String(s.slug ?? ''),
    projectID: String(s.projectID ?? ''),
    workspaceID: str(s.workspaceID),
    directory: String(location.directory ?? s.directory ?? ''),
    path: str(s.path),
    parentID: str(s.parentID),
    summary: s.summary as ApiSession['summary'],
    cost: num(s.cost),
    tokens: s.tokens
      ? {
          input: num(tokens.input) ?? 0,
          output: num(tokens.output) ?? 0,
          reasoning: num(tokens.reasoning) ?? 0,
          cache: { read: num(cache.read) ?? 0, write: num(cache.write) ?? 0 },
        }
      : undefined,
    share: s.share as ApiSession['share'],
    title: String(s.title ?? ''),
    agent: str(s.agent),
    model: s.model as ApiSession['model'],
    version: String(s.version ?? ''),
    metadata: s.metadata as ApiSession['metadata'],
    time: {
      created: num(time.created) ?? 0,
      updated: num(time.updated) ?? 0,
      compacting: num(time.compacting),
      // 兼容两种归档落点：标准 time.archived，或旧实现的 metadata.__archived
      archived: num(time.archived) ?? num(meta.__archived),
    },
    permission: s.permissions as ApiSession['permission'],
    revert: s.revert as ApiSession['revert'],
  } as ApiSession
}

/** v2 session.list / message.list 信封 → data 数组 */
export function adaptDataList(raw: unknown): unknown[] {
  const r = rec(raw)
  return Array.isArray(r.data) ? r.data : Array.isArray(raw) ? raw : []
}

/** v2 {location,data} 信封 → data 字段 */
export function adaptEnvelope(raw: unknown): unknown {
  const r = rec(raw)
  return 'data' in r ? r.data : raw
}
