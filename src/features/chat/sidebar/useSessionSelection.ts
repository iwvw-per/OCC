// ============================================
// useSessionSelection — 侧栏编辑模式的多选状态
//
// 支持单击切换 + Shift 连选（按当前可见顺序取区间）。会话与项目各有一份
// 独立的选中集合与锚点，避免两种列表的 Shift 扩选互相干扰。
// ============================================

import { useCallback, useRef, useState, type RefObject } from 'react'

type SelectionKind = 'session' | 'project'

export interface UseSessionSelectionResult {
  isEditMode: boolean
  selectedSessionIds: Set<string>
  selectedProjectIds: Set<string>
  /** 列表容器：按 [data-selection-kind] 读取当前可见项顺序 */
  rootRef: RefObject<HTMLDivElement | null>
  enterEditMode: () => void
  exitEditMode: () => void
  toggleSessionSelection: (sessionId: string, options?: { shiftKey?: boolean }) => void
  toggleProjectSelection: (projectId: string, options?: { shiftKey?: boolean }) => void
  clearSessionSelection: () => void
  clearProjectSelection: () => void
}

export function getSelectionRange(visibleIds: string[], anchorId: string, targetId: string): string[] | null {
  const startIndex = visibleIds.indexOf(anchorId)
  const endIndex = visibleIds.indexOf(targetId)
  if (startIndex === -1 || endIndex === -1) return null
  return visibleIds.slice(Math.min(startIndex, endIndex), Math.max(startIndex, endIndex) + 1)
}

export function useSessionSelection(): UseSessionSelectionResult {
  const [isEditMode, setIsEditMode] = useState(false)
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set())
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set())
  const sessionAnchorRef = useRef<string | null>(null)
  const projectAnchorRef = useRef<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const getVisibleSelectionIds = useCallback((kind: SelectionKind) => {
    const root = rootRef.current
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>(`[data-selection-kind="${kind}"]`))
      .filter(element => element.getClientRects().length > 0)
      .map(element => element.dataset.selectionId)
      .filter((id): id is string => Boolean(id))
  }, [])

  const toggle = useCallback(
    (
      id: string,
      kind: SelectionKind,
      set: (updater: (prev: Set<string>) => Set<string>) => void,
      anchorRef: RefObject<string | null>,
      shiftKey?: boolean,
    ) => {
      const anchorId = anchorRef.current
      const visibleIds = getVisibleSelectionIds(kind)

      set(prev => {
        if (shiftKey && anchorId) {
          const range = getSelectionRange(visibleIds, anchorId, id)
          if (range) {
            const next = new Set(prev)
            // 目标已选中 → 整段取消；未选中 → 整段选中
            const shouldSelect = !prev.has(id)
            for (const item of range) {
              if (shouldSelect) next.add(item)
              else next.delete(item)
            }
            return next
          }
        }
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })

      // Shift 范围操作后仍保留锚点，方便连续扩选/缩选
      if (!(shiftKey && anchorId)) anchorRef.current = id
    },
    [getVisibleSelectionIds],
  )

  const toggleSessionSelection = useCallback(
    (sessionId: string, options?: { shiftKey?: boolean }) => {
      toggle(sessionId, 'session', setSelectedSessionIds, sessionAnchorRef, options?.shiftKey)
    },
    [toggle],
  )

  const toggleProjectSelection = useCallback(
    (projectId: string, options?: { shiftKey?: boolean }) => {
      toggle(projectId, 'project', setSelectedProjectIds, projectAnchorRef, options?.shiftKey)
    },
    [toggle],
  )

  const exitEditMode = useCallback(() => {
    setIsEditMode(false)
    setSelectedSessionIds(new Set())
    setSelectedProjectIds(new Set())
    sessionAnchorRef.current = null
    projectAnchorRef.current = null
  }, [])

  const enterEditMode = useCallback(() => {
    setIsEditMode(true)
    sessionAnchorRef.current = null
    projectAnchorRef.current = null
  }, [])

  const clearSessionSelection = useCallback(() => {
    setSelectedSessionIds(new Set())
    sessionAnchorRef.current = null
  }, [])

  const clearProjectSelection = useCallback(() => {
    setSelectedProjectIds(new Set())
    projectAnchorRef.current = null
  }, [])

  return {
    isEditMode,
    selectedSessionIds,
    selectedProjectIds,
    rootRef,
    enterEditMode,
    exitEditMode,
    toggleSessionSelection,
    toggleProjectSelection,
    clearSessionSelection,
    clearProjectSelection,
  }
}
