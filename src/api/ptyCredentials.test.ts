import { describe, expect, it } from 'vitest'
import { hasLongLivedCredentials } from './ptyCredentials'

describe('hasLongLivedCredentials', () => {
  it('detects the legacy auth_token parameter', () => {
    expect(hasLongLivedCredentials('wss://host/api/pty/p/connect?auth_token=dTpw')).toBe(true)
  })

  it('detects userinfo in the URL', () => {
    expect(hasLongLivedCredentials('wss://user:pass@host/api/pty/p/connect')).toBe(true)
  })

  it('accepts a short-lived stream token', () => {
    expect(hasLongLivedCredentials('wss://host/api/pty/p/connect?st=grant-1')).toBe(false)
  })

  it('treats malformed URLs as credential-free', () => {
    expect(hasLongLivedCredentials('not a url')).toBe(false)
  })
})
