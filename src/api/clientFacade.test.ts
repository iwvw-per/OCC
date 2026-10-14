import { beforeEach, describe, expect, it, vi } from 'vitest'

const { promptMock, switchAgentMock, switchModelMock, listMock, messageListMock, vcsGetMock, resourceCatalogMock, fileListMock, fileFindMock, skillListMock, sessionActiveMock, projectListMock, locationGetMock, commandListMock } =
  vi.hoisted(() => ({
    promptMock: vi.fn(async () => ({})),
    switchAgentMock: vi.fn(async () => undefined),
    switchModelMock: vi.fn(async () => undefined),
    listMock: vi.fn<(input?: Record<string, unknown>) => Promise<unknown>>(async () => ({ data: [], cursor: { next: null, previous: null } })),
    messageListMock: vi.fn(async () => ({ data: [], cursor: { next: 'c1', previous: null } })),
    vcsGetMock: vi.fn(async () => ({
      location: { directory: '/d' },
      data: { provider: 'github', branch: { current: 'main', default: 'main' } },
    })),
    resourceCatalogMock: vi.fn(async () => ({
      location: { directory: '/d' },
      data: { resources: [{ server: 'srv', name: 'r1', uri: 'uri://1' }], templates: [] },
    })),
    fileListMock: vi.fn(async () => ({
      location: { directory: '/d' },
      data: [
        { path: 'src/app.tsx', type: 'file' },
        { path: 'docs', type: 'directory' },
      ],
    })),
    fileFindMock: vi.fn(async () => ({
      location: { directory: '/d' },
      data: [{ path: 'src/app.tsx', type: 'file' }],
    })),
    skillListMock: vi.fn(async () => ({
      location: { directory: '/d' },
      data: [{ id: 's1', name: 'deploy', description: 'deploy', path: 'file:///skills/deploy', content: '...' }],
    })),
    sessionActiveMock: vi.fn(async () => ({ ses_running: { type: 'running' } })),
    projectListMock: vi.fn(async () => [
      { id: 'p1', canonical: '/d', vcs: 'git', name: 'proj', time: { created: 1, updated: 2, active: 1 } },
    ]),
    locationGetMock: vi.fn(async () => ({ directory: '/d', project: { id: 'p1', directory: '/d', canonical: '/d' } })),
    commandListMock: vi.fn(async () => ({
      location: { directory: '/d' },
      data: [{ name: 'build', description: 'build' }],
    })),
  }),
)

vi.mock('./sdkV2', () => ({
  getV2Client: () => ({
    session: {
      prompt: promptMock,
      switchAgent: switchAgentMock,
      switchModel: switchModelMock,
      list: listMock,
      active: sessionActiveMock,
    },
    message: { list: messageListMock },
    vcs: { get: vcsGetMock },
    mcp: { resource: { catalog: resourceCatalogMock } },
    file: { list: fileListMock, find: fileFindMock },
    skill: { list: skillListMock },
    project: { list: projectListMock },
    location: { get: locationGetMock },
    command: { list: commandListMock },
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

  it('exposes the v1 experimental.session.list entry (top-level experimental)', async () => {
    const { createV2Facade } = await import('./clientFacade')
    const facade = createV2Facade('s1') as unknown as {
      experimental: { session: { list: (input: unknown) => Promise<unknown> } }
    }
    listMock.mockResolvedValueOnce({
      data: [
        {
          id: 'ses_1',
          slug: 's1',
          projectID: 'p1',
          location: { directory: '/d' },
          time: { created: 1, updated: 2 },
        },
      ],
    })
    const result = (await facade.experimental.session.list({ directory: '/d' })) as { data: unknown[] }
    expect(Array.isArray(result.data)).toBe(true)
    expect((result.data[0] as { id: string }).id).toBe('ses_1')
  })

  it('exposes v1 experimental.resource.list from v2 mcp catalog', async () => {
    const { createV2Facade } = await import('./clientFacade')
    const facade = createV2Facade('s1') as unknown as {
      experimental: { resource: { list: (input: unknown) => Promise<unknown> } }
    }
    const result = (await facade.experimental.resource.list({ directory: '/d' })) as { data: Record<string, unknown> }
    expect(result.data).toEqual({
      r1: expect.objectContaining({ name: 'r1', uri: 'uri://1', client: 'srv' }),
    })
    expect(resourceCatalogMock).toHaveBeenCalledWith({ location: { directory: '/d' } })
  })

  it('maps v2 Vcs.Info.branch object into the v1 string contract', async () => {
    const { createV2Facade } = await import('./clientFacade')
    const facade = createV2Facade('s1') as unknown as {
      vcs: { get: (input: unknown) => Promise<{ data?: { branch?: unknown; default_branch?: unknown } }> }
    }
    const result = await facade.vcs.get({ directory: '/d' })
    const data = result.data as { branch?: unknown; default_branch?: unknown }
    expect(data.branch).toBe('main')
    expect(data.default_branch).toBe('main')
    expect(typeof data.branch).toBe('string')
  })

  it('maps v2 file entries into v1 FileNode shape with name/absolute/ignored', async () => {
    const { createV2Facade } = await import('./clientFacade')
    const facade = createV2Facade('s1') as unknown as {
      file: { list: (input: unknown) => Promise<{ data?: Array<{ name: string; absolute: string; type: string }> }> }
    }
    const result = await facade.file.list({ directory: '/d' })
    const nodes = result.data ?? []
    expect(nodes).toHaveLength(2)
    expect(nodes[0]).toEqual({
      name: 'app.tsx',
      path: 'src/app.tsx',
      absolute: '/d/src/app.tsx',
      type: 'file',
      ignored: false,
    })
    expect(nodes[1].name).toBe('docs')
    expect(nodes[1].type).toBe('directory')
    expect(nodes[1].absolute).toBe('/d/docs')
  })

  it('maps v2 file.find into a v1 string[] of paths (searchFiles contract)', async () => {
    const { createV2Facade } = await import('./clientFacade')
    const facade = createV2Facade('s1') as unknown as {
      find: { files: (input: unknown) => Promise<{ data?: string[] }> }
    }
    const result = await facade.find.files({ query: 'app', directory: '/d' })
    expect(result.data).toEqual(['src/app.tsx'])
  })

  it('maps v2 skill.path into v1 location for the skills list', async () => {
    const { createV2Facade } = await import('./clientFacade')
    const facade = createV2Facade('s1') as unknown as {
      app: { skills: (input: unknown) => Promise<{ data?: Array<{ location: string; name: string }> }> }
    }
    const result = await facade.app.skills({ directory: '/d' })
    expect(result.data?.[0]).toEqual(
      expect.objectContaining({ name: 'deploy', location: 'file:///skills/deploy' }),
    )
  })

  it('maps v2 session.active into v1 SessionStatusMap (running -> busy)', async () => {
    const { createV2Facade } = await import('./clientFacade')
    const facade = createV2Facade('s1') as unknown as {
      session: { status: (input: unknown) => Promise<{ data?: Record<string, { type: string }> }> }
    }
    const result = await facade.session.status({ directory: '/d' })
    expect(result.data).toEqual({ ses_running: { type: 'busy' } })
  })

  it('maps v2 project.list into v1 list and location.get into project.current', async () => {
    const { createV2Facade } = await import('./clientFacade')
    const facade = createV2Facade('s1') as unknown as {
      project: {
        list: (input: unknown) => Promise<{ data?: unknown[] }>
        current: (input: unknown) => Promise<{ data?: { id: string; worktree: string } }>
      }
    }
    const listRes = await facade.project.list({ directory: '/d' })
    expect(Array.isArray(listRes.data)).toBe(true)
    const currentRes = await facade.project.current({ directory: '/d' })
    expect(currentRes.data).toEqual({ id: 'p1', worktree: '/d', vcs: undefined, name: undefined })
  })

  it('forwards directory to v2 command.list and returns v1-shaped command list', async () => {
    const { createV2Facade } = await import('./clientFacade')
    const facade = createV2Facade('s1') as unknown as {
      command: { list: (input: unknown) => Promise<{ data?: Array<{ name: string }> }> }
    }
    const result = await facade.command.list({ directory: '/d' })
    expect(commandListMock).toHaveBeenCalledWith({ location: { directory: '/d' } })
    expect(result.data).toEqual([{ name: 'build', description: 'build' }])
  })

  it('safely degrades question / worktree / find.text / session.todo instead of throwing', async () => {
    const { createV2Facade } = await import('./clientFacade')
    const facade = createV2Facade('s1') as unknown as {
      question: { list: (input: unknown) => Promise<{ data?: unknown }> }
      worktree: { list: (input: unknown) => Promise<{ data?: unknown }> }
      find: { text: (input: unknown) => Promise<{ data?: unknown }> }
      session: { todo: (input: unknown) => Promise<{ data?: unknown }> }
    }
    expect((await facade.question.list({})).data).toEqual([])
    expect((await facade.worktree.list({})).data).toEqual([])
    expect((await facade.find.text({})).data).toEqual([])
    expect((await facade.session.todo({})).data).toEqual([])
  })
})
