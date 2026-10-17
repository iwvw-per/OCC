import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  collapseDotSegments,
  formatPathForApi,
  isAbsoluteDirectory,
  resetPathModeCache,
  setPathMode,
} from './directoryUtils'

describe('isAbsoluteDirectory', () => {
  it('accepts unix and windows absolute paths', () => {
    expect(isAbsoluteDirectory('/opt/code/OCC')).toBe(true)
    expect(isAbsoluteDirectory('/')).toBe(true)
    expect(isAbsoluteDirectory('E:/dev/project')).toBe(true)
    expect(isAbsoluteDirectory('E:\\dev\\project')).toBe(true)
  })

  it('rejects relative paths', () => {
    expect(isAbsoluteDirectory('../code/OCC')).toBe(false)
    expect(isAbsoluteDirectory('code/OCC')).toBe(false)
    expect(isAbsoluteDirectory('./repo')).toBe(false)
    expect(isAbsoluteDirectory('..')).toBe(false)
    expect(isAbsoluteDirectory('')).toBe(false)
    expect(isAbsoluteDirectory(undefined)).toBe(false)
  })
})

describe('collapseDotSegments', () => {
  it('resolves relative segments against an absolute root', () => {
    expect(collapseDotSegments('/opt/code/../code/OCC')).toBe('/opt/code/OCC')
    expect(collapseDotSegments('/opt/./code//OCC')).toBe('/opt/code/OCC')
    expect(collapseDotSegments('/../..')).toBe('/')
  })

  it('normalizes windows separators and keeps the drive', () => {
    expect(collapseDotSegments('E:\\dev\\..\\dev\\project')).toBe('E:/dev/project')
    expect(collapseDotSegments('C:/a/../b/')).toBe('C:/b')
  })

  it('leaves unresolved relative paths relative', () => {
    expect(collapseDotSegments('../code/OCC')).toBe('../code/OCC')
  })
})

describe('formatPathForApi', () => {
  beforeEach(() => {
    resetPathModeCache()
    setPathMode('windows')
  })

  afterEach(() => {
    setPathMode('auto')
    resetPathModeCache()
  })

  it('never turns a unix absolute path into a backslash path', () => {
    // 多服务器下风格可能判到 Windows 主机，但 /opt/... 只能原样发给 Linux 后端；
    // 转成 \opt\code\OCC 会让后端报 LocationNotFoundError。
    expect(formatPathForApi('/opt/code/OCC')).toBe('/opt/code/OCC')
  })

  it('keeps windows absolute paths intact', () => {
    expect(formatPathForApi('E:/dev/project/')).toBe('E:\\dev\\project')
  })
})
