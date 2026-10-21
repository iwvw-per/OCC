import { memo, type ReactNode } from 'react'
import { PermissionListIcon, QuestionIcon } from '../../../components/Icons'
import { UndoStatus } from './UndoStatus'
import { usePresence } from '../../../hooks'
import type { CollapsedDialogInfo } from '../InputBox'

// ============================================
// PresenceItem — 通用的入场/退场动画包装器
// ============================================

export function PresenceItem({ show, children }: { show: boolean; children: ReactNode }) {
  const { shouldRender, ref } = usePresence<HTMLDivElement>(show, {
    from: { opacity: 0 },
    to: { opacity: 1 },
    duration: 0.15,
  })
  if (!shouldRender) return null
  return (
    <div ref={ref} className="shrink-0 pointer-events-auto">
      {children}
    </div>
  )
}

// ============================================
// FloatingActions — 输入框上方的浮动操作栏
// permission capsule / question capsule / undo status
// （滚动到底部已迁到右下角的 ChatFab，见 InputBox）
// ============================================

interface FloatingActionsProps {
  canRedo?: boolean
  revertSteps?: number
  onRedo?: () => void
  onRedoAll?: () => void
  collapsedPermission?: CollapsedDialogInfo
  collapsedQuestion?: CollapsedDialogInfo
  /**
   * 会话里堆积的「重型内联内容」提示。
   *
   * 用于解释一个反直觉的故障：用户只发「继续」两个字却收到 413。
   * 真实原因是 agent 读了若干张截图，base64 一直留在服务端上下文里，
   * 转发给模型时超过上游上限。前端无法减小它，但必须提前说明，
   * 否则用户完全无法理解这个错误。
   */
  heavyContent?: { label: string; title?: string }
}

export const FloatingActions = memo(function FloatingActions({
  canRedo,
  revertSteps,
  onRedo,
  onRedoAll,
  collapsedPermission,
  collapsedQuestion,
  heavyContent,
}: FloatingActionsProps) {
  return (
    <div className="flex items-center justify-center gap-2 pointer-events-none">
      {/* Collapsed Permission Capsule */}
      <PresenceItem show={!!collapsedPermission}>
        {collapsedPermission && (
          <button
            type="button"
            onClick={collapsedPermission.onExpand}
            className="flex items-center gap-1.5 px-3 h-[32px] rounded-full bg-accent-main-100/10 backdrop-blur-md border border-accent-main-100/20 text-[length:var(--fs-sm)] leading-[14px] text-accent-main-000 hover:bg-accent-main-100/20 transition-colors"
          >
            <PermissionListIcon size={14} />
            <span className="whitespace-nowrap">{collapsedPermission.label}</span>
            {collapsedPermission.queueLength > 1 && (
              <span className="text-[length:var(--fs-xxs)] opacity-70">+{collapsedPermission.queueLength - 1}</span>
            )}
          </button>
        )}
      </PresenceItem>

      {/* Collapsed Question Capsule */}
      <PresenceItem show={!!collapsedQuestion}>
        {collapsedQuestion && (
          <button
            type="button"
            onClick={collapsedQuestion.onExpand}
            className="flex items-center gap-1.5 px-3 h-[32px] rounded-full bg-accent-main-100/10 backdrop-blur-md border border-accent-main-100/20 text-[length:var(--fs-sm)] leading-[14px] text-accent-main-000 hover:bg-accent-main-100/20 transition-colors"
          >
            <QuestionIcon size={14} />
            <span className="whitespace-nowrap">{collapsedQuestion.label}</span>
            {collapsedQuestion.queueLength > 1 && (
              <span className="text-[length:var(--fs-xxs)] opacity-70">+{collapsedQuestion.queueLength - 1}</span>
            )}
          </button>
        )}
      </PresenceItem>

      <PresenceItem show={!!canRedo}>
        {canRedo && <UndoStatus revertSteps={revertSteps ?? 0} onRedo={onRedo} onRedoAll={onRedoAll} />}
      </PresenceItem>

      {/* 上下文过重量提示：解释「只发两个字也 413」，并给出脱困路径 */}
      <PresenceItem show={!!heavyContent}>
        {heavyContent && (
          <span
            title={heavyContent.title}
            className="flex items-center gap-1.5 px-3 h-[32px] rounded-full bg-bg-100/95 backdrop-blur-md border border-warning-100/40 text-[length:var(--fs-sm)] leading-[14px] text-warning-100 shadow-sm"
          >
            <span className="whitespace-nowrap">{heavyContent.label}</span>
          </span>
        )}
      </PresenceItem>
    </div>
  )
})
