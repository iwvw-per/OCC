import { beforeEach, describe, expect, it, vi } from 'vitest'

const { promptMock, switchAgentMock, switchModelMock, listMock, messageListMock } = vi.hoisted(() => ({
  promptMock: vi.fn(async () => ({})),
  switchAgentMock: vi.fn(async () => undefined),
  switchModelMock: vi.fn(async () => undefined),
  listMock: vi.fn(async () => ({ data: [], cursor: { next: null, previous: null } })),
  messageListMock: vi.fn(async () => ({ data: [], cursor: { next: 'c1', previous: null } })),
}))

vi.mock('./sdkV2', () => ({
  getV2Client: () => ({
    session: {
      prompt: promptMock,
      switchAgent: switchAgentMock,
      switchModel: switchModelMock,
      list: listMock,
    },
    message: { list: messageListMock },
  }),
}))

describe('v2 client facade', () => {
  beforeEach(() => {
    promptMock.mockClear()
    switchAgentMock.mockClear()
    switchModelMock.mockClear()
  })

  it('converts v1 parts[] into v2 prompt text/files/agents', async () => {
    const { createV2Facade } = await import('./clientFacade')
    const facade = createV2Facade('s1') as unknown as {
      session: { prompt: (input: unknown) => Promise<unknown> }
    }
    await facade.session.prompt({
      sessionID: 'ses_1',
      parts: [
        { type: 'text', text: 'hello' },
        { type: 'file', url: 'file:///a.png', filename: 'a.png' },
        { type: 'agent', name: 'build' },
      ],
    })
    expect(promptMock).toHaveBeenCalledTimes(1)
    const arg = (promptMock.mock.calls[0] as unknown[])[0] as { text: string; files: unknown[]; agents: unknown[] }
    expect(arg.text).toBe('hello')
    expect(arg.files).toEqual([{ uri: 'file:///a.png', name: 'a.png' }])
    expect(arg.agents).toEqual([{ name: 'build' }])
  })

  it('switches agent/model before prompting when provided', async () => {
    const { createV2Facade } = await import('./clientFacade')
    const facade = createV2Facade('s1') as unknown as {
      session: { prompt: (input: unknown) => Promise<unknown> }
    }
    await facade.session.prompt({
      sessionID: 'ses_1',
      text: 'hi',
      agent: 'plan',
      model: { providerID: 'opencode', modelID: 'm1' },
    })
    expect(switchAgentMock).toHaveBeenCalledWith({ sessionID: 'ses_1', agent: 'plan' })
    expect(switchModelMock).toHaveBeenCalledWith({ sessionID: 'ses_1', model: { providerID: 'opencode', id: 'm1' } })
    const arg = (promptMock.mock.calls[0] as unknown[])[0] as { text: string }
    expect(arg.text).toBe('hi')
  })

  it('exposes message cursor via X-Next-Cursor header', async () => {
    const { createV2Facade } = await import('./clientFacade')
    const facade = createV2Facade('s1') as unknown as {
      session: { messages: (input: unknown) => Promise<{ response?: { headers: { get(n: string): string | null } } }> }
    }
    const result = await facade.session.messages({ sessionID: 'ses_1', limit: 10 })
    expect(result.response?.headers.get('X-Next-Cursor')).toBe('c1')
  })

  it('clamps limit to v2 max (200) and requests newest first', async () => {
    const { createV2Facade } = await import('./clientFacade')
    const facade = createV2Facade('s1') as unknown as {
      session: { messages: (input: unknown) => Promise<unknown> }
    }
    messageListMock.mockClear()
    await facade.session.messages({ sessionID: 'ses_1', limit: 100000 })
    const arg = (messageListMock.mock.calls[0] as unknown[])[0] as { limit: number; order?: string; cursor?: string }
    expect(arg.limit).toBe(200)
    expect(arg.order).toBe('desc')
    expect(arg.cursor).toBeUndefined()
  })

  it('uses cursor (no order) when paging before', async () => {
    const { createV2Facade } = await import('./clientFacade')
    const facade = createV2Facade('s1') as unknown as {
      session: { messages: (input: unknown) => Promise<unknown> }
    }
    messageListMock.mockClear()
    await facade.session.messages({ sessionID: 'ses_1', limit: 30, before: 'CUR' })
    const arg = (messageListMock.mock.calls[0] as unknown[])[0] as { limit: number; order?: string; cursor?: string }
    expect(arg.limit).toBe(30)
    expect(arg.cursor).toBe('CUR')
    expect(arg.order).toBeUndefined()
  })
})
