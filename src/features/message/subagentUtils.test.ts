import { describe, expect, it } from 'vitest'
import {
  isSubagentToolName,
  parseSubagentSessionId,
  isBackgroundSubagentOutput,
  getSubagentSessionId,
} from './subagentUtils'
import type { ToolPart } from '../../types/message'

describe('isSubagentToolName', () => {
  it('recognizes the v1 task tool and the v2 subagent tool', () => {
    expect(isSubagentToolName('task')).toBe(true)
    expect(isSubagentToolName('subagent')).toBe(true)
    expect(isSubagentToolName('Subagent')).toBe(true)
    expect(isSubagentToolName('bash')).toBe(false)
    expect(isSubagentToolName(undefined)).toBe(false)
  })
})

describe('parseSubagentSessionId', () => {
  it('parses the structured <subagent sessionID="..."> form', () => {
    const output = '<subagent sessionID="ses_abc123" state="completed"> body </subagent>'
    expect(parseSubagentSessionId(output)).toBe('ses_abc123')
  })

  it('parses the v2 background receipt text form', () => {
    const output =
      'The subagent is working in the background (sessionID: ses_ebc7deed9ffe0zajbrUkgKNH49). You will be notified.'
    expect(parseSubagentSessionId(output)).toBe('ses_ebc7deed9ffe0zajbrUkgKNH49')
  })

  it('returns undefined when no session id is present', () => {
    expect(parseSubagentSessionId('plain result')).toBeUndefined()
    expect(parseSubagentSessionId(undefined)).toBeUndefined()
    expect(parseSubagentSessionId(42)).toBeUndefined()
  })

  it('does not match a bare sessionID from unrelated text', () => {
    // 非「后台子代理回执」的普通输出里出现 sessionID: 不应被当成子会话 id
    expect(parseSubagentSessionId('config: sessionID: ses_should_not_match')).toBeUndefined()
  })
})

describe('isBackgroundSubagentOutput', () => {
  it('detects the v2 background receipt marker', () => {
    expect(isBackgroundSubagentOutput('The subagent is working in the background (sessionID: ses_x).')).toBe(true)
    expect(isBackgroundSubagentOutput('final result text')).toBe(false)
    expect(isBackgroundSubagentOutput(undefined)).toBe(false)
  })
})

function createSubagentPart(output: string, metadata?: Record<string, unknown>): ToolPart {
  return {
    id: 'tool-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'subagent',
    state: { status: 'completed', output, metadata, time: { start: 1, end: 2 } },
  }
}

describe('getSubagentSessionId', () => {
  it('prefers metadata.sessionId over the output', () => {
    const part = createSubagentPart('The subagent is working in the background (sessionID: ses_from_output).', {
      sessionId: 'ses_from_metadata',
    })
    expect(getSubagentSessionId(part)).toBe('ses_from_metadata')
  })

  it('falls back to parsing the background receipt from the output', () => {
    const part = createSubagentPart('The subagent is working in the background (sessionID: ses_bg123).')
    expect(getSubagentSessionId(part)).toBe('ses_bg123')
  })

  it('returns undefined for non-subagent tools', () => {
    const part = createSubagentPart('The subagent is working in the background (sessionID: ses_bg123).')
    part.tool = 'bash'
    expect(getSubagentSessionId(part)).toBeUndefined()
  })
})
