import { describe, expect, it } from 'vitest'
import { isAbsoluteDirectory } from '../utils'

// 与 useRouter.parseHash 相同的判定：相对 dir 一律不进入路由，避免污染项目列表
function resolveDirParam(value: string): string | undefined {
  const decoded = decodeURIComponent(value).replace(/\\/g, '/').replace(/\/+$/, '')
  return isAbsoluteDirectory(decoded) ? decoded : undefined
}

describe('router dir parameter', () => {
  it('ignores a relative dir instead of forwarding it to the backend', () => {
    expect(resolveDirParam('../code/OCC')).toBeUndefined()
  })

  it('keeps an absolute unix dir', () => {
    expect(resolveDirParam('%2Fopt%2Fcode%2FOCC')).toBe('/opt/code/OCC')
  })

  it('keeps an absolute windows dir', () => {
    expect(resolveDirParam('E%3A%2Fdev%2Fproject')).toBe('E:/dev/project')
  })
})
