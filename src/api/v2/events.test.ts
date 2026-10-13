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

  it('maps text.delta to MESSAGE_PART_DELTA', () => {
    const p = payloadOf({
      type: 'session.text.delta',
      data: { sessionID: 's', messageID: 'm', partID: 'p', delta: 'hi' },
      location: { directory: '/w' },
    })
    expect(p?.type).toBe(EventTypes.MESSAGE_PART_DELTA)
    expect(p?.properties).toMatchObject({ sessionID: 's', messageID: 'm', partID: 'p', field: 'text', delta: 'hi' })
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
    expect(v2EventToGlobalEvent({ type: 'session.step.started', data: {}, location: { directory: '/w' } })).toBeNull()
  })
})
