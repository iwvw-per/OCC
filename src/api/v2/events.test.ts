import { describe, expect, it } from 'vitest'
import { v2EventToGlobalEvent } from './events'
import { EventTypes } from '../../types/api/event'

function payloadOf(raw: unknown): { type: string; properties: Record<string, unknown> } | null {
  const g = v2EventToGlobalEvent(raw)
  return g ? (g.payload as { type: string; properties: Record<string, unknown> }) : null
}

describe('v2 event → GlobalEvent', () => {
  it('maps server.connected', () => {
    const p = payloadOf({ type: 'server.connected', data: {}, location: { directory: '/w' } })
    expect(p?.type).toBe(EventTypes.SERVER_CONNECTED)
  })

  it('maps session.created to v1 SESSION_CREATED with info', () => {
    const p = payloadOf({
      type: 'session.created',
      data: { sessionID: 'ses_1', title: 't' },
      location: { directory: '/w', subpath: '' },
    })
    expect(p?.type).toBe(EventTypes.SESSION_CREATED)
    const info = p?.properties.info as { id: string; title: string; directory: string }
    expect(info.id).toBe('ses_1')
  })

  it('adapts session.created v2 shape: sessionID/location.directory → id/directory, event created → time', () => {
    const p = payloadOf({
      id: 'evt_1',
      created: 1792032110104,
      type: 'session.created',
      location: { directory: '/tmp/o/w' },
      data: { sessionID: 'ses_v2', slug: 'happy-panda', projectID: 'p', location: { directory: '/tmp/o/w' }, subpath: '' },
    })!
    const info = p.properties.info as {
      id: string
      directory: string
      parentID?: string
      version?: string
      time?: { created?: number; updated?: number }
    }
    expect(info.id).toBe('ses_v2')
    expect(info.directory).toBe('/tmp/o/w')
    expect(info.time?.created).toBe(1792032110104)
    expect(info.time?.updated).toBe(1792032110104)
  })

  it('adapts session.moved to SESSION_UPDATED using data.location; falls back to event location for metadata.updated', () => {
    const moved = payloadOf({
      id: 'evt_m',
      created: 1000,
      type: 'session.moved',
      location: { directory: '/a' },
      data: { sessionID: 's', location: { directory: '/b' } },
    })!
    expect(moved.type).toBe(EventTypes.SESSION_UPDATED)
    expect((moved.properties.info as { directory: string }).directory).toBe('/b')

    const meta = payloadOf({
      id: 'evt_meta',
      created: 2000,
      type: 'session.metadata.updated',
      location: { directory: '/a' },
      data: { sessionID: 's', metadata: { starred: true } },
    })!
    expect(meta.type).toBe(EventTypes.SESSION_UPDATED)
    expect((meta.properties.info as { id: string; directory: string }).id).toBe('s')
    expect((meta.properties.info as { directory: string }).directory).toBe('/a')
  })

  it('maps text.delta to MESSAGE_PART_DELTA (assistantMessageID + ordinal)', () => {
    const p = payloadOf({
      type: 'session.text.delta',
      data: { sessionID: 's', assistantMessageID: 'm', ordinal: 2, delta: 'hi' },
      location: { directory: '/w' },
    })
    expect(p?.type).toBe(EventTypes.MESSAGE_PART_DELTA)
    expect(p?.properties).toMatchObject({ sessionID: 's', messageID: 'm', partID: 'm-text-2', field: 'text', delta: 'hi' })
  })

  it('maps step.started to MESSAGE_UPDATED assistant skeleton', () => {
    const p = payloadOf({
      type: 'session.step.started',
      data: { sessionID: 's', assistantMessageID: 'm', agent: 'build' },
      location: { directory: '/w' },
    })
    expect(p?.type).toBe(EventTypes.MESSAGE_UPDATED)
    const info = p?.properties.info as { id: string; role: string; agent: string }
    expect(info?.id).toBe('m')
    expect(info?.role).toBe('assistant')
    expect(info?.agent).toBe('build')
  })

  it('maps session.renamed to SESSION_RENAMED with sessionID + title (not full session)', () => {
    const p = payloadOf({
      type: 'session.renamed',
      data: { sessionID: 'ses_1', title: '递归定义与示例' },
      location: { directory: '/w' },
    })
    expect(p?.type).toBe(EventTypes.SESSION_RENAMED)
    expect(p?.properties).toEqual({ sessionID: 'ses_1', title: '递归定义与示例' })
  })

  it('maps session.retry.scheduled to SESSION_RETRY_SCHEDULED with assistantMessageID', () => {
    const p = payloadOf({
      type: 'session.retry.scheduled',
      data: { sessionID: 'ses_1', assistantMessageID: 'msg_old', attempt: 2, at: 1, error: { type: 'rate_limit', message: 'x' } },
      location: { directory: '/w' },
    })
    expect(p?.type).toBe(EventTypes.SESSION_RETRY_SCHEDULED)
    expect(p?.properties).toEqual({ sessionID: 'ses_1', assistantMessageID: 'msg_old' })
  })

  it('maps execution.succeeded to SESSION_IDLE with the server event time', () => {
    const p = payloadOf({
      type: 'session.execution.succeeded',
      created: 1_700_000_123_456,
      data: { sessionID: 's' },
      location: { directory: '/w' },
    })
    expect(p?.type).toBe(EventTypes.SESSION_IDLE)
    expect(p?.properties.sessionID).toBe('s')
    // 完成时间必须取服务端事件时间：两端处理事件的本地时刻不同，
    // 用它做通知时间戳才能让「已读水位」跨端比较一致。
    expect(p?.properties.timestamp).toBe(1_700_000_123_456)
  })

  it('maps session.idle to SESSION_IDLE with the server event time', () => {
    const p = payloadOf({
      type: 'session.idle',
      created: 1_700_000_222_000,
      data: { sessionID: 's' },
      location: { directory: '/w' },
    })
    expect(p?.type).toBe(EventTypes.SESSION_IDLE)
    expect(p?.properties.timestamp).toBe(1_700_000_222_000)
  })

  it('carries the server event time on session.status idle', () => {
    const p = payloadOf({
      type: 'session.status',
      created: 1_700_000_333_000,
      data: { sessionID: 's', status: { type: 'idle' } },
      location: { directory: '/w' },
    })
    expect(p?.type).toBe(EventTypes.SESSION_STATUS)
    expect(p?.properties.timestamp).toBe(1_700_000_333_000)
  })

  it('maps execution.started to SESSION_STATUS busy (drives sidebar activity)', () => {
    const p = payloadOf({
      type: 'session.execution.started',
      data: { sessionID: 's' },
      location: { directory: '/w' },
    })
    expect(p?.type).toBe(EventTypes.SESSION_STATUS)
    expect((p?.properties.status as { type: string }).type).toBe('busy')
  })

  it('carries the compaction sizes so the context ring can drop', () => {
    const p = payloadOf({
      type: 'session.compaction.ended',
      created: 1_700_000_000_000,
      data: {
        sessionID: 's',
        reason: 'manual',
        text: 's'.repeat(5442),
        recent: 'r'.repeat(92_322),
        // 压缩前用量：绝不能当作压缩后的上下文
        tokens: { input: 342_383, output: 2443, reasoning: 0, cache: { read: 577_024, write: 0 } },
        cost: 0,
      },
      location: { directory: '/w' },
    })

    expect(p?.type).toBe(EventTypes.SESSION_COMPACTED)
    expect(p?.properties.summaryChars).toBe(5442)
    expect(p?.properties.recentChars).toBe(92_322)
  })

  it('maps a compaction part to SESSION_COMPACTED with its boundary', () => {
    // v2 的实时压缩信号走 message.part.updated + part.type === "compaction"
    const started = payloadOf({
      type: 'message.part.updated',
      created: 1,
      data: { part: { id: 'prt_1', sessionID: 's', messageID: 'msg_1', type: 'compaction', auto: false } },
      location: { directory: '/w' },
    })
    expect(started?.type).toBe(EventTypes.SESSION_COMPACTED)
    expect(started?.properties.status).toBe('started')

    const ended = payloadOf({
      type: 'message.part.updated',
      created: 2,
      data: {
        part: {
          id: 'prt_1',
          sessionID: 's',
          messageID: 'msg_1',
          type: 'compaction',
          auto: false,
          tail_start_id: 'msg_tail',
        },
      },
      location: { directory: '/w' },
    })
    expect(ended?.properties.status).toBe('completed')
    expect(ended?.properties.tailStartID).toBe('msg_tail')
  })

  it('ignores non-compaction parts on message.part.updated', () => {
    const p = payloadOf({
      type: 'message.part.updated',
      data: { part: { id: 'prt_1', sessionID: 's', messageID: 'msg_1', type: 'text' } },
      location: { directory: '/w' },
    })
    expect(p).toBeNull()
  })

  it('maps text.started to MESSAGE_PART_UPDATED text part', () => {
    const p = payloadOf({
      type: 'session.text.started',
      data: { sessionID: 's', assistantMessageID: 'm', ordinal: 0 },
      location: { directory: '/w' },
    })
    expect(p?.type).toBe(EventTypes.MESSAGE_PART_UPDATED)
    const part = p?.properties.part as { id: string; messageID: string; type: string; text: string }
    expect(part?.id).toBe('m-text-0')
    expect(part?.messageID).toBe('m')
    expect(part?.type).toBe('text')
    expect(part?.text).toBe('')
  })

  it('maps permission.asked to flat permission properties', () => {
    const p = payloadOf({
      type: 'permission.asked',
      data: { id: 'p1', sessionID: 's', permission: 'bash', patterns: ['ls'] },
      location: { directory: '/w' },
    })
    expect(p?.type).toBe(EventTypes.PERMISSION_ASKED)
    expect(p?.properties).toMatchObject({ id: 'p1', sessionID: 's', permission: 'bash' })
    expect(p?.properties.request).toBeUndefined()
  })

  it('maps question.asked to flat QUESTION_ASKED', () => {
    const p = payloadOf({
      type: 'question.asked',
      data: { id: 'q1', sessionID: 's', questions: [{ header: 'H' }] },
      location: { directory: '/w' },
    })
    expect(p?.type).toBe(EventTypes.QUESTION_ASKED)
    expect(p?.properties.id).toBe('q1')
    expect(p?.properties.request).toBeUndefined()
  })

  it('maps form.created to flat QUESTION_ASKED', () => {
    const p = payloadOf({ type: 'form.created', data: { form: { id: 'f1' } }, location: { directory: '/w' } })
    expect(p?.type).toBe(EventTypes.QUESTION_ASKED)
    expect(p?.properties.id).toBe('f1')
  })

  it('converts OMO form fields into questions so InlineQuestion never sees undefined questions', () => {
    const p = payloadOf({
      type: 'form.created',
      data: {
        form: {
          id: 'f1',
          sessionID: 's',
          title: 'Pick env',
          fields: [
            { key: 'env', type: 'string', title: 'Environment', options: [{ value: 'prod', label: 'Production' }] },
            { key: 'debug', type: 'boolean', title: 'Enable debug' },
            { key: 'tags', type: 'multiselect', title: 'Tags', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
            { key: 'port', type: 'integer', title: 'Port' },
          ],
        },
      },
      location: { directory: '/w' },
    })
    const questions = p?.properties.questions as Array<Record<string, unknown>>
    expect(Array.isArray(questions)).toBe(true)
    expect(questions).toHaveLength(4)
    // string 字段：选项直取 value，带 custom 输入兜底
    expect(questions[0]).toMatchObject({ fieldKey: 'env', fieldType: 'string', options: [{ label: 'prod' }] })
    // boolean 字段：true/false 二选一
    expect(questions[1]).toMatchObject({ fieldKey: 'debug', fieldType: 'boolean', options: [{ label: 'true' }, { label: 'false' }] })
    // multiselect：multiple
    expect(questions[2]).toMatchObject({ fieldKey: 'tags', fieldType: 'multiselect', multiple: true })
    // integer：走 custom 文本输入
    expect(questions[3]).toMatchObject({ fieldKey: 'port', fieldType: 'integer', multiple: false })
  })

  it('keeps questions array intact when question.asked already carries it', () => {
    const p = payloadOf({
      type: 'question.asked',
      data: { id: 'q1', sessionID: 's', questions: [{ header: 'H' }] },
      location: { directory: '/w' },
    })
    expect((p?.properties.questions as unknown[]).length).toBe(1)
  })

  it('maps v2 permission.asked to v1 shape with tool.callID derived from source', () => {
    const p = payloadOf({
      type: 'permission.asked',
      data: {
        id: 'perm-1',
        sessionID: 's',
        action: 'bash',
        resources: ['/x'],
        source: { type: 'tool', messageID: 'm-1', id: 'call-1' },
      },
      location: { directory: '/w' },
    })
    expect(p?.type).toBe(EventTypes.PERMISSION_ASKED)
    const props = p?.properties as Record<string, unknown>
    expect(props.permission).toBe('bash')
    expect((props.patterns as string[])).toEqual(['/x'])
    expect((props.tool as { callID: string }).callID).toBe('call-1')
    expect((props.tool as { messageID: string }).messageID).toBe('m-1')
  })

  it('maps tool.input.started to a pending tool part carrying the tool name', () => {
    const p = payloadOf({
      type: 'session.tool.input.started',
      data: { sessionID: 's', assistantMessageID: 'm', id: 'call_1', name: 'read' },
      location: { directory: '/w' },
    })
    expect(p?.type).toBe(EventTypes.MESSAGE_PART_UPDATED)
    const part = p?.properties.part as { callID: string; tool: string; state: { status: string } }
    expect(part?.callID).toBe('call_1')
    expect(part?.tool).toBe('read')
    expect(part?.state.status).toBe('pending')
  })

  it('maps tool.called to a running tool part with input', () => {
    const p = payloadOf({
      type: 'session.tool.called',
      data: { sessionID: 's', assistantMessageID: 'm', id: 'call_1', input: { path: '/x' } },
      location: { directory: '/w' },
    })
    const part = p?.properties.part as { callID: string; state: { status: string; input: unknown } }
    expect(part?.callID).toBe('call_1')
    expect(part?.state.status).toBe('running')
    expect(part?.state.input).toEqual({ path: '/x' })
  })

  it('maps tool.success content[] text blocks to settled output', () => {
    const p = payloadOf({
      type: 'session.tool.success',
      data: { sessionID: 's', assistantMessageID: 'm', id: 'call_1', content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }] },
      location: { directory: '/w' },
    })
    expect(p?.type).toBe(EventTypes.SESSION_NEXT_TOOL_SUCCESS)
    expect(p?.properties.callID).toBe('call_1')
    expect(p?.properties.output).toBe('line1\nline2')
  })

  it('maps execution.interrupted to SESSION_IDLE so the session stops spinning', () => {
    const p = payloadOf({
      type: 'session.execution.interrupted',
      data: { sessionID: 's', reason: 'user' },
      location: { directory: '/w' },
    })
    expect(p?.type).toBe(EventTypes.SESSION_IDLE)
    expect(p?.properties.sessionID).toBe('s')
  })

  it('maps provider.quota error type to APIError (not generic UnknownError)', () => {
    const p = payloadOf({
      type: 'session.execution.failed',
      data: { sessionID: 's', error: { type: 'provider.quota', message: 'Rate limit', status: 429 } },
      location: { directory: '/w' },
    })
    expect(p?.type).toBe(EventTypes.SESSION_ERROR)
    expect(p?.properties.name).toBe('APIError')
    expect((p?.properties.data as { statusCode?: number }).statusCode).toBe(429)
  })

  it('maps aborted step.failed to nothing (silent, no error bubble)', () => {
    const p = payloadOf({
      type: 'session.step.failed',
      data: { sessionID: 's', assistantMessageID: 'm', error: { type: 'aborted', message: 'Step interrupted' } },
      location: { directory: '/w' },
    })
    expect(p).toBeNull()
  })

  it('maps step.ended to MESSAGE_UPDATED carrying tokens/cost (no model/agent fields to clobber)', () => {
    const p = payloadOf({
      type: 'session.step.ended',
      data: { sessionID: 's', assistantMessageID: 'm', finish: 'stop', cost: 1.5, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 0 } } },
      location: { directory: '/w' },
    })
    expect(p?.type).toBe(EventTypes.MESSAGE_UPDATED)
    const info = p?.properties.info as { id: string; tokens: { input: number }; cost: number }
    expect(info?.id).toBe('m')
    expect(info?.tokens.input).toBe(10)
    expect(info?.cost).toBe(1.5)
    // 不得携带空 modelID/agent 等会把已建立字段清空的键
    expect('modelID' in (info as object)).toBe(false)
    expect('agent' in (info as object)).toBe(false)
  })

  it('drops unmapped events', () => {
    expect(v2EventToGlobalEvent({ type: 'session.inbox.updated', data: {}, location: { directory: '/w' } })).toBeNull()
  })

  it('maps session.compaction.failed to SESSION_COMPACTED with error message', () => {
    const p = payloadOf({
      type: 'session.compaction.failed',
      data: {
        sessionID: 's',
        reason: 'manual',
        error: { type: 'compaction.unavailable', message: 'Nothing to compact yet' },
      },
      location: { directory: '/w' },
    })
    expect(p?.type).toBe(EventTypes.SESSION_COMPACTED)
    expect(p?.properties).toMatchObject({
      sessionID: 's',
      status: 'failed',
      reason: 'manual',
      error: 'Nothing to compact yet',
    })
  })

    it('maps session.compaction.ended to SESSION_COMPACTED completed', () => {
      const p = payloadOf({
        type: 'session.compaction.ended',
        data: { sessionID: 's', reason: 'manual', text: 'summary' },
        location: { directory: '/w' },
      })
      expect(p?.type).toBe(EventTypes.SESSION_COMPACTED)
      expect(p?.properties).toMatchObject({ sessionID: 's', status: 'completed', reason: 'manual' })
    })

    it('carries the post-compaction context tokens on completion', () => {
      // v2 在压缩结束时回报这次摘要请求的 tokens —— 压缩后的真实上下文占用。
      // 丢掉它，前端只能估算，用户在压缩后看不到圆环下降。
      const p = payloadOf({
        type: 'session.compaction.ended',
        data: {
          sessionID: 's',
          reason: 'auto',
          text: 'summary',
          cost: 0.5,
          tokens: { input: 900, output: 100, reasoning: 50, cache: { read: 30, write: 20 } },
        },
        location: { directory: '/w' },
        created: 1_700_000_000_000,
      })
      expect(p?.properties).toMatchObject({
        status: 'completed',
        tokens: { input: 900, output: 100, reasoning: 50, cache: { read: 30, write: 20 } },
        cost: 0.5,
        time: 1_700_000_000_000,
      })
    })

    it('maps session.usage.updated to SESSION_USAGE_UPDATED', () => {
      const p = payloadOf({
        type: 'session.usage.updated',
        data: {
          sessionID: 's',
          cost: 2,
          tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } },
        },
        location: { directory: '/w' },
      })
      expect(p?.type).toBe(EventTypes.SESSION_USAGE_UPDATED)
      expect(p?.properties).toMatchObject({
        sessionID: 's',
        cost: 2,
        tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } },
      })
    })

    it('drops a usage event whose tokens are all zero', () => {
      // 全零不是「0 token」，是「没测到」，不能覆盖已有的累计值
      const p = payloadOf({
        type: 'session.usage.updated',
        data: { sessionID: 's', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
        location: { directory: '/w' },
      })
      expect(p).toBeNull()
    })
  })
