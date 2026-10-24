import { describe, expect, it } from 'vitest'
import { adaptSession } from './session'
import { adaptMessage, adaptMessagePage } from './message'
import { adaptPermission, adaptAgent, adaptPty, adaptFileNode } from './entities'

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

  it('preserves time.streamed from the assistant message', () => {
    /**
     * streamed 是官方 tok/s 的分母来源（streamed − created）。
     * 之前适配层只搬 created/completed，这个字段被整条丢弃，
     * 导致前端只能退回整条消息时长，速度偏低。
     */
    const msg = adaptMessage({
      id: 'msg_1',
      sessionID: 'ses_1',
      type: 'assistant',
      time: { created: 1000, streamed: 3000, completed: 5000 },
      content: [{ type: 'text', text: 'hi' }],
    })!
    expect(msg.info.time).toMatchObject({ created: 1000, streamed: 3000, completed: 5000 })
  })

  it('omits streamed when the server did not provide it', () => {
    const msg = adaptMessage({
      id: 'msg_1',
      sessionID: 'ses_1',
      type: 'assistant',
      time: { created: 1000, completed: 5000 },
      content: [{ type: 'text', text: 'hi' }],
    })!
    expect(msg.info.time?.created).toBe(1000)
    expect(msg.info.time).not.toHaveProperty('streamed')
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

  it('exposes the latest completed compaction timestamp', () => {
    const page = adaptMessagePage({
      data: [
        { id: 'c1', sessionID: 's', type: 'compaction', status: 'failed', time: { created: 100 } },
        { id: 'c2', sessionID: 's', type: 'compaction', status: 'completed', time: { created: 200 } },
        { id: 'c3', sessionID: 's', type: 'compaction', status: 'completed', time: { created: 150 } },
        { id: 'u1', sessionID: 's', type: 'user', text: 'hi', time: { created: 300 } },
      ],
      cursor: {},
    })
    expect(page.compactedAt).toBe(200)
  })

  it('leaves compactedAt undefined when no compaction completed', () => {
    const page = adaptMessagePage({
      data: [{ id: 'c1', sessionID: 's', type: 'compaction', status: 'failed', time: { created: 100 } }],
      cursor: {},
    })
    expect(page.compactedAt).toBeUndefined()
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

describe('v2 file node adapter (cross-platform paths)', () => {
  it('Linux 正斜杠相对路径', () => {
    const n = adaptFileNode({ path: 'apps/(app)/index.ts', type: 'file' }, { directory: '/home/u/proj' })
    expect(n.name).toBe('index.ts')
    expect(n.path).toBe('apps/(app)/index.ts')
    expect(n.absolute).toBe('/home/u/proj/apps/(app)/index.ts')
  })

  it('Windows 反斜杠相对路径：name 只取最后一段，不带父目录', () => {
    const n = adaptFileNode({ path: 'apps\\web\\src\\index.ts', type: 'file' }, { directory: 'C:\\dev\\proj' })
    expect(n.name).toBe('index.ts')
    expect(n.path).toBe('apps/web/src/index.ts')
    expect(n.absolute).toBe('C:/dev/proj/apps/web/src/index.ts')
  })

  it('Windows 目录带尾反斜杠：name 不带尾分隔符，更不嵌套父目录名', () => {
    const n = adaptFileNode({ path: '.agents\\', type: 'directory' }, { directory: 'C:\\dev\\proj' })
    expect(n.name).toBe('.agents')
    expect(n.path).toBe('.agents')
    expect(n.absolute).toBe('C:/dev/proj/.agents')
    expect(n.type).toBe('directory')
  })

  it('目录带尾正斜杠（Linux）同样去掉', () => {
    const n = adaptFileNode({ path: 'node_modules/', type: 'directory' }, { directory: '/p' })
    expect(n.name).toBe('node_modules')
    expect(n.path).toBe('node_modules')
    expect(n.absolute).toBe('/p/node_modules')
  })
})
