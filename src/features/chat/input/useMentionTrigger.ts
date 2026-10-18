// ============================================
// useMentionTrigger — 输入框 @ 提及的触发态与插入逻辑
//
// 从 InputBox.tsx 抽出。所有状态都围绕「文本 + 光标位置」派生，
// 插入操作只改文本并复位光标，不碰其它输入框状态。
// ============================================

import { useCallback, useState, type MutableRefObject } from 'react'
import { type MentionItem } from '../../mention'

export interface MentionTriggerState {
  open: boolean
  query: string
  /** 触发符 `@` 在文本中的下标，-1 表示未触发 */
  startIndex: number
}

export interface UseMentionTriggerOptions {
  text: string
  setText: (value: string) => void
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>
}

export interface UseMentionTriggerResult extends MentionTriggerState {
  setOpen: (open: boolean) => void
  /** 菜单里切换目录 / 改写查询词 */
  updateQuery: (nextQuery: string, startIndex?: number) => void
  /** 选中一个提及项（文件/目录/代理），返回插入后的完整文本 */
  selectItem: (item: MentionItem & { _enterFolder?: boolean }) => string | null
  /** 关闭菜单并把焦点还给输入框 */
  close: () => void
}

export function useMentionTrigger({ text, setText, textareaRef }: UseMentionTriggerOptions): UseMentionTriggerResult {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [startIndex, setStartIndex] = useState(-1)

  const updateQuery = useCallback(
    (nextQuery: string, nextStartIndex?: number) => {
      // 显式传入的触发位优先：它同时代表「本次判定为在 @ 语境里」
      const start = nextStartIndex ?? startIndex
      if (start < 0) {
        setQuery(nextQuery)
        return
      }
      if (nextStartIndex !== undefined) setStartIndex(nextStartIndex)
      const beforeAt = text.slice(0, start)
      const afterQuery = text.slice(start + 1 + query.length)
      setText(`${beforeAt}@${nextQuery}${afterQuery}`)
      setQuery(nextQuery)
      // 光标移到查询词末尾
      requestAnimationFrame(() => {
        const node = textareaRef.current
        if (!node) return
        const pos = start + 1 + nextQuery.length
        node.setSelectionRange(pos, pos)
        node.focus()
      })
    },
    [query.length, startIndex, text, setText, textareaRef],
  )

  const selectItem = useCallback(
    (item: MentionItem & { _enterFolder?: boolean }) => {
      if (startIndex < 0) return null

      // 进入文件夹：把查询词换成目录前缀（带尾部斜杠），菜单继续展开
      if (item._enterFolder && item.type === 'folder') {
        const basePath = (item.relativePath || item.displayName).replace(/\/+$/, '')
        updateQuery(`${basePath}/`)
        return null
      }

      const mentionText = item.type === 'agent' ? `@${item.displayName}` : `@${item.relativePath || item.displayName}`
      const beforeAt = text.slice(0, startIndex)
      const afterQuery = text.slice(startIndex + 1 + query.length)
      const newText = `${beforeAt}${mentionText} ${afterQuery}`
      const cursor = beforeAt.length + mentionText.length + 1

      setText(newText)
      setOpen(false)
      requestAnimationFrame(() => {
        const node = textareaRef.current
        if (!node) return
        node.setSelectionRange(cursor, cursor)
        node.focus()
      })
      return newText
    },
    [query.length, open, setText, startIndex, text, textareaRef, updateQuery],
  )

  const close = useCallback(() => {
    setOpen(false)
    textareaRef.current?.focus()
  }, [textareaRef])

  return { open, query, startIndex, setOpen, updateQuery, selectItem, close }
}
