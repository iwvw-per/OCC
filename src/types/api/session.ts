import type {
  Session as SDKSession,
  SessionListData as SDKSessionListData,
  SessionStatus as SDKSessionStatus,
} from '@opencode-ai/sdk/v2/client'

export type SessionStatus = SDKSessionStatus

export type SessionStatusMap = Record<string, SessionStatus>



export type SessionRevert = NonNullable<SDKSession['revert']>

export type Session = SDKSession

export type SessionListParams = NonNullable<SDKSessionListData['query']>



