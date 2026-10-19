import type { ToolPart } from '../../../types/message'

/**
 * 工具显示名的兜底来源。
 *
 * v2 的 `part.name` 就是**真实工具名**（shell / edit / read / grep / execute /
 * write / subagent / websearch），已用本地数据库实测确认，不存在「这里放的是
 * 泛型类型、具体名在 input 里」的情况。
 *
 * 因此除显式 displayName 外不从 input 推断：曾据此把 execute 显示成 input 里的
 * 代码片段，比不显示更糟。
 */
export function getToolDisplayName(part: ToolPart): string | undefined {
  const input = part.state.input as Record<string, unknown> | undefined
  if (typeof input?.displayName === 'string' && input.displayName.trim()) return input.displayName.trim()
  return undefined
}
