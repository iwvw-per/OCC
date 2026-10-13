import type { PermissionRequest, Agent, Pty } from '../../types'
import { rec, str, num } from './adapt'

/** v2 PermissionRequest → v1 PermissionRequest（action/resources/save → permission/patterns/always） */
export function adaptPermission(raw: unknown): PermissionRequest {
  const p = rec(raw)
  return {
    id: String(p.id ?? ''),
    sessionID: String(p.sessionID ?? ''),
    permission: str(p.action) ?? str(p.permission) ?? '',
    patterns: Array.isArray(p.resources) ? (p.resources as string[]) : (Array.isArray(p.patterns) ? (p.patterns as string[]) : []),
    metadata: rec(p.metadata),
    always: Array.isArray(p.save) ? (p.save as string[]) : (Array.isArray(p.always) ? (p.always as string[]) : []),
    tool: p.source as PermissionRequest['tool'],
  } as PermissionRequest
}

/** v2 Agent → v1 Agent（id→name，permissions→permission） */
export function adaptAgent(raw: unknown): Agent {
  const a = rec(raw)
  return {
    name: String(a.id ?? a.name ?? ''),
    description: str(a.description),
    mode: (str(a.mode) ?? 'all') as Agent['mode'],
    native: a.native as boolean | undefined,
    hidden: a.hidden as boolean | undefined,
    permission: (a.permissions ?? a.permission ?? []) as Agent['permission'],
    model: a.model as Agent['model'],
    prompt: str(a.prompt),
    options: (a.options ?? {}) as Agent['options'],
  } as Agent
}

/** v2 Pty → v1 Pty（v2 无 size，补默认值） */
export function adaptPty(raw: unknown): Pty {
  const p = rec(raw)
  return {
    id: String(p.id ?? ''),
    title: str(p.title) ?? '',
    command: str(p.command) ?? '',
    args: Array.isArray(p.args) ? (p.args as string[]) : [],
    cwd: str(p.cwd) ?? '',
    status: (str(p.status) ?? 'running') as Pty['status'],
    pid: num(p.pid) ?? 0,
    size: { rows: 24, cols: 80 },
  } as Pty
}
