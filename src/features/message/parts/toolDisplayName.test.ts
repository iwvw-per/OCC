import { describe, expect, it } from 'vitest'
import { getToolDisplayName } from './toolDisplayName'
import type { ToolPart } from '../../../types/message'

/**
 * 工具名显示。
 *
 * 已用数据库实测确认：v2 的 `part.name` 就是**真实工具名**
 * （shell / edit / read / grep / execute / write / subagent / websearch），
 * 不存在「这里放的是泛型类型、具体名在 input 里」的情况。
 *
 * 因此只允许显式 displayName 覆盖 part.tool，其它 input 字段一律不参与 ——
 * 曾据此把 execute 显示成 input 里的代码片段，比不显示更糟。
 */

function toolPart(tool: string, input: Record<string, unknown>): ToolPart {
  return {
    id: 't1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    callID: 'c1',
    tool,
    state: { status: 'running', input, time: { start: 1 } },
  } as unknown as ToolPart
}

describe('getToolDisplayName', () => {
  it('does not override the real tool name with input fields', () => {
    // execute 的 input 只有 code；绝不能把 code 当成工具名
    expect(getToolDisplayName(toolPart('execute', { code: 'return tools.foo()' }))).toBeUndefined()
    expect(getToolDisplayName(toolPart('shell', { command: 'ls -la' }))).toBeUndefined()
  })

  it('honors an explicit displayName', () => {
    expect(getToolDisplayName(toolPart('execute', { displayName: 'find_api' }))).toBe('find_api')
  })
})
