// ============================================
// useSlashTrigger — 输入框 / 斜杠命令的触发态与选中逻辑
//
// 从 InputBox.tsx 抽出。与 mention 同构：维护「是否打开 + 查询词 + 触发位」，
// 选中时替换整段 `/query` 并落一个 command 附件（输入框据此渲染命令胶囊）。
// ============================================

import { useCallback, useState, type MutableRefObject } from 'react'
import type { Attachment } from '../../attachment'
import type { Command } from '../../../api/command'

export interface UseSlashTriggerOptions {
  text: string
  setText: (value: string) => void
  setAttachments: (updater: (prev: Attachment[]) => Attachment[]) => void
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>
  /** 前端命令（如 /new）：不走消息流，直接执行 */
  onCommand?: (command: string) => Promise<boolean> | boolean
  submitCommandOptimistically: (command: string) => void
}

export interface UseSlashTriggerResult {
  open: boolean
  query: string
  startIndex: number
  setOpen: (open: boolean) => void
  updateQuery: (nextQuery: string, nextStartIndex?: number) => void
  select: (command: Command) => void
  close: () => void
}

export function useSlashTrigger({
  text,
  setText,
  setAttachments,
  textareaRef,
  onCommand,
  submitCommandOptimistically,
}: UseSlashTriggerOptions): UseSlashTriggerResult {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [startIndex, setStartIndex] = useState(-1)

  const updateQuery = useCallback((nextQuery: string, nextStartIndex?: number) => {
    setQuery(nextQuery)
    if (nextStartIndex !== undefined) setStartIndex(nextStartIndex)
  }, [])

  const select = useCallback(
    (command: Command) => {
      // 前端命令：不插入文本，直接执行
      if (command.source === 'frontend') {
        if (!onCommand) return
        setOpen(false)
        submitCommandOptimistically(`/${command.name}`)
        requestAnimationFrame(() => textareaRef.current?.focus())
        return
      }

      if (startIndex < 0) return

      const commandText = `/${command.name}`
      const beforeSlash = text.slice(0, startIndex)
      const afterQuery = text.slice(startIndex + 1 + query.length)
      const newText = `${beforeSlash}${commandText} ${afterQuery}`

      const attachment: Attachment = {
        id: crypto.randomUUID(),
        type: 'command',
        displayName: command.name,
        commandName: command.name,
        textRange: {
          value: commandText,
          start: startIndex,
          end: startIndex + commandText.length,
        },
      }

      setText(newText)
      setAttachments(prev => [...prev, attachment])
      setOpen(false)

      // 光标移到命令后
      requestAnimationFrame(() => {
        const node = textareaRef.current
        if (!node) return
        const cursor = startIndex + commandText.length + 1
        node.setSelectionRange(cursor, cursor)
        node.focus()
      })
    },
    [onCommand, query.length, setAttachments, setText, startIndex, submitCommandOptimistically, text, textareaRef],
  )

  const close = useCallback(() => {
    setOpen(false)
    textareaRef.current?.focus()
  }, [textareaRef])

  return { open, query, startIndex, setOpen, updateQuery, select, close }
}
