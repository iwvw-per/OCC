import { describe, expect, it } from 'vitest'
import { AUTO_UPDATE_INTERVAL_OPTIONS, autoUpdateSettingsStore } from './autoUpdateSettings'

describe('autoUpdateSettingsStore', () => {
  it('defaults to enabled with a 30 minute interval', () => {
    const settings = autoUpdateSettingsStore.get()
    expect(settings.enabled).toBe(true)
    expect(settings.intervalMinutes).toBe(30)
  })

  it('exposes interval options that end at 12 hours', () => {
    // 上限 12h 与 updateStore 内部的检查门槛一致：再长就等于「只在启动时查」
    expect(AUTO_UPDATE_INTERVAL_OPTIONS[0]).toBe(30)
    expect(AUTO_UPDATE_INTERVAL_OPTIONS.at(-1)).toBe(720)
  })

  it('commits a new interval', () => {
    autoUpdateSettingsStore.commit(prev => ({ ...prev, intervalMinutes: 180 }))
    expect(autoUpdateSettingsStore.get().intervalMinutes).toBe(180)
    // 复原，避免影响同文件的其它用例
    autoUpdateSettingsStore.commit(prev => ({ ...prev, intervalMinutes: 30 }))
  })

  it('rejects an interval outside the allowed set', () => {
    const before = autoUpdateSettingsStore.get()
    // schema 校验失败时 commit 会保留原值（见 createStore 的实现）
    autoUpdateSettingsStore.commit(prev => ({ ...prev, intervalMinutes: 7 as never }))
    expect(autoUpdateSettingsStore.get()).toEqual(before)
  })

  it('persists under a global (non per-server) key', () => {
    // 更新的是客户端本体，不属于某台服务器；per-server 会让换服务器后设置丢失
    expect(autoUpdateSettingsStore.getStorageKey()).toBe('opencode-auto-update-settings')
  })
})
