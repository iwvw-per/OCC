import { describe, expect, it } from 'vitest'
import type { ToolPart } from '../../../types/message'
import { defaultExtractData, getToolColorClass, prettifyJsonOutput } from './registry'

describe('defaultExtractData', () => {
  it('extracts files and diagnostics from metadata', () => {
    const part = {
      type: 'tool',
      tool: 'read',
      id: 'tool-1',
      callID: 'call-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      state: {
        input: { filePath: 'src/app.ts' },
        metadata: {
          files: [
            {
              filePath: 'src/app.ts',
              diff: '@@ -1 +1 @@',
              additions: 1,
              deletions: 1,
            },
          ],
          diagnostics: {
            'src/app.ts': [
              {
                severity: 1,
                message: 'Syntax error',
                range: { start: { line: 3, character: 5 } },
              },
            ],
          },
        },
      },
    } as unknown as ToolPart

    const extracted = defaultExtractData(part)

    expect(extracted.files).toEqual([expect.objectContaining({ filePath: 'src/app.ts', additions: 1, deletions: 1 })])
    expect(extracted.diagnostics).toEqual([
      expect.objectContaining({ file: 'app.ts', severity: 'error', line: 3, column: 5 }),
    ])
  })
})

describe('getToolColorClass', () => {
  it('maps known tools to distinct category colors', () => {
    expect(getToolColorClass('read')).toBe('tool-color-read')
    expect(getToolColorClass('write')).toBe('tool-color-write')
    expect(getToolColorClass('bash')).toBe('tool-color-exec')
    expect(getToolColorClass('grep')).toBe('tool-color-search')
    expect(getToolColorClass('webfetch')).toBe('tool-color-network')
    expect(getToolColorClass('task')).toBe('tool-color-task')
    expect(getToolColorClass('todo')).toBe('tool-color-todo')
  })

  it('falls back to the default color for unknown tools', () => {
    expect(getToolColorClass('some-unknown-tool')).toBe('tool-color-default')
  })
})

describe('prettifyJsonOutput', () => {
  /**
   * 工具输出里的 JSON 常常压成一行几千字符（实测截图里的
   * `{"statusCode":200,"headers":{"Content-Type":[...`），在代码块里
   * 只能横向拖动才能读。格式化后结构一眼可见。
   */
  it('把单行 JSON 展开成缩进格式', () => {
    const oneLine = JSON.stringify({
      statusCode: 200,
      headers: { 'Content-Type': ['application/json'] },
      body: { ok: true, items: [1, 2, 3] },
    })
    expect(oneLine.includes('\n')).toBe(false)

    const pretty = prettifyJsonOutput(oneLine)

    expect(pretty).not.toBeNull()
    expect(pretty!.split('\n').length).toBeGreaterThan(3)
    expect(pretty).toContain('\n  "statusCode": 200')
    // 语义不变
    expect(JSON.parse(pretty!)).toEqual(JSON.parse(oneLine))
  })

  it('已经多行的 JSON 保持原样（不重排）', () => {
    const multiline = JSON.stringify({ a: 1, b: 2 }, null, 2)
    expect(prettifyJsonOutput(multiline)).toBeNull()
  })

  it('太短的 JSON 不处理（没有可读性收益）', () => {
    expect(prettifyJsonOutput('{"ok":true}')).toBeNull()
  })

  it('非对象/数组字面量不处理', () => {
    expect(prettifyJsonOutput('123')).toBeNull()
    expect(prettifyJsonOutput('"a string"')).toBeNull()
    expect(prettifyJsonOutput('null')).toBeNull()
  })

  it('解析失败时返回 null，绝不改写原文', () => {
    // 以 { 开头但不是合法 JSON（日志、模板、被截断的输出）
    const broken = `{"statusCode":200,"headers":{...truncated`
    expect(prettifyJsonOutput(broken)).toBeNull()
  })

  it('数组也能格式化', () => {
    const arr = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ id: i, name: `item-${i}` })))
    const pretty = prettifyJsonOutput(arr)
    expect(pretty).not.toBeNull()
    expect(pretty!.split('\n').length).toBeGreaterThan(10)
  })
})
