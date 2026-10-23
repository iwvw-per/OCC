/**
 * processActiveLabel：运行中折叠块里「此刻在做什么」的一句话。
 *
 * 背景：长任务实测跑过 17 分钟 / 165 步，而这期间界面上只有一行
 * 「Working for 17m」在跳秒。用户看不到任何进展，判定为卡住并反复打断，
 * 导致 `cargo test` 这类长命令永远跑不完（实测连续 4 轮被打断）。
 */
import { describe, expect, it } from 'vitest'
import type { Message } from '../../types/message'
import { processActiveLabel, type ProcessShellChild } from './chatAreaTimeline'

function toolMessage(
  id: string,
  tool: string,
  status: 'running' | 'pending' | 'completed' | 'error',
  input: Record<string, unknown>,
): Message {
  return {
    info: {
      id,
      sessionID: 's',
      role: 'assistant',
      parentID: 'u',
      modelID: 'm',
      providerID: 'p',
      mode: '',
      agent: 'build',
      path: { cwd: '', root: '' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, completed: 2 },
      finish: 'tool-calls',
    },
    content: [
      {
        id: `${id}-tool`,
        sessionID: 's',
        messageID: id,
        type: 'tool',
        callID: 'c1',
        tool,
        state: { status, input, time: { start: 1, end: 2 } },
      },
    ],
    isStreaming: false,
  } as unknown as Message
}

const child = (message: Message): ProcessShellChild => ({ message, processContentScope: 'process' })

describe('processActiveLabel', () => {
  it('reports the running tool and its command', () => {
    const children = [
      child(toolMessage('a1', 'shell', 'completed', { command: 'ls' })),
      child(toolMessage('a2', 'shell', 'running', { command: 'npx vitest run' })),
    ]
    expect(processActiveLabel(children)).toBe('shell · npx vitest run')
  })

  it('prefers a human description over the raw command', () => {
    const children = [
      child(toolMessage('a1', 'shell', 'running', { command: 'cd /x && npm test', description: '跑测试' })),
    ]
    expect(processActiveLabel(children)).toBe('shell · 跑测试')
  })

  it('falls back to the tool name when there is no readable input', () => {
    expect(processActiveLabel([child(toolMessage('a1', 'read', 'running', {}))])).toBe('read')
  })

  it('ignores finished tools (nothing is running)', () => {
    const children = [child(toolMessage('a1', 'shell', 'completed', { command: 'ls' }))]
    expect(processActiveLabel(children)).toBeUndefined()
  })

  it('truncates very long commands so the header stays one line', () => {
    const children = [child(toolMessage('a1', 'shell', 'running', { command: 'x'.repeat(400) }))]
    const label = processActiveLabel(children)
    expect(label).toBeDefined()
    expect(label!.length).toBeLessThanOrEqual(121)
    expect(label!.endsWith('…')).toBe(true)
  })
})
