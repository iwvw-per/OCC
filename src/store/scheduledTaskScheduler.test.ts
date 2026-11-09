import { describe, expect, it, vi, beforeEach } from 'vitest'
import { runTask } from './scheduledTaskScheduler'
import { sendMessageAsync } from '../api/message'
import { createSession } from '../api/session'
import { serverStore } from './serverStore'
import { type ScheduledTask } from './scheduledTaskStore'

vi.mock('../api/message', () => ({
  sendMessageAsync: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../api/session', () => ({
  createSession: vi.fn().mockResolvedValue({ id: 'ses_mock_scheduled' }),
}))

describe('scheduledTaskScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(serverStore, 'getActiveServerId').mockReturnValue('local')
  })

  it('发送消息时携带唯一的 messageID 以保证端到端幂等去重', async () => {
    const task: ScheduledTask = {
      id: 'task_1',
      name: 'Test Task',
      enabled: true,
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      execution: {
        directory: '/mock/dir',
        prompt: 'Hello world',
        providerID: 'mock-provider',
        modelID: 'mock-model',
      },
      createdAt: 1000,
      updatedAt: 1000,
    }

    await runTask(task)

    expect(createSession).toHaveBeenCalledWith({ directory: '/mock/dir' }, 'local')
    expect(sendMessageAsync).toHaveBeenCalledTimes(1)
    const callArgs = vi.mocked(sendMessageAsync).mock.calls[0]
    expect(callArgs[0]).toMatchObject({
      sessionId: 'ses_mock_scheduled',
      text: 'Hello world',
      directory: '/mock/dir',
    })
    expect(callArgs[0].messageID).toMatch(/^msg_[a-f0-9]+$/)
    expect(callArgs[1]).toBe('local')
  })
})
