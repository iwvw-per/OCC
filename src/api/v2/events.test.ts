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
      data: { session: { id: 'ses_1', title: 't' } },
      location: { directory: '/w' },
    })
    expect(p?.type).toBe(EventTypes.SESSION_CREATED)
    expect((p?.properties.info as { id: string }).id).toBe('ses_1')
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

  it('maps permission.asked', () => {
    const p = payloadOf({ type: 'permission.asked', data: { request: { id: 'p1' } }, location: { directory: '/w' } })
    expect(p?.type).toBe(EventTypes.PERMISSION_ASKED)
  })

  it('maps form.created to QUESTION_ASKED', () => {
    const p = payloadOf({ type: 'form.created', data: { form: { id: 'f1' } }, location: { directory: '/w' } })
    expect(p?.type).toBe(EventTypes.QUESTION_ASKED)
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
    expect(v2EventToGlobalEvent({ type: 'session.usage.updated', data: {}, location: { directory: '/w' } })).toBeNull()
  })
})
