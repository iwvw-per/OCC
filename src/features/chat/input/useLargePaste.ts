// ============================================
// useLargePaste — 大段文本粘贴的分流策略
//
// 从 InputBox.tsx 抽出。粘贴超过阈值的文本时按用户偏好处理：
//   attach  → 作为 .txt 附件
//   inline  → 直接插入正文
//   ask     → 弹窗询问（交由调用方渲染）
// 阈值按字符数或行数任一命中判定。
// ============================================

import { useCallback } from 'react'

/** 超过此字符数视为大段粘贴 */
export const LARGE_PASTE_CHAR_THRESHOLD = 2000
/** 超过此行数视为大段粘贴（紧凑代码/日志常见） */
export const LARGE_PASTE_LINE_THRESHOLD = 25

export type LargePasteBehavior = 'ask' | 'attach' | 'inline'

export interface UseLargePasteOptions {
  behavior: LargePasteBehavior
  /** 把整段文本转为附件 */
  attach: (text: string) => void | Promise<void>
  /** 直接插入正文 */
  insertInline: (text: string) => void
  /** 询问用户（仅 behavior === 'ask'） */
  ask: (text: string) => void
}

export interface UseLargePasteResult {
  isLargePaste: (text: string) => boolean
  /** 处理一次可能的大段粘贴；返回 true 表示已接管（调用方应 preventDefault）。 */
  handlePastedText: (value: string) => boolean
}

export function isLargePasteText(value: string): boolean {
  if (value.length >= LARGE_PASTE_CHAR_THRESHOLD) return true
  let lines = 1
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 10 && ++lines >= LARGE_PASTE_LINE_THRESHOLD) return true
  }
  return false
}

export function useLargePaste({ behavior, attach, insertInline, ask }: UseLargePasteOptions): UseLargePasteResult {
  const isLargePaste = useCallback((value: string) => isLargePasteText(value), [])

  const handlePastedText = useCallback(
    (value: string): boolean => {
      if (!isLargePasteText(value)) return false
      if (behavior === 'attach') void attach(value)
      else if (behavior === 'inline') insertInline(value)
      else ask(value)
      return true
    },
    [ask, attach, behavior, insertInline, isLargePaste],
  )

  return { isLargePaste, handlePastedText }
}
