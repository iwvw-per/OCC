/**
 * Android 一键更新：APK 选择逻辑。
 *
 * release 同时提供 arm64 与 armv7 两个包，装错架构的包要么装不上，
 * 要么在 32 位设备上跑不起来，所以「选哪个 URL」必须可测。
 */
import { describe, expect, it } from 'vitest'
import { pickApkUrl } from './androidUpdater'
import type { UpdateRelease } from '../store/updateStore'

function release(tagName: string, prerelease = false): UpdateRelease {
  return {
    version: tagName.replace(/^v/, ''),
    tagName,
    url: `https://github.com/iwvw-per/OCC/releases/tag/${tagName}`,
    publishedAt: null,
    name: tagName,
    prerelease,
  }
}

describe('pickApkUrl', () => {
  it('builds the arm64 asset url for a stable release', () => {
    expect(pickApkUrl(release('v2.0.22'), 'arm64')).toBe(
      'https://github.com/iwvw-per/OCC/releases/download/v2.0.22/OCC-v2.0.22-android-arm64.apk',
    )
  })

  it('builds the armv7 asset url for 32-bit devices', () => {
    expect(pickApkUrl(release('v2.0.22'), 'armv7')).toBe(
      'https://github.com/iwvw-per/OCC/releases/download/v2.0.22/OCC-v2.0.22-android-armv7.apk',
    )
  })

  it('works for canary tags (同一个命名规则)', () => {
    expect(pickApkUrl(release('v2.0.22-canary.3', true), 'arm64')).toBe(
      'https://github.com/iwvw-per/OCC/releases/download/v2.0.22-canary.3/OCC-v2.0.22-canary.3-android-arm64.apk',
    )
  })

  it('returns null when the release has no tag', () => {
    expect(pickApkUrl({ ...release('v2.0.22'), tagName: '' }, 'arm64')).toBeNull()
  })
})
