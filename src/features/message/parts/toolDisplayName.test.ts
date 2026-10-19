import { describe, expect, it } from 'vitest'
import { getToolDisplayName } from './ToolPartView'
import type { ToolPart } from '../../../types/message'

/**
 * v2 的 part.name 是工具类型（execute/bash…），具体工具名在 input 里。
 * 直接展示 name 会让同类工具全显示成「Execute」。这里锁定提取优先级。
 */

function toolPart(input: Record<string, unknown>): ToolPart {
  return {
    id: 't1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    callID: 'c1',
    tool: 'execute',
    state: { status: 'running', input, time: { start: 1 } },
  } as unknown as ToolPart
}

describe('getToolDisplayName', () => {
  it('prefers input.tool', () => {
    expect(getToolDisplayName(toolPart({ tool: 'web_search', command: 'x' }))).toBe('web_search')
  })

  it('falls back to input.name', () => {
    expect(getToolDisplayName(toolPart({ name: 'grep_files' }))).toBe('grep_files')
  })

  it('ignores blank candidates', () => {
    expect(getToolDisplayName(toolPart({ tool: '   ', name: 'read_file' }))).toBe('read_file')
  })

  it('returns undefined so the caller can fall back to the type name', () => {
    expect(getToolDisplayName(toolPart({}))).toBeUndefined()
  })
})
