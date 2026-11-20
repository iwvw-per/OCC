import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelInfo } from '../types/ui'

function model(providerId: string, id: string): ModelInfo {
  return {
    id,
    name: id,
    providerId,
    providerName: providerId,
  } as ModelInfo
}

function readHiddenKeys(): string[] {
  // 必须用 localStorage.key(i) 枚举。Object.keys(localStorage) 在 jsdom 下返回的是
  // 方法名（getItem/setItem/...）而不是存储键，用它做 find 永远命中不了，
  // 测试会稳定地拿到 []——这正是本文件此前长期失败的原因。
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (!key || !key.endsWith(':hidden-model-keys')) continue
    const raw = localStorage.getItem(key)
    if (!raw) return []
    return JSON.parse(raw) as string[]
  }
  return []
}

describe('modelVisibilityStore', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('writes the current hidden keys on every hide, not the previous snapshot', async () => {
    const { modelVisibilityStore } = await import('./modelVisibilityStore')
    const a = model('openai', 'gpt-4')
    const b = model('openai', 'gpt-4o')

    modelVisibilityStore.setVisible(a, false)
    expect(readHiddenKeys()).toEqual(['openai:gpt-4'])
    expect(modelVisibilityStore.isVisible(a)).toBe(false)

    modelVisibilityStore.setVisible(b, false)
    expect(readHiddenKeys()).toEqual(['openai:gpt-4', 'openai:gpt-4o'])
  })

  it('keeps re-enabled models visible after a full store reload', async () => {
    const { modelVisibilityStore } = await import('./modelVisibilityStore')
    const a = model('openai', 'gpt-4')
    const b = model('openai', 'gpt-4o')

    modelVisibilityStore.setManyVisible([a, b], false)
    modelVisibilityStore.setVisible(a, true)
    expect(readHiddenKeys()).toEqual(['openai:gpt-4o'])

    vi.resetModules()
    const reloaded = await import('./modelVisibilityStore')
    expect(reloaded.modelVisibilityStore.isVisible(a)).toBe(true)
    expect(reloaded.modelVisibilityStore.isVisible(b)).toBe(false)
    expect(reloaded.modelVisibilityStore.getSnapshot()).toEqual(['openai:gpt-4o'])
  })

  it('persists consecutive channel toggles through reload', async () => {
    const { modelVisibilityStore } = await import('./modelVisibilityStore')
    const models = [model('anthropic', 'claude-3'), model('anthropic', 'claude-4')]

    modelVisibilityStore.setManyVisible(models, false)
    modelVisibilityStore.setManyVisible(models, true)
    expect(readHiddenKeys()).toEqual([])

    vi.resetModules()
    const reloaded = await import('./modelVisibilityStore')
    expect(reloaded.modelVisibilityStore.isVisible(models[0])).toBe(true)
    expect(reloaded.modelVisibilityStore.isVisible(models[1])).toBe(true)
    expect(reloaded.modelVisibilityStore.getSnapshot()).toEqual([])
  })

  it('adopts the existing models on first sync without hiding any of them', async () => {
    const { modelVisibilityStore } = await import('./modelVisibilityStore')
    const a = model('openai', 'gpt-4')

    modelVisibilityStore.syncKnownModels([a])

    expect(modelVisibilityStore.isVisible(a)).toBe(true)
    expect(readHiddenKeys()).toEqual([])
  })

  it('hides models that show up later and keeps the choice across reloads', async () => {
    const { modelVisibilityStore } = await import('./modelVisibilityStore')
    const a = model('openai', 'gpt-4')
    const b = model('openai', 'gpt-5')

    modelVisibilityStore.syncKnownModels([a])
    modelVisibilityStore.syncKnownModels([a, b])

    expect(modelVisibilityStore.isVisible(a)).toBe(true)
    expect(modelVisibilityStore.isVisible(b)).toBe(false)
    expect(readHiddenKeys()).toEqual(['openai:gpt-5'])

    vi.resetModules()
    const reloaded = await import('./modelVisibilityStore')
    expect(reloaded.modelVisibilityStore.isVisible(a)).toBe(true)
    expect(reloaded.modelVisibilityStore.isVisible(b)).toBe(false)
  })

  it('adopts a fully replaced model set instead of hiding everything (endpoint renamed)', async () => {
    const { modelVisibilityStore } = await import('./modelVisibilityStore')
    const old = model('openai', 'gpt-4')
    const a = model('anthropic', 'claude-3')
    const b = model('anthropic', 'claude-4')

    modelVisibilityStore.syncKnownModels([old])
    modelVisibilityStore.syncKnownModels([a, b])

    expect(modelVisibilityStore.isVisible(a)).toBe(true)
    expect(modelVisibilityStore.isVisible(b)).toBe(true)
  })
})
