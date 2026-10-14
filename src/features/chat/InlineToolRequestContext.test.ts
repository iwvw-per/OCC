import { describe, expect, it, vi } from 'vitest'

vi.mock('../../store', () => ({
  childSessionStore: {
    isChildOf: () => false,
  },
}))

import { findUnmatchedQuestions } from './InlineToolRequestContext'
import type { ApiQuestionRequest } from '../../api'

function question(id: string, callID?: string, sessionID = 'session-1'): ApiQuestionRequest {
  return {
    id,
    sessionID,
    questions: [{ question: 'Q', header: 'H', options: [{ label: 'A', description: '' }] }],
    tool: callID ? { messageID: 'm-1', callID } : undefined,
  } as ApiQuestionRequest
}

function toolPart(callID: string, tool = 'question'): { type: string; callID: string; tool: string; state: object } {
  return { type: 'tool', callID, tool, state: {} }
}

describe('findUnmatchedQuestions', () => {
  it('returns nothing when every pending question matches a rendered tool part', () => {
    const pending = [question('q-1', 'call-1')]
    const messages = [{ content: [toolPart('call-1')] }]
    expect(findUnmatchedQuestions(pending, messages)).toEqual([])
  })

  it('returns questions whose callID is not rendered', () => {
    const pending = [question('q-1', 'call-1'), question('q-2', 'call-2')]
    const messages = [{ content: [toolPart('call-1')] }]
    expect(findUnmatchedQuestions(pending, messages).map(q => q.id)).toEqual(['q-2'])
  })

  it('returns all questions when no tool parts are rendered', () => {
    const pending = [question('q-1', 'call-1')]
    expect(findUnmatchedQuestions(pending, [{ content: [] }]).map(q => q.id)).toEqual(['q-1'])
  })

  it('ignores non-tool parts', () => {
    const pending = [question('q-1', 'call-1')]
    const messages = [{ content: [{ type: 'text' }, { type: 'reasoning' }] }]
    expect(findUnmatchedQuestions(pending, messages).map(q => q.id)).toEqual(['q-1'])
  })

  it('returns an empty list for no pending questions', () => {
    expect(findUnmatchedQuestions([], [{ content: [toolPart('call-1')] }])).toEqual([])
  })
})
