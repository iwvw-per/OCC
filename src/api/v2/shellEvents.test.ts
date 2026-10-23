/**
 * v2 shell 事件映射的回归测试。
 *
 * `shell.created` / `shell.exited` 是「后台任务是否还在跑」的权威信号。
 * 未映射它们时，面板只能从历史消息推导，而历史只能证明「曾经启动过」，
 * 于是所有后台任务都显示成已结束（用户报的问题）。
 */
import { describe, expect, it } from 'vitest'
import { v2EventToGlobalEvent } from './events'
import { EventTypes } from '../../types/api/event'

/**
 * 取映射后事件的 payload。
 *
 * `GlobalEvent` 是 v2 事件的联合类型，测试里构造的是自定义事件名，
 * 类型上收窄不到 `properties`，因此这里做一次断言。
 */
function payloadOf(event: ReturnType<typeof v2EventToGlobalEvent>) {
  return (event as unknown as { payload: { type: string; properties: Record<string, unknown> } }).payload
}

describe('shell.created', () => {
  it('carries the shell id, command and owning session', () => {
    const event = v2EventToGlobalEvent({
      type: 'shell.created',
      created: 1_700_000_000_000,
      location: { directory: '/opt/code/OCC' },
      data: {
        info: {
          id: 'sh_abc',
          status: 'running',
          command: 'npm run dev',
          cwd: '/opt/code/OCC',
          shell: '/usr/bin/bash',
          file: '/tmp/sh_abc.out',
          metadata: { sessionID: 'ses_1' },
          time: { started: 1_700_000_000_000 },
        },
      },
    })

    expect(payloadOf(event).type).toBe(EventTypes.SHELL_CREATED)
    expect(payloadOf(event).properties).toMatchObject({
      id: 'sh_abc',
      status: 'running',
      command: 'npm run dev',
      sessionID: 'ses_1',
      startedAt: 1_700_000_000_000,
    })
  })

  it('omits sessionID when the shell has no metadata owner', () => {
    const event = v2EventToGlobalEvent({
      type: 'shell.created',
      created: 1,
      data: { info: { id: 'sh_x', status: 'running', command: 'ls', metadata: {} } },
    })
    expect(payloadOf(event).properties).not.toHaveProperty('sessionID')
  })

  it('returns null when the id is missing', () => {
    expect(v2EventToGlobalEvent({ type: 'shell.created', data: { info: {} } })).toBeNull()
  })
})

describe('shell.exited', () => {
  it('carries the terminal status and exit code', () => {
    const event = v2EventToGlobalEvent({
      type: 'shell.exited',
      created: 1_700_000_009_000,
      data: { id: 'sh_abc', status: 'exited', exit: 0 },
    })

    expect(payloadOf(event).type).toBe(EventTypes.SHELL_EXITED)
    expect(payloadOf(event).properties).toMatchObject({
      id: 'sh_abc',
      status: 'exited',
      exit: 0,
      endedAt: 1_700_000_009_000,
    })
  })

  it('keeps a non-zero exit code so the UI can show failure', () => {
    const event = v2EventToGlobalEvent({
      type: 'shell.exited',
      created: 1,
      data: { id: 'sh_bad', status: 'exited', exit: 1 },
    })
    expect(payloadOf(event).properties).toMatchObject({ id: 'sh_bad', exit: 1 })
  })

  it('returns null when the id is missing', () => {
    expect(v2EventToGlobalEvent({ type: 'shell.exited', data: {} })).toBeNull()
  })
})
