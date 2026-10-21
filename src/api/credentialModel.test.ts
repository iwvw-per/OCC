import { describe, expect, it } from 'vitest'
import { CURRENT_CREDENTIAL_MODEL, HOST_CREDENTIAL_MODEL, supportsHostCredentialInjection } from './credentialModel'

describe('credential model', () => {
  it('describes the shipped model as renderer-held', () => {
    expect(CURRENT_CREDENTIAL_MODEL).toEqual({ holder: 'renderer', keepsRequestsSimple: false })
  })

  it('describes the target model as host-held and preflight-free', () => {
    expect(HOST_CREDENTIAL_MODEL).toEqual({ holder: 'host', keepsRequestsSimple: true })
  })

  it('reports host injection as unavailable until the migration lands', () => {
    // 未迁移前必须保守返回 false：调用方若提前按「无凭据」处理会直接 401
    expect(supportsHostCredentialInjection('tauri')).toBe(false)
    expect(supportsHostCredentialInjection('web')).toBe(false)
  })
})
