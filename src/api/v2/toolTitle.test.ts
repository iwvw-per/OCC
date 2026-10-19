import { describe, expect, it } from 'vitest'
import { adaptMessage } from './message'

/**
 * 工具名显示回归。
 *
 * 用户反馈：对话里的工具都显示成「Execute」，看不出具体是什么工具。
 *
 * 两个原因叠加：
 *   1. adaptToolState 只在 completed 分支读 state.title，running/pending 丢掉，
 *      于是运行中的工具退回类型名；
 *   2. v2 的 part.name 是**工具类型**（execute/bash…），具体工具名在 input 里，
 *      前端直接拿 name 展示，同类工具就全显示成一个名字。
 */

function toolMessage(state: Record<string, unknown>) {
  return {
    id: 'msg_1',
    sessionID: 'ses_1',
    type: 'assistant',
    time: { created: 1 },
    content: [{ type: 'tool', id: 'tool_1', name: 'execute', state }],
  }
}

function toolPartOf(state: Record<string, unknown>) {
  const adapted = adaptMessage(toolMessage(state))
  return adapted?.parts[0]
}

describe('adaptToolState title', () => {
  it('keeps the title while the tool is running', () => {
    const part = toolPartOf({
      status: 'running',
      title: 'npm run validate',
      input: { command: 'npm run validate' },
      time: { start: 1 },
    })
    expect(part?.type).toBe('tool')
    // 运行中必须保留标题，否则界面只能显示类型名
    expect((part as { state: { title?: string } }).state.title).toBe('npm run validate')
  })

  it('keeps the title when pending/streaming', () => {
    const part = toolPartOf({ status: 'streaming', input: '{"command":"ls"}' })
    expect((part as { state: { title?: string } }).state.title).toBe('')
  })

  it('keeps the title on error', () => {
    const part = toolPartOf({
      status: 'error',
      title: 'git status',
      input: { command: 'git status' },
      error: { message: 'boom' },
      time: { start: 1 },
    })
    expect((part as { state: { title?: string } }).state.title).toBe('git status')
  })

  it('keeps the title on completion', () => {
    const part = toolPartOf({
      status: 'completed',
      title: 'npm test',
      input: { command: 'npm test' },
      content: [{ type: 'text', text: 'ok' }],
      time: { start: 1, end: 2 },
    })
    expect((part as { state: { title?: string } }).state.title).toBe('npm test')
  })
})
