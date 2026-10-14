import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ApiMessage, ApiMessageWithParts, ApiPart } from '../api/types'
import type { Message } from '../types/message'
import { messageStore } from './messageStore'
import { useMessages } from './messageStoreHooks'
import { paneLayoutStore } from './paneLayoutStore'

function createUserMessage(id: string, sessionId: string, created: number): ApiMessage {
  return {
    id,
    sessionID: sessionId,
    role: 'user',
    time: { created },
    agent: 'build',
    model: { providerID: 'provider-1', modelID: 'model-1' },
  }
}

function createTextPart(id: string, sessionId: string, messageID: string, text: string): ApiPart {
  return { id, sessionID: sessionId, messageID, type: 'text', text }
}

function createMessageWithParts(id: string, sessionId: string, text: string, created: number): ApiMessageWithParts {
  return {
    info: createUserMessage(id, sessionId, created),
    parts: [createTextPart(`part-${id}`, sessionId, id, text)],
  }
}

function textOf(message: Message): string {
  const part = message.content[0]
  return part && part.type === 'text' ? part.text : ''
}

describe('split-pane message isolation', () => {
  beforeEach(() => {
    messageStore.clearAll()
    paneLayoutStore.reset()
  })

  it('a per-pane hook must read its own session, not the focused pane session', () => {
    const root = paneLayoutStore.getRoot()
    if (root.type !== 'leaf') throw new Error('expected single leaf pane after reset')
    const alphaPaneId = root.id

    const betaPaneId = paneLayoutStore.splitPaneToSide(alphaPaneId, 'right', 'session-beta')
    expect(betaPaneId).not.toBeNull()

    paneLayoutStore.setPaneSession(alphaPaneId, 'session-alpha')
    paneLayoutStore.focusPane(alphaPaneId)

    expect(paneLayoutStore.getFocusedSessionId()).toBe('session-alpha')

    messageStore.setMessages('session-alpha', [createMessageWithParts('msg-alpha', 'session-alpha', 'alpha', 1)])
    messageStore.setMessages('session-beta', [createMessageWithParts('msg-beta', 'session-beta', 'beta', 2)])

    const betaPaneMessages = renderHook(() => useMessages('session-beta'))

    expect(betaPaneMessages.result.current.map(textOf)).toEqual(['beta'])
  })
})
