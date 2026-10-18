// ============================================
// ChatPane 的展示组件：输入区（含欢迎层与提示气泡）
//
// 从 ChatPane.tsx 抽出。纯展示 + 转发回调，不持有业务状态。
// ============================================

import type { RefObject } from 'react'
import { Trans } from 'react-i18next'
import { InputBox, type InputBoxProps } from './InputBox'
import { WelcomeHero, WelcomeProjectPill } from './welcome/WelcomeHero'

export interface PaneInputDockProps {
  inputBoxWrapperRef: RefObject<HTMLDivElement | null>
  hostSlideSwitching: boolean
  showCompactShell: boolean
  /** 欢迎态：输入框垂直居中悬浮，hero 在正上方 */
  showWelcome: boolean
  chatContentHeight: number
  inputBoxHeight: number
  showCancelHint: boolean
  fullAutoHint: string | null
  isSubtaskPane: boolean
  inputBoxProps: Omit<InputBoxProps, 'topAccessory' | 'hideFooter'>
  welcomeDirectory: string
  onWelcomeSelectProject: (path: string) => void
  onWelcomeClearProject: () => void
  onWelcomeAddProject: () => void
}

export function PaneInputDock({
  inputBoxWrapperRef,
  hostSlideSwitching,
  showCompactShell,
  showWelcome,
  chatContentHeight,
  inputBoxHeight,
  showCancelHint,
  fullAutoHint,
  isSubtaskPane,
  inputBoxProps,
  welcomeDirectory,
  onWelcomeSelectProject,
  onWelcomeClearProject,
  onWelcomeAddProject,
}: PaneInputDockProps) {
  return (
    <div
      ref={inputBoxWrapperRef}
      className={`absolute left-0 right-0 z-10 pointer-events-none ${
        hostSlideSwitching
          ? 'transition-none'
          : 'transition-[top] duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none'
      }`}
      style={{
        // 欢迎态（无会话无消息）：输入框垂直居中悬浮，hero 在正上方；
        // 发送后 showWelcome 翻 false，容器滑回贴底 —— 与原始设计一致。
        //
        // 用整数像素 top 定位，而不是 bottom:50% + translateY(50%)：
        // 后者会产生非整数位移（实测 65.75px），让整个子树落在半像素上，
        // 文字/图标子像素渲染发虚。这里显式取整，落到整数像素网格。
        top:
          showWelcome && chatContentHeight > 0
            ? `${Math.round((chatContentHeight - inputBoxHeight) / 2)}px`
            : undefined,
        bottom: showWelcome ? undefined : '0',
        // 欢迎态且尚未测到容器/自身高度时先隐藏，避免贴顶闪一帧或半像素。
        visibility: showWelcome && chatContentHeight === 0 ? 'hidden' : undefined,
      }}
    >
      {!showCompactShell && <WelcomeHero active={showWelcome} disableTransition={hostSlideSwitching} />}
      {(showCancelHint || (fullAutoHint && !showCancelHint)) && (
        <div className="absolute bottom-full inset-x-0 flex justify-center pb-2 pointer-events-none z-20">
          <div className="px-3 py-1.5 glass border border-border-200/60 rounded-lg shadow-lg text-[length:var(--fs-sm)] text-text-300 animate-in fade-in slide-in-from-bottom-2 duration-150">
            {showCancelHint ? (
              <Trans
                i18nKey="chat:hints.pressEscAgain"
                components={{
                  1: (
                    <kbd className="mx-0.5 px-1.5 py-0.5 bg-bg-200 border border-border-200 rounded text-[length:var(--fs-xs)] font-mono font-medium text-text-200" />
                  ),
                }}
              />
            ) : (
              fullAutoHint
            )}
          </div>
        </div>
      )}
      {!isSubtaskPane && (
        <InputBox
          {...inputBoxProps}
          hideFooter={showWelcome}
          topAccessory={
            !showCompactShell ? (
              <WelcomeProjectPill
                active={showWelcome}
                directory={welcomeDirectory}
                onSelectProject={onWelcomeSelectProject}
                onClearProject={onWelcomeClearProject}
                onAddProject={onWelcomeAddProject}
              />
            ) : undefined
          }
        />
      )}
    </div>
  )
}
