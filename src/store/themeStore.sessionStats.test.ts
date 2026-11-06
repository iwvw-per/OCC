import { beforeEach, describe, expect, it } from 'vitest'
import { themeStore, DEFAULT_SESSION_STATS_FIELDS_DESKTOP, DEFAULT_SESSION_STATS_FIELDS_MOBILE } from './themeStore'

describe('themeStore sessionStatsFields', () => {
  beforeEach(() => {
    localStorage.clear()
    themeStore.setSessionStatsFieldsDesktop(DEFAULT_SESSION_STATS_FIELDS_DESKTOP)
    themeStore.setSessionStatsFieldsMobile(DEFAULT_SESSION_STATS_FIELDS_MOBILE)
  })

  it('updates desktop fields independently from mobile fields', () => {
    themeStore.setSessionStatsFieldsDesktop({ modelTime: true, ttft: true })
    themeStore.setSessionStatsFieldsMobile({ cacheHit: true, tps: false })

    expect(themeStore.sessionStatsFieldsDesktop).toEqual({
      modelTime: true,
      toolTime: false,
      ttft: true,
      tps: true,
      cacheHit: false,
      outputTokens: false,
    })

    expect(themeStore.sessionStatsFieldsMobile).toEqual({
      modelTime: false,
      toolTime: false,
      ttft: false,
      tps: false,
      cacheHit: true,
      outputTokens: false,
    })
  })

  it('persists desktop and mobile settings into localStorage separately', () => {
    themeStore.setSessionStatsFieldsDesktop({ outputTokens: true })
    themeStore.setSessionStatsFieldsMobile({ toolTime: true })

    const desktopRaw = localStorage.getItem('session-stats-fields-desktop')
    const mobileRaw = localStorage.getItem('session-stats-fields-mobile')

    expect(JSON.parse(desktopRaw!)).toMatchObject({ outputTokens: true, tps: true })
    expect(JSON.parse(mobileRaw!)).toMatchObject({ toolTime: true, tps: true })
  })
})
