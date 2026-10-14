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

  it('drops unmapped events', () => {
    expect(v2EventToGlobalEvent({ type: 'session.usage.updated', data: {}, location: { directory: '/w' } })).toBeNull()
  })
})
