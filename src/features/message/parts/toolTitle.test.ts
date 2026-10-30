import { describe, expect, it } from 'vitest'
import { getToolTitle, relativeToDirectory } from './toolTitle'
import type { ToolPart } from '../../../types/message'

/**
 * 工具行参数胶囊文案。
 *
 * 回归背景：v2 的 tool part 不带 `state.title`，也不带 `input.description`
 * （实测 session_message 里 read/edit/write/grep/shell 的 title 全为空），
 * 于是工具行只剩动作名，看不出作用在哪个文件上。这里按 input 的关键字段兜底。
 */

function toolPart(tool: string, input: Record<string, unknown>, title?: string): ToolPart {
  return {
    id: 't1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    callID: 'c1',
    tool,
    state: { status: 'completed', input, title, time: { start: 1, end: 2 } },
  } as unknown as ToolPart
}

describe('getToolTitle', () => {
  it('prefers the server-provided title', () => {
    const part = toolPart('read', { path: 'src/a.ts' }, 'src/b.ts')
    expect(getToolTitle(part, '/repo').text).toBe('src/b.ts')
  })

  it('falls back to input.path for v2 file tools', () => {
    // v2 的 read/edit/write 把目标路径放在 input.path
    expect(getToolTitle(toolPart('read', { path: '/repo/src/a.ts' }), '/repo')).toEqual({
      text: 'src/a.ts',
      full: '/repo/src/a.ts',
    })
    expect(getToolTitle(toolPart('edit', { path: '/repo/src/a.ts', oldString: 'a', newString: 'b' }), '/repo').text).toBe(
      'src/a.ts',
    )
    expect(getToolTitle(toolPart('write', { path: '/repo/src/a.ts', content: 'x' }), '/repo').text).toBe('src/a.ts')
  })

  it('still supports the v1 filePath field', () => {
    expect(getToolTitle(toolPart('read', { filePath: '/repo/src/a.ts' }), '/repo').text).toBe('src/a.ts')
  })

  it('shows the search term rather than the search root for grep/glob', () => {
    // v1 的 title 语义就是搜索词，根目录对「在找什么」没有帮助
    expect(getToolTitle(toolPart('grep', { pattern: 'ToolParamChip', path: '/repo/src' }), '/repo').text).toBe(
      'ToolParamChip',
    )
    expect(getToolTitle(toolPart('glob', { pattern: 'src/**/*.ts', path: '/repo' }), '/repo').text).toBe('src/**/*.ts')
  })

  it('shows the url for webfetch and the command for shell', () => {
    expect(getToolTitle(toolPart('webfetch', { url: 'https://opencode.ai/v2/docs' }), '/repo').text).toBe(
      'https://opencode.ai/v2/docs',
    )
    expect(getToolTitle(toolPart('shell', { command: 'npm run validate' }), '/repo').text).toBe('npm run validate')
  })

  it('honors an explicit description over other input fields', () => {
    expect(getToolTitle(toolPart('shell', { command: 'ls', description: '列出目录' }), '/repo').text).toBe('列出目录')
  })

  it('returns an empty title when no meaningful parameter exists', () => {
    // 没有可展示参数的工具（如 question / todowrite）不该硬凑一个胶囊
    expect(getToolTitle(toolPart('question', { questions: [] }), '/repo').text).toBe('')
    expect(getToolTitle(toolPart('todowrite', { todos: [] }), '/repo').text).toBe('')
  })

  it('keeps the path as-is when it is outside the session directory', () => {
    expect(getToolTitle(toolPart('read', { path: '/other/place/a.ts' }), '/repo')).toEqual({
      text: '/other/place/a.ts',
    })
  })
})

describe('relativeToDirectory', () => {
  it('strips a matching unix prefix', () => {
    expect(relativeToDirectory('/opt/code/OCC/src/a.ts', '/opt/code/OCC')).toBe('src/a.ts')
  })

  it('tolerates a trailing separator in the directory', () => {
    expect(relativeToDirectory('/opt/code/OCC/src/a.ts', '/opt/code/OCC/')).toBe('src/a.ts')
  })

  it('does not treat a sibling directory sharing the prefix as a child', () => {
    // /opt/code/OCC2 不是 /opt/code/OCC 的子目录
    expect(relativeToDirectory('/opt/code/OCC2/a.ts', '/opt/code/OCC')).toBe('/opt/code/OCC2/a.ts')
  })

  it('keeps the backslash style for windows paths', () => {
    expect(relativeToDirectory('E:\\workspace\\src\\a.ts', 'E:\\workspace')).toBe('src\\a.ts')
  })

  it('compares windows paths case-insensitively', () => {
    expect(relativeToDirectory('e:\\WORKSPACE\\a.ts', 'E:\\workspace')).toBe('a.ts')
  })

  it('returns the path unchanged without a directory', () => {
    expect(relativeToDirectory('/opt/code/OCC/src/a.ts')).toBe('/opt/code/OCC/src/a.ts')
  })
})
