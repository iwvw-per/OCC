/**
 * 后台任务状态修复的回归测试。
 *
 * 用户报的两个问题：
 *   1. 后台任务的分配始终是「已结束」状态；
 *   2. 点击条目没有细节弹窗。
 *
 * 根因：
 *   - 历史推导（工具回执）把状态猜成 completed，再叠加 store 的
 *     「终态不可回退到 running」，真正在跑的任务被永久钉死；
 *   - 骨架路径下任务的 messageId 是空串，点击等于什么都不做。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { backgroundJobStore } from './backgroundJobStore'
import { collectBackgroundJobs } from '../features/workStatus/backgroundJobs'
import type { Message } from '../types/message'

const SID = 'ses_test'

function toolMessage(id: string, created: number, shellID: string, command: string): Message {
  return {
    info: {
      id,
      sessionID: SID,
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
        sessionID: SID,
        messageID: id,
        type: 'tool',
        callID: 'c1',
        tool: 'bash',
        state: {
          status: 'completed',
          // 后台调用：metadata.shellID 只有配合 background 语义才算后台任务
          input: { command, background: true },
          metadata: { shellID },
          time: { start: created, end: created + 1 },
        },
      },
    ],
    isStreaming: false,
  } as unknown as Message
}

describe('后台任务状态：权威来源可以纠正历史推导', () => {
  beforeEach(() => {
    backgroundJobStore.clearAll()
  })

  it('lets a real shell.created event override the inferred "completed"', () => {
    // 骨架/历史推导先写进一个 completed（非权威）
    backgroundJobStore.set(SID, {
      id: 'sh_1',
      status: 'completed',
      at: 1000,
      title: 'npm run dev',
      authoritative: false,
    })
    // 实时事件证明它其实还在跑
    backgroundJobStore.set(SID, {
      id: 'sh_1',
      status: 'running',
      at: 2000,
      authoritative: true,
    })

    const job = backgroundJobStore.getSnapshot(SID).get('sh_1')
    expect(job?.status).toBe('running')
    // 权威来源带来真实开始时刻，覆盖骨架兜底用的「会话末条消息时间」
    expect(job?.at).toBe(2000)
  })

  it('keeps the earliest timestamp across repeated running events', () => {
    backgroundJobStore.set(SID, { id: 'sh_1b', status: 'running', at: 1000, authoritative: true })
    backgroundJobStore.set(SID, { id: 'sh_1b', status: 'running', at: 5000, authoritative: true, title: 'dev' })

    const job = backgroundJobStore.getSnapshot(SID).get('sh_1b')
    expect(job?.status).toBe('running')
    expect(job?.at).toBe(1000)
    expect(job?.title).toBe('dev')
  })

  it('does not let a stale inferred value undo an authoritative final state', () => {
    backgroundJobStore.set(SID, {
      id: 'sh_2',
      status: 'completed',
      at: 3000,
      authoritative: true,
    })
    // 迟到的历史推导（非权威）不应把它拉回 running
    backgroundJobStore.set(SID, {
      id: 'sh_2',
      status: 'running',
      at: 4000,
      authoritative: false,
    })

    expect(backgroundJobStore.getSnapshot(SID).get('sh_2')?.status).toBe('completed')
  })

  it('marks history-derived jobs as non-authoritative', () => {
    const jobs = collectBackgroundJobs([toolMessage('a1', 1000, 'sh_3', 'sleep 100')])
    expect(jobs).toHaveLength(1)
    // 兜底显示成已完成，但明确标记「不是权威结论」
    expect(jobs[0]).toMatchObject({ id: 'sh_3', status: 'completed', authoritative: false })
  })

  it('reconcileRunning promotes jobs that shell.list reports as running', () => {
    backgroundJobStore.set(SID, {
      id: 'sh_4',
      status: 'completed',
      at: 1000,
      authoritative: false,
    })

    backgroundJobStore.reconcileRunning(
      SID,
      new Map([['sh_4', { at: 900, title: 'npm run dev' }]]),
      [],
    )

    expect(backgroundJobStore.getSnapshot(SID).get('sh_4')?.status).toBe('running')
  })

  it('reconcileRunning settles jobs that are no longer in shell.list', () => {
    backgroundJobStore.set(SID, {
      id: 'sh_5',
      status: 'running',
      at: 1000,
      authoritative: true,
    })

    // shell.list 为空 = 已经没有在跑的 shell
    backgroundJobStore.reconcileRunning(SID, new Map(), ['sh_5'])

    expect(backgroundJobStore.getSnapshot(SID).get('sh_5')?.status).toBe('completed')
  })

  it('reports which sessions own a job (shell.exited carries no sessionID)', () => {
    backgroundJobStore.set(SID, { id: 'sh_6', status: 'running', at: 1000 })
    backgroundJobStore.set('ses_other', { id: 'sh_7', status: 'running', at: 1000 })

    expect(backgroundJobStore.sessionIdsFor('sh_6')).toEqual([SID])
    expect(backgroundJobStore.sessionIdsFor('sh_7')).toEqual(['ses_other'])
    expect(backgroundJobStore.sessionIdsFor('sh_missing')).toEqual([])
  })

  it('keeps the messageId carried by the skeleton so rows stay clickable', () => {
    // 骨架路径：任务只挂轮次上，messageId 是轮次 id
    backgroundJobStore.set(SID, {
      id: 'sh_8',
      status: 'completed',
      at: 1000,
      title: 'build',
      messageId: 'msg_user_turn',
      authoritative: false,
    })

    const jobs = collectBackgroundJobs([], backgroundJobStore.getSnapshot(SID))
    expect(jobs).toHaveLength(1)
    expect(jobs[0].messageId).toBe('msg_user_turn')
  })

  it('distinguishes registered jobs from arbitrary shells (has guard)', () => {
    backgroundJobStore.set(SID, { id: 'sh_bg', status: 'running', at: 1000 })

    // 已登记的后台任务
    expect(backgroundJobStore.has(SID, 'sh_bg')).toBe(true)
    // 前台命令的 shell：没有登记，不能被 shell.created 凭空加成后台任务
    expect(backgroundJobStore.has(SID, 'sh_foreground')).toBe(false)
    expect(backgroundJobStore.has('ses_other', 'sh_bg')).toBe(false)
  })
})
