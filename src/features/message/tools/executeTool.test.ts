import { describe, expect, it } from 'vitest'
import { extractToolCallsFromCode, getToolConfig, getToolIcon } from './registry'

/**
 * Code Mode 的 execute 是独立工具（不是 shell 的别名）：input.code 里通过
 * tools.xxx() 调用其它工具。数据库实测 220 次 shell / 17 次 execute，二者并存。
 *
 * 之前 registry 没有 execute 规则，它会掉进「通用扳手」兜底，和任何工具都长一样。
 */

describe('execute tool registration', () => {
  it('has a dedicated config instead of falling back to the generic wrench', () => {
    expect(getToolConfig('execute')).toBeDefined()
    // 不能误匹配成 bash（execute 与 shell 是两个不同工具）
    expect(getToolConfig('execute')).not.toBe(getToolConfig('shell'))
    expect(getToolIcon('execute')).toBeTruthy()
  })

  it('still matches shell as the shell tool', () => {
    expect(getToolConfig('shell')).toBeDefined()
  })
})

describe('extractToolCallsFromCode', () => {
  it('collects tools.xxx() calls in order, de-duplicated', () => {
    const code = `
      const a = await tools.get_system_status()
      const b = await tools.find_api({ intent: 'x' })
      const c = await tools.get_system_status()
      return [a, b, c]
    `
    expect(extractToolCallsFromCode(code)).toEqual(['get_system_status', 'find_api'])
  })

  it('collects namespaced calls tools["ns"].method()', () => {
    const code = `await tools["api-monitor"].list_hosts(); await tools.opencode.list_mcp_resources();`
    expect(extractToolCallsFromCode(code)).toEqual(['list_hosts', 'list_mcp_resources'])
  })

  it('returns an empty list when the code only calls non-tools helpers', () => {
    expect(extractToolCallsFromCode('const x = await search({ query: "a" })')).toEqual([])
  })
})
