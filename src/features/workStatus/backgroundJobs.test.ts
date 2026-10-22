import { describe, expect, it } from 'vitest'
import type { Message } from '../../types/message'
import { collectBackgroundJobs, parseBackgroundNotice } from './backgroundJobs'

function userMessage(id: string, created: number): Message {
  return {
    info: {
      id,
      sessionID: 's',
      role: 'user',
      agent: 'build',
      model: { providerID: 'p', modelID: 'm' },
      time: { created },
    },
    content: [],
    isStreaming: false,
  }
}

function toolMessage(
  id: string,
  created: number,
  part: {
    tool: string
    status?: 'running' | 'completed' | 'pending'
    output?: string
    metadata?: Record<string, unknown>
    input?: Record<string, unknown>
  },
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
      time: { created, completed: created + 1 },
      finish: 'tool-calls',
    },
    content: [
      {
        id: `${id}-tool`,
        sessionID: 's',
        messageID: id,
        type: 'tool',
        callID: 'c1',
        tool: part.tool,
        state: {
          status: part.status ?? 'completed',
          input: part.input ?? {},
          ...(part.output != null ? { output: part.output } : {}),
          ...(part.metadata != null ? { metadata: part.metadata } : {}),
          time: { start: created, end: created + 1 },
        },
      },
    ],
    isStreaming: false,
  } as unknown as Message
}

function syntheticMessage(id: string, created: number, text: string): Message {
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
      time: { created, completed: created + 1 },
      finish: 'stop',
    },
    content: [{ id: `${id}-t`, sessionID: 's', messageID: id, type: 'text', text, synthetic: true }],
    isStreaming: false,
  } as unknown as Message
}

describe('parseBackgroundNotice', () => {
  it('parses a shell completion notice', () => {
    const notice = parseBackgroundNotice(
      '<shell id="sh_abc" state="completed" command="npm run build">BUILD OK</shell>',
    )
    expect(notice).toEqual({
      id: 'sh_abc',
      kind: 'shell',
      status: 'completed',
      title: 'npm run build',
      output: 'BUILD OK',
    })
  })

  it('parses a subagent completion notice', () => {
    const notice = parseBackgroundNotice(
      '<subagent sessionID="ses_child" state="error" description="重构">boom</subagent>',
    )
    expect(notice).toMatchObject({ id: 'ses_child', kind: 'subagent', status: 'error', title: '重构' })
  })

  it('returns null for unrelated synthetic text', () => {
    expect(parseBackgroundNotice('some other system note')).toBeNull()
  })

  it('normalizes unknown states', () => {
    const notice = parseBackgroundNotice('<shell id="sh_1" state="weird" command="x"></shell>')
    expect(notice?.status).toBe('unknown')
  })
})

describe('collectBackgroundJobs', () => {
  it('treats a backgrounded shell from history as finished', () => {
    const messages = [
      userMessage('u1', 1000),
      toolMessage('a1', 1001, {
        tool: 'bash',
        status: 'running',
        output: 'Command moved to the background (shell ID: sh_1).\nOutput is streaming to: /tmp/x.log',
        input: { command: 'npm run dev' },
      }),
    ]
    const jobs = collectBackgroundJobs(messages)
    expect(jobs).toHaveLength(1)
    /**
     * 历史消息里的后台任务一律按「已完成」。
     *
     * `background=true` 的调用会**立即返回**（工具 part 是 completed），任务继续
     * 在后台跑 —— 用工具状态判断会得到一堆「状态未知」，让用户以为都还在跑。
     * 真正的「运行中」由实时事件维护（backgroundJobStore）。
     */
    expect(jobs[0]).toMatchObject({
      id: 'sh_1',
      kind: 'shell',
      status: 'completed',
      title: 'npm run dev',
      messageId: 'a1',
    })
  })

  it('upgrades status when the completion notice arrives', () => {
    const messages = [
      userMessage('u1', 1000),
      toolMessage('a1', 1001, {
        tool: 'bash',
        status: 'running',
        output: 'Command moved to the background (shell ID: sh_1).',
        input: { command: 'npm run dev' },
      }),
      syntheticMessage('s1', 5000, '<shell id="sh_1" state="completed" command="npm run dev">ready</shell>'),
    ]
    const jobs = collectBackgroundJobs(messages)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ id: 'sh_1', status: 'completed', output: 'ready' })
    // 启动时间保留自工具消息，而不是被完成通知覆盖
    expect(jobs[0].startedAt).toBe(1001)
  })

  it('uses metadata.shellID instead of parsing the output text', () => {
    const messages = [
      toolMessage('a1', 1001, {
        tool: 'bash',
        status: 'running',
        metadata: { shellID: 'sh_meta' },
        input: { command: 'sleep 100' },
      }),
    ]
    expect(collectBackgroundJobs(messages)[0]).toMatchObject({ id: 'sh_meta', kind: 'shell' })
  })

  it('detects a backgrounded subagent', () => {
    const messages = [
      toolMessage('a1', 1001, {
        tool: 'subagent',
        status: 'completed',
        output: 'The subagent is working in the background (sessionID: ses_child). It will notify when done.',
        input: { description: '跑测试' },
      }),
    ]
    const jobs = collectBackgroundJobs(messages)
    expect(jobs[0]).toMatchObject({ id: 'ses_child', kind: 'subagent', title: '跑测试' })
    // 历史里读到的后台任务：没有完成通知也按已结束处理（保守且正确）
    expect(jobs[0].status).toBe('completed')
  })

  it('ignores foreground tool calls', () => {
    const messages = [
      toolMessage('a1', 1001, { tool: 'bash', status: 'completed', output: 'hello', input: { command: 'ls' } }),
    ]
    expect(collectBackgroundJobs(messages)).toEqual([])
  })

  it('sorts running jobs first', () => {
    const messages = [
      toolMessage('a1', 1001, {
        tool: 'bash',
        status: 'completed',
        metadata: { shellID: 'sh_live' },
        input: { command: 'dev' },
      }),
      toolMessage('a2', 2001, {
        tool: 'bash',
        status: 'completed',
        metadata: { shellID: 'sh_done' },
        input: { command: 'build' },
      }),
      syntheticMessage('s1', 3000, '<shell id="sh_done" state="completed" command="build">ok</shell>'),
    ]
    // 实时表说 sh_live 还在跑（历史只能证明它启动过）
    const live = new Map([['sh_live', { status: 'running' as const, at: 4000 }]])
    const jobs = collectBackgroundJobs(messages, live)
    expect(jobs.map(job => job.id)).toEqual(['sh_live', 'sh_done'])
    expect(jobs[0].status).toBe('running')
    expect(jobs[1].status).toBe('completed')
  })
})
