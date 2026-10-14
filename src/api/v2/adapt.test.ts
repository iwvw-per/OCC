import { describe, expect, it } from 'vitest'
import { adaptSession } from './session'
import { adaptMessage, adaptMessagePage } from './message'
import { adaptPermission, adaptAgent, adaptPty } from './entities'

describe('v2 session adapter', () => {
  it('maps location.directory to directory and fills version placeholder', () => {
    const session = adaptSession({
      id: 'ses_1',
      title: 't',
      projectID: 'p1',
      location: { directory: '/work' },
      time: { created: 1, updated: 2 },
      tokens: { input: 3, output: 4, reasoning: 5, cache: { read: 6, write: 7 } },
    })
    expect(session.id).toBe('ses_1')
    expect(session.directory).toBe('/work')
    expect(session.version).toBe('')
    expect(session.time.created).toBe(1)
    expect(session.tokens).toEqual({ input: 3, output: 4, reasoning: 5, cache: { read: 6, write: 7 } })
  })
})

describe('v2 message adapter', () => {
  it('flattens assistant content[] into parts[]', () => {
    const msg = adaptMessage({
      id: 'msg_1',
      sessionID: 'ses_1',
      type: 'assistant',
      time: { created: 10 },
      agent: 'build',
      model: { id: 'm1', providerID: 'opencode' },
      content: [
        { type: 'text', text: 'hello' },
        { type: 'reasoning', text: 'thinking', time: { created: 11, completed: 12 } },
        { type: 'tool', id: 'call_1', name: 'bash', state: { status: 'completed', input: {}, content: [{ text: 'ok' }], time: { start: 13, end: 14 } } },
      ],
    })!
    expect(msg.info.role).toBe('assistant')
    expect(msg.parts.map(p => p.type)).toEqual(['text', 'reasoning', 'tool'])
    const tool = msg.parts[2] as { state: { status: string; output: string } }
    expect(tool.state.status).toBe('completed')
    expect(tool.state.output).toBe('ok')
  })

  it('maps user text to a single text part', () => {
    const msg = adaptMessage({ id: 'u1', sessionID: 's', type: 'user', time: { created: 1 }, text: 'hi' })!
    expect(msg.info.role).toBe('user')
    expect(msg.parts).toHaveLength(1)
    expect((msg.parts[0] as { text: string }).text).toBe('hi')
  })

  it('drops non user/assistant system messages (idle / agent-switched / model-switched)', () => {
    expect(adaptMessage({ id: 'x1', sessionID: 's', type: 'idle', time: { created: 1 } })).toBeNull()
    expect(adaptMessage({ id: 'x2', sessionID: 's', type: 'agent-switched', time: { created: 1 } })).toBeNull()
    expect(adaptMessage({ id: 'x3', sessionID: 's', type: 'model-switched', time: { created: 1 } })).toBeNull()
  })

  it('reads next cursor from body', () => {
    const page = adaptMessagePage({ data: [], cursor: { next: 'c1', previous: null } })
    expect(page.nextCursor).toBe('c1')
  })
})

describe('v2 entity adapters', () => {
  it('renames permission fields', () => {
    const p = adaptPermission({ id: 'p1', sessionID: 's', action: 'bash', resources: ['rm'], save: ['rm'], metadata: {} })
    expect(p.permission).toBe('bash')
    expect(p.patterns).toEqual(['rm'])
    expect(p.always).toEqual(['rm'])
  })

  it('maps agent id to name', () => {
    const a = adaptAgent({ id: 'build', name: 'Build', mode: 'primary', permissions: [{ action: '*', resource: '*', effect: 'allow' }] })
    expect(a.name).toBe('build')
    expect(a.mode).toBe('primary')
    expect(a.permission).toHaveLength(1)
  })

  it('fills pty size default', () => {
    const p = adaptPty({ id: 'pty_1', title: 't', status: 'running', pid: 5 }) as unknown as { size: { rows: number; cols: number } }
    expect(p.size).toEqual({ rows: 24, cols: 80 })
  })
})
