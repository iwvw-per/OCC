import { beforeEach, describe, expect, it } from 'vitest'
import { inputDraftStore } from './inputDraftStore'

describe('inputDraftStore', () => {
  beforeEach(() => {
    // 清空所有桶：模块级单例跨用例会串数据
    for (const id of ['a', 'b', 'c']) inputDraftStore.clear(id)
  })

  it('keeps drafts per session independently', () => {
    inputDraftStore.save('a', { text: 'hello a', attachments: [] })
    inputDraftStore.save('b', { text: 'hello b', attachments: [] })

    expect(inputDraftStore.load('a')?.text).toBe('hello a')
    expect(inputDraftStore.load('b')?.text).toBe('hello b')
  })

  it('returns undefined for a session with no draft', () => {
    expect(inputDraftStore.load('never-typed')).toBeUndefined()
  })

  it('clears the draft for a session', () => {
    inputDraftStore.save('a', { text: 'hello', attachments: [] })
    inputDraftStore.clear('a')
    expect(inputDraftStore.load('a')).toBeUndefined()
  })

  it('overwrites an existing draft with the latest snapshot', () => {
    inputDraftStore.save('a', { text: 'first', attachments: [] })
    inputDraftStore.save('a', { text: 'second', attachments: [] })
    expect(inputDraftStore.load('a')?.text).toBe('second')
  })

  /**
   * 自动更新重启前用它做闸门：有未发送内容时不能重启，否则内容一起丢。
   */
  describe('hasAnyDraft', () => {
    it('is false with no drafts at all', () => {
      expect(inputDraftStore.hasAnyDraft()).toBe(false)
    })

    it('is true when any session has text', () => {
      inputDraftStore.save('a', { text: 'draft', attachments: [] })
      expect(inputDraftStore.hasAnyDraft()).toBe(true)
    })

    it('is true when a draft only has attachments', () => {
      inputDraftStore.save('a', { text: '', attachments: [{ id: 'f1' } as never] })
      expect(inputDraftStore.hasAnyDraft()).toBe(true)
    })

    /**
     * 输入框失焦时也会 save 一个空壳。若把空草稿当作「有内容」，
     * 自动更新就永远等不到重启时机。
     */
    it('ignores empty drafts', () => {
      inputDraftStore.save('a', { text: '   ', attachments: [] })
      expect(inputDraftStore.hasAnyDraft()).toBe(false)
    })

    it('becomes false again after the draft is sent or cleared', () => {
      inputDraftStore.save('a', { text: 'draft', attachments: [] })
      inputDraftStore.clear('a')
      expect(inputDraftStore.hasAnyDraft()).toBe(false)
    })
  })
})
