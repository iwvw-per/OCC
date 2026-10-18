// ============================================
// Diff 行计算（纯函数，无 React 依赖）
//
// 从 DiffViewer.tsx 抽出：逐行配对 + 字级 diff。输入是文件全文，输出是渲染行，
// 可独立测试，也可放进 worker / idle 回调里跑。
// ============================================

import { diffLines, diffWordsWithSpace, type Change as WordDiffChange } from 'diff'

export type LineType = 'add' | 'delete' | 'context' | 'empty'

export interface DiffLine {
  type: LineType
  content: string
  lineNo?: number
  /** 词级别 diff 标记（结构化），与 syntax token 共存 */
  wordDiffSegments?: WordDiffSegment[]
}

/** 词级别 diff 的单个片段 */
export interface WordDiffSegment {
  text: string
  /** 'add' | 'delete' 表示增删标记，undefined 表示无变化 */
  diffType?: 'add' | 'delete'
}

export interface PairedLine {
  left: DiffLine
  right: DiffLine
}

export interface UnifiedLine extends DiffLine {
  oldLineNo?: number
  newLineNo?: number
}

export function computePairedLines(before: string, after: string, skipWordDiff: boolean): PairedLine[] {
  const changes = diffLines(before, after)
  const result: PairedLine[] = []
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')

  let oldIdx = 0,
    newIdx = 0,
    i = 0

  while (i < changes.length) {
    const change = changes[i]
    const count = change.count || 0

    if (change.removed) {
      const next = changes[i + 1]
      if (next?.added) {
        const addCount = next.count || 0
        const maxCount = Math.max(count, addCount)

        for (let j = 0; j < maxCount; j++) {
          const oldLine = j < count ? beforeLines[oldIdx + j] : undefined
          const newLine = j < addCount ? afterLines[newIdx + j] : undefined

          let leftSegments: WordDiffSegment[] | undefined
          let rightSegments: WordDiffSegment[] | undefined

          if (!skipWordDiff && oldLine !== undefined && newLine !== undefined) {
            const wordDiff = computeWordDiff(oldLine, newLine)
            if (!isTooFragmented(wordDiff.changes)) {
              leftSegments = wordDiff.left
              rightSegments = wordDiff.right
            }
          }

          result.push({
            left:
              oldLine !== undefined
                ? { type: 'delete', content: oldLine, lineNo: oldIdx + j + 1, wordDiffSegments: leftSegments }
                : { type: 'empty', content: '' },
            right:
              newLine !== undefined
                ? { type: 'add', content: newLine, lineNo: newIdx + j + 1, wordDiffSegments: rightSegments }
                : { type: 'empty', content: '' },
          })
        }

        oldIdx += count
        newIdx += addCount
        i += 2
        continue
      }

      for (let j = 0; j < count; j++) {
        result.push({
          left: { type: 'delete', content: beforeLines[oldIdx + j] || '', lineNo: oldIdx + j + 1 },
          right: { type: 'empty', content: '' },
        })
      }
      oldIdx += count
    } else if (change.added) {
      for (let j = 0; j < count; j++) {
        result.push({
          left: { type: 'empty', content: '' },
          right: { type: 'add', content: afterLines[newIdx + j] || '', lineNo: newIdx + j + 1 },
        })
      }
      newIdx += count
    } else {
      for (let j = 0; j < count; j++) {
        result.push({
          left: { type: 'context', content: beforeLines[oldIdx + j] || '', lineNo: oldIdx + j + 1 },
          right: { type: 'context', content: afterLines[newIdx + j] || '', lineNo: newIdx + j + 1 },
        })
      }
      oldIdx += count
      newIdx += count
    }
    i++
  }

  return result
}

export function computeUnifiedLines(before: string, after: string): UnifiedLine[] {
  const changes = diffLines(before, after)
  const result: UnifiedLine[] = []
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')

  let oldIdx = 0,
    newIdx = 0

  for (const change of changes) {
    const count = change.count || 0

    if (change.removed) {
      for (let j = 0; j < count; j++) {
        result.push({ type: 'delete', content: beforeLines[oldIdx + j] || '', oldLineNo: oldIdx + j + 1 })
      }
      oldIdx += count
    } else if (change.added) {
      for (let j = 0; j < count; j++) {
        result.push({ type: 'add', content: afterLines[newIdx + j] || '', newLineNo: newIdx + j + 1 })
      }
      newIdx += count
    } else {
      for (let j = 0; j < count; j++) {
        result.push({
          type: 'context',
          content: afterLines[newIdx + j] || '',
          oldLineNo: oldIdx + j + 1,
          newLineNo: newIdx + j + 1,
        })
      }
      oldIdx += count
      newIdx += count
    }
  }

  return result
}

export function isTooFragmented(changes: WordDiffChange[]): boolean {
  let commonLength = 0,
    totalLength = 0
  for (const change of changes) {
    totalLength += change.value.length
    if (!change.added && !change.removed) commonLength += change.value.length
  }
  return totalLength > 10 && commonLength / totalLength < 0.4
}

export function computeWordDiff(
  oldLine: string,
  newLine: string,
): { left: WordDiffSegment[]; right: WordDiffSegment[]; changes: WordDiffChange[] } {
  const changes = diffWordsWithSpace(oldLine, newLine)

  const mergedChanges: WordDiffChange[] = []
  for (let i = 0; i < changes.length; i++) {
    const current = changes[i]
    const prev = mergedChanges[mergedChanges.length - 1]

    if (prev && !current.added && !current.removed && /^\s*$/.test(current.value)) {
      const next = changes[i + 1]
      if ((prev.removed && next?.removed) || (prev.added && next?.added)) {
        prev.value += current.value
        continue
      }
    }

    if (prev && ((prev.added && current.added) || (prev.removed && current.removed))) {
      prev.value += current.value
    } else {
      mergedChanges.push({ ...current })
    }
  }

  const left: WordDiffSegment[] = []
  const right: WordDiffSegment[] = []
  for (const change of mergedChanges) {
    if (change.removed) left.push({ text: change.value, diffType: 'delete' })
    else if (change.added) right.push({ text: change.value, diffType: 'add' })
    else {
      left.push({ text: change.value })
      right.push({ text: change.value })
    }
  }

  return { left, right, changes: mergedChanges }
}

/** 逐行 diff 的规模统计（用于决定是否走同步计算）。 */
export function diffSize(before: string, after: string): number {
  return before.length + after.length
}

/** 超过该规模时，diff 计算推迟到浏览器空闲帧，避免与用户输入/滚动抢主线程。 */
export const LARGE_DIFF_THRESHOLD = 60_000

/**
 * 在下一个空闲帧后执行（不支持时退回 setTimeout）。
 *
 * 用于把大文件的行计算让出首帧：组件先以「高亮未就绪」的占位渲染，
 * 空闲时再算 diff，用户先看到内容而不是卡住。
 */
export function scheduleIdle(task: () => void, timeoutMs = 120): () => void {
  const idleWindow = globalThis as typeof globalThis & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
    cancelIdleCallback?: (id: number) => void
  }
  if (typeof idleWindow.requestIdleCallback === 'function') {
    const id = idleWindow.requestIdleCallback(task, { timeout: timeoutMs })
    return () => idleWindow.cancelIdleCallback?.(id)
  }
  const id = setTimeout(task, 0)
  return () => clearTimeout(id)
}
