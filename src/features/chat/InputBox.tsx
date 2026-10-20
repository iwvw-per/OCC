import { useState, useRef, useEffect, useCallback, useMemo, useSyncExternalStore, useLayoutEffect, memo } from 'react'
import { logger } from '../../utils/logger'
import { useTranslation } from 'react-i18next'
import { AttachmentPreview, type Attachment } from '../attachment'
import {
  MentionMenu,
  detectMentionTrigger,
  getFileName,
  normalizePath,
  toFileUrl,
  type MentionMenuHandle,
  type MentionItem,
} from '../mention'
import { SlashCommandMenu, type SlashCommandMenuHandle } from '../slash-command'
import { InputToolbar } from './input/InputToolbar'
import type { ModelSelectorHandle } from './ModelSelector'
import { InputFooter } from './input/InputFooter'
import { FloatingActions } from './input/InputActions'
import { ChatFab, type ChatFabMode } from './input/ChatFab'
import { ArrowUpIcon } from '../../components/Icons'
import { useMobileCollapse } from './input/useMobileCollapse'
import { useAttachmentRail } from './input/useAttachmentRail'
import { useMentionTrigger } from './input/useMentionTrigger'
import { useSlashTrigger } from './input/useSlashTrigger'
import { useInputHistory } from './input/useInputHistory'
import { LargeTextPasteDialog } from './input/LargeTextPasteDialog'
import {
  TEXT_STYLE,
  bytesToDataUrl,
  detectSlashTrigger,
  ensureFileMime,
  getMimeFromPath,
  isFileSupported,
  readFileAsDataUrl,
  compressImageFile,
} from './input/inputUtils'
import { keybindingStore, matchesKeybinding } from '../../store/keybindingStore'
import { inputDraftStore } from '../../store/inputDraftStore'
import { themeStore } from '../../store/themeStore'
import { notificationStore } from '../../store/notificationStore'
import { largeTextPasteStore, useLargeTextPasteSettings } from '../../store/largeTextPasteStore'
import { useLayoutStore } from '../../store/layoutStore'
import { useChatViewport } from './chatViewport'
import { setChatMorphing } from './chatMorph'
import { chatContentMaxWidthStyle, getContentPaddingClass } from './contentWidth'
import type { ApiAgent } from '../../api/client'
import type { ModelInfo, FileCapabilities } from '../../api'
import type { Command } from '../../api/command'
import {
  getDroppedPathsInfo,
  isTauriDropPointInsideElement,
  subscribeTauriDragDrop,
  type DroppedPathInfo,
  type TauriDragDropEvent,
} from '../../lib/tauriDragDrop'
import {
  getInternalDragSnapshot,
  isPointInsideElement as isInternalPointInsideElement,
  subscribeInternalDrag,
  subscribeInternalDrop,
} from '../../lib/internalDragCore'
import { uiErrorHandler } from '../../utils/errorHandling'

// ============================================
// Types
// ============================================

interface HistoryEntry {
  text: string
  attachments: Attachment[]
}

interface DraggedFileInfo {
  type: 'file' | 'folder'
  path: string
  absolute: string
  name: string
}

const TEXTAREA_MIN_HEIGHT = 24
const TEXTAREA_VERTICAL_CHROME = 24
const INPUT_TOOLBAR_FALLBACK_HEIGHT = 36
const INPUT_FOOTER_FALLBACK_HEIGHT = 32
const COMPOSER_MIN_HEIGHT = 144
const COMPOSER_DESKTOP_MAX_HEIGHT = 420
const COMPOSER_COMPACT_MAX_HEIGHT = 320
// 收起态药丸高度（px）：与 ChatFab 收起态等高（--chat-fab-collapsed-size = 36px），
// 两者并排时视觉上是一组。内容 28px + 上下 padding 3px + 上下边框 1px。
const COLLAPSED_BOX_HEIGHT = 36
// 收起态药丸宽度与圆角。必须由 JS 在打开过渡（data-morphing）的同一帧写入，
// 不能放 CSS [data-collapsed]：否则中间任何一次布局读取触发样式重算时，宽度会在
// 过渡尚未 armed 时被定型，表现为横向瞬间收窄、纵向才走动画（快速滚动时明显）。
const COLLAPSED_BOX_WIDTH = 132
const COLLAPSED_BOX_RADIUS = 24
// 变形收尾的兜底时长：真正的收尾信号是 transitionend，这个定时器只防
// 「几何值未变、没有过渡」时状态卡死。必须明显大于 --chat-morph-dur(520ms)，
// 否则主线程繁忙时会在过渡完成前摘掉 data-morphing，几何直接瞬跳。
const MORPH_FALLBACK_MS = 900

const MAX_DROPPED_FILE_SIZE = 20 * 1024 * 1024
const MAX_DROPPED_FILE_SIZE_LABEL = `${MAX_DROPPED_FILE_SIZE / (1024 * 1024)}MB`

// 大文本粘贴阈值：超过此字符数时按偏好询问/自动处理
const LARGE_PASTE_CHAR_THRESHOLD = 2000
const LARGE_PASTE_LINE_THRESHOLD = 25

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function getComposerPaneHeight(anchor: HTMLElement | null): number {
  const paneRoot = anchor?.closest<HTMLElement>('[data-chat-pane-root]')
  const paneHeight = paneRoot?.getBoundingClientRect().height
  if (paneHeight && paneHeight > 0) return paneHeight
  return window.innerHeight || 800
}

function getComposerMaxHeight(paneHeight: number, isCompact: boolean): number {
  const ratio = isCompact ? 0.44 : 0.4
  const hardMax = isCompact ? COMPOSER_COMPACT_MAX_HEIGHT : COMPOSER_DESKTOP_MAX_HEIGHT
  const availableMax = Math.max(COMPOSER_MIN_HEIGHT, paneHeight - 96)
  return clamp(Math.floor(paneHeight * ratio), COMPOSER_MIN_HEIGHT, Math.min(hardMax, availableMax))
}

function getMentionPathForDroppedPath(absolutePath: string, rootPath: string): string {
  const normalizedPath = normalizePath(absolutePath)
  const normalizedRoot = normalizePath(rootPath).replace(/\/+$/, '')
  if (!normalizedRoot) return normalizedPath

  const caseInsensitive = /^[a-zA-Z]:/.test(normalizedPath) || /^[a-zA-Z]:/.test(normalizedRoot)
  const comparablePath = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath
  const comparableRoot = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot

  if (comparablePath === comparableRoot) {
    return getFileName(normalizedPath)
  }

  if (comparablePath.startsWith(`${comparableRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1)
  }

  return normalizedPath
}

export interface CollapsedDialogInfo {
  label: string
  queueLength: number
  onExpand: () => void
}

export interface InputBoxProps {
  paneId: string
  onSend: (
    text: string,
    attachments: Attachment[],
    options?: { agent?: string; variant?: string },
  ) => Promise<boolean> | boolean
  onAbort?: () => void
  onCommand?: (command: string) => Promise<boolean> | boolean // 斜杠命令回调，接收完整命令字符串如 "/help"
  disabled?: boolean
  isStreaming?: boolean
  agents?: ApiAgent[]
  selectedAgent?: string
  onAgentChange?: (agentName: string) => void
  variants?: string[]
  selectedVariant?: string
  onVariantChange?: (variant: string | undefined) => void
  supportsImages?: boolean // 保留向后兼容（deprecated，优先用 fileCapabilities）
  fileCapabilities?: FileCapabilities
  // Model（移动端 InputToolbar 用）
  models?: ModelInfo[]
  selectedModelKey?: string | null
  onModelChange?: (modelKey: string, model: ModelInfo) => void
  modelsLoading?: boolean
  modelSelectorRef?: React.RefObject<ModelSelectorHandle | null>
  rootPath?: string
  sessionId?: string | null
  // Undo/Redo
  revertedText?: string
  revertedAttachments?: Attachment[]
  canRedo?: boolean
  revertSteps?: number
  onRedo?: () => void
  onRedoAll?: () => void
  onClearRevert?: () => void
  // Animation
  registerInputBox?: (element: HTMLElement | null) => void
  isAtBottom?: boolean
  onScrollToBottom?: () => void
  // Collapsed dialog capsules
  collapsedPermission?: CollapsedDialogInfo
  collapsedQuestion?: CollapsedDialogInfo
  // 欢迎态（home 空态）隐藏底部 token/统计栏
  hideFooter?: boolean
  // 附加在输入框顶边的角标（如欢迎页项目选择按钮）。
  // 作为输入框容器的子节点渲染，跟随输入框几何与层级，避免被输入框盖住或错位。
  topAccessory?: React.ReactNode
}

// ============================================
// InputBox Component
// ============================================

function InputBoxComponent({
  paneId,
  onSend,
  onAbort,
  onCommand,
  disabled,
  isStreaming,
  agents = [],
  selectedAgent,
  onAgentChange,
  variants = [],
  selectedVariant,
  onVariantChange,
  supportsImages = false,
  fileCapabilities: fileCapabilitiesProp,
  models = [],
  selectedModelKey = null,
  onModelChange,
  modelsLoading = false,
  modelSelectorRef,
  rootPath = '',
  sessionId,
  revertedText,
  revertedAttachments,
  canRedo = false,
  revertSteps = 0,
  onRedo,
  onRedoAll,
  onClearRevert,
  registerInputBox,
  isAtBottom = true,
  onScrollToBottom,
  collapsedPermission,
  collapsedQuestion,
  hideFooter = false,
  topAccessory,
}: InputBoxProps) {
  const { t } = useTranslation('chat')
  const { sendOnEnter } = useLayoutStore()
  // 合并文件能力：优先用 fileCapabilities，回退到 supportsImages。
  //
  // ⚠️ 能力「未知」不等于「不支持」。模型列表尚未加载完（或加载失败）时
  // fileCapabilities 为 undefined，若这里退化成全 false，supportsAnyFile 就是 false，
  // handleFilesSelected 会在第一行直接 return —— 用户粘贴/选择图片后毫无反应，
  // 也没有任何提示。这正是「仅图片发送没有反应」的一个来源。
  //
  // 因此未知时按「允许选择」处理，把最终裁决交给服务端：多带一个附件远好于
  // 静默丢掉用户的图片。真正不被支持时，下面的 handleFilesSelected 会给出提示。
  const fileCaps: FileCapabilities = useMemo(
    () =>
      fileCapabilitiesProp ?? {
        image: supportsImages ?? true,
        pdf: false,
        audio: false,
        video: false,
      },
    [fileCapabilitiesProp, supportsImages],
  )
  const { externalFileDropMode, showInputStatusBar } = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot)

  // 是否有任何文件附件能力
  const supportsAnyFile = fileCaps.image || fileCaps.pdf || fileCaps.audio || fileCaps.video

  // 文本状态
  const [text, setText] = useState('')
  // 附件状态（图片、文件、文件夹、agent）
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  // 大文本粘贴：待处理的文本与弹窗开关
  const [pendingLargePaste, setPendingLargePaste] = useState<string | null>(null)
  const { behavior: largePasteBehavior } = useLargeTextPasteSettings()


  // 拖拽状态
  const [isDragging, setIsDragging] = useState(false)
  const [isInternalFileDragging, setIsInternalFileDragging] = useState(false)
  const dragCounterRef = useRef(0)
  const lastTauriDropAtRef = useRef(0)

  const { presentation, interaction } = useChatViewport()
  const isCompact = presentation.isCompact

  // Refs
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const inputContainerRef = useRef<HTMLDivElement>(null)
  const attachmentRailRef = useRef<HTMLDivElement>(null)
  const attachmentSectionRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const mentionMenuRef = useRef<MentionMenuHandle>(null)
  const slashMenuRef = useRef<SlashCommandMenuHandle>(null)
  const prevRevertedTextRef = useRef<string | undefined>(undefined)
  const latestDraftRef = useRef<HistoryEntry>({ text: '', attachments: [] })
  const contentWrapRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  const isComposingRef = useRef(false)
  const compositionEndTimerRef = useRef<number | null>(null)
  const [composerMaxHeight, setComposerMaxHeight] = useState(280)
  const [inputContainerMaxHeight, setInputContainerMaxHeight] = useState(240)
  const [textareaMaxHeight, setTextareaMaxHeight] = useState(180)

  // 附件横向轨道
  const {
    overflowing: attachmentsOverflowing,
    showLeftFade: showAttachmentLeftFade,
    showRightFade: showAttachmentRightFade,
    handleScroll: syncAttachmentRailState,
    handleWheel: handleAttachmentRailWheel,
  } = useAttachmentRail({ attachmentCount: attachments.length, railRef: attachmentRailRef })

  // ============================================
  // 历史消息导航（类终端体验，逻辑在 useInputHistory hook 中）
  // ============================================
  const { handleHistoryKeyDown, handleHistoryChange, resetHistoryIndex } = useInputHistory({ textareaRef, sessionId })

  // ============================================
  // Mobile Input Dock: 滚动收起/展开（逻辑在 useMobileCollapse hook 中）
  // ============================================
  const hasContent = text.trim().length > 0 || attachments.length > 0
  const { isCollapsed, expandedHeightRef, handleExpandInput, handleFocus, handleBlur, handleContainerPointerDown } =
    useMobileCollapse({
      enabled: interaction.enableCollapsedInputDock,
      hasContent,
      isAtBottom,
      textareaRef,
      inputContainerRef,
      contentWrapRef,
      footerRef,
      registerInputBox,
      collapsedPermission,
      collapsedQuestion,
    })

  // 处理 revert 恢复
  useEffect(() => {
    latestDraftRef.current = { text, attachments }
  }, [text, attachments])

  useEffect(() => {
    let frameId: number | null = null

    if (revertedText !== undefined) {
      frameId = requestAnimationFrame(() => {
        setText(revertedText)
        setAttachments(revertedAttachments || [])
        // 聚焦并移动光标到末尾
        if (textareaRef.current) {
          textareaRef.current.focus()
          textareaRef.current.setSelectionRange(revertedText.length, revertedText.length)
        }
      })
    } else if (prevRevertedTextRef.current !== undefined && revertedText === undefined && !isSubmitting) {
      frameId = requestAnimationFrame(() => {
        setText('')
        setAttachments([])
      })
    }

    prevRevertedTextRef.current = revertedText

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
      }
    }
  }, [revertedText, revertedAttachments, isSubmitting])

  // 会话切换：草稿按会话分桶，互不串台。
  // - 切走：把当前输入保存到旧会话的桶
  // - 切回：恢复该会话自己的草稿（新会话没有桶 → 空输入，不会被上一个会话带过去）
  // 与 revert/undo 的 text 同步错开：revert 恢复的是「已发送消息」，草稿桶存的是「未发送预输入」。
  const draftSessionIdRef = useRef<string | null>(null)
  useEffect(() => {
    const current = sessionId ?? null
    const prev = draftSessionIdRef.current
    draftSessionIdRef.current = current
    if (prev === current) return

    // 切走时保存旧会话草稿（总是覆盖桶：手动清空后切回也保持空）
    if (prev !== null) {
      inputDraftStore.save(prev, {
        text: latestDraftRef.current.text,
        attachments: latestDraftRef.current.attachments,
      })
    }
    // 恢复新会话草稿（无桶则为空输入）
    const draft = current !== null ? inputDraftStore.load(current) : undefined
    latestDraftRef.current = draft ?? { text: '', attachments: [] }
    setText(draft?.text ?? '')
    setAttachments(draft?.attachments ?? [])
    resetHistoryIndex()
  }, [sessionId, resetHistoryIndex])

  useEffect(
    () => () => {
      if (compositionEndTimerRef.current !== null) {
        clearTimeout(compositionEndTimerRef.current)
      }
    },
    [],
  )

  const updateComposerHeightBudget = useCallback(() => {
    const paneHeight = getComposerPaneHeight(inputContainerRef.current ?? contentWrapRef.current)
    const nextComposerMaxHeight = getComposerMaxHeight(paneHeight, isCompact)
    const attachmentHeight = attachments.length > 0 ? (attachmentSectionRef.current?.offsetHeight ?? 0) : 0
    const toolbarHeight = toolbarRef.current?.offsetHeight || INPUT_TOOLBAR_FALLBACK_HEIGHT
    // footer 的布局高度恒为 h-8（2rem），与信息栏内容是否渲染无关：
    // 它是底部缓冲不变量的一半，不能随 showInputStatusBar 变化，否则收起/展开总高不等。
    const footerHeight = isCollapsed ? 0 : footerRef.current?.offsetHeight || INPUT_FOOTER_FALLBACK_HEIGHT
    const inputContainerChrome = attachmentHeight + toolbarHeight + TEXTAREA_VERTICAL_CHROME
    const nextInputContainerMaxHeight = Math.max(
      TEXTAREA_MIN_HEIGHT + TEXTAREA_VERTICAL_CHROME + toolbarHeight,
      nextComposerMaxHeight - footerHeight,
    )
    const nextTextareaMaxHeight = Math.max(TEXTAREA_MIN_HEIGHT, nextInputContainerMaxHeight - inputContainerChrome)

    setComposerMaxHeight(prev => (Math.abs(prev - nextComposerMaxHeight) < 1 ? prev : nextComposerMaxHeight))
    setInputContainerMaxHeight(prev =>
      Math.abs(prev - nextInputContainerMaxHeight) < 1 ? prev : nextInputContainerMaxHeight,
    )
    setTextareaMaxHeight(prev => (Math.abs(prev - nextTextareaMaxHeight) < 1 ? prev : nextTextareaMaxHeight))
  }, [attachments.length, isCollapsed, isCompact])

  useLayoutEffect(() => {
    updateComposerHeightBudget()
  }, [updateComposerHeightBudget, text])

  useEffect(() => {
    updateComposerHeightBudget()

    const observed = [
      inputContainerRef.current?.closest<HTMLElement>('[data-chat-pane-root]'),
      inputContainerRef.current,
      attachmentSectionRef.current,
      toolbarRef.current,
      footerRef.current,
    ].filter((element): element is HTMLElement => !!element)

    // 同帧多次 RO/resize 合并为一次高度预算计算，避免布局连环读
    let budgetRaf: number | null = null
    const scheduleBudgetUpdate = () => {
      if (budgetRaf !== null) return
      budgetRaf = requestAnimationFrame(() => {
        budgetRaf = null
        updateComposerHeightBudget()
      })
    }

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleBudgetUpdate) : null
    observed.forEach(element => observer?.observe(element))
    window.addEventListener('resize', scheduleBudgetUpdate)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', scheduleBudgetUpdate)
      if (budgetRaf !== null) cancelAnimationFrame(budgetRaf)
    }
  }, [updateComposerHeightBudget])

  // 自动调整 textarea 高度
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    // 只有真正空字符串时才重置高度；保留仅空格/空行时的换行高度
    if (text.length === 0) {
      textarea.style.height = `${TEXTAREA_MIN_HEIGHT}px`
      return
    }

    textarea.style.height = 'auto'
    const scrollHeight = textarea.scrollHeight
    textarea.style.height = Math.max(TEXTAREA_MIN_HEIGHT, Math.min(scrollHeight, textareaMaxHeight)) + 'px'
  }, [text, textareaMaxHeight])

  // 计算
  const inputDisabled = !!disabled
  const canSend = (text.trim().length > 0 || attachments.length > 0) && !inputDisabled

  // ============================================
  // Handlers
  // ============================================

  const resetDraft = useCallback(() => {
    latestDraftRef.current = { text: '', attachments: [] }
    setText('')
    setAttachments([])
    resetHistoryIndex()
  }, [resetHistoryIndex])

  const restoreDraft = useCallback(
    (draft: HistoryEntry) => {
      latestDraftRef.current = draft
      setText(draft.text)
      setAttachments(draft.attachments)
      resetHistoryIndex()

      requestAnimationFrame(() => {
        if (!textareaRef.current) return
        const cursorPos = draft.text.length
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(cursorPos, cursorPos)
      })
    },
    [resetHistoryIndex],
  )

  const submitCommandOptimistically = useCallback(
    (commandStr: string) => {
      if (!onCommand) return

      const draftSnapshot: HistoryEntry = {
        text,
        attachments: [...attachments],
      }

      resetDraft()
      requestAnimationFrame(() => {
        if (!textareaRef.current) return
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(0, 0)
      })

      void (async () => {
        let result: boolean | void
        try {
          result = await onCommand(commandStr)
        } catch (err) {
          // 与 handleSend 一致：命令执行失败不能静默，否则用户只看到草稿被恢复
          uiErrorHandler('execute slash command', err)
          result = false
        }

        if (result !== false) {
          onClearRevert?.()
          return
        }

        const currentDraft = latestDraftRef.current
        if (currentDraft.text.length === 0 && currentDraft.attachments.length === 0) {
          restoreDraft(draftSnapshot)
        }
      })()
    },
    [attachments, onClearRevert, onCommand, resetDraft, restoreDraft, text],
  )

  // @ 提及与 / 命令的触发态（见 input/useMentionTrigger、input/useSlashTrigger）
  const mention = useMentionTrigger({ text, setText, textareaRef })
  const slash = useSlashTrigger({
    text,
    setText,
    setAttachments,
    textareaRef,
    onCommand,
    submitCommandOptimistically,
  })
  const { open: mentionOpen, query: mentionQuery } = mention
  const setMentionOpen = mention.setOpen
  const updateMentionQuery = mention.updateQuery
  const { open: slashOpen, query: slashQuery } = slash
  const setSlashOpen = slash.setOpen

  const runSubmit = useCallback(
    async (
      submit: () => Promise<boolean | void> | boolean | void,
      onSuccess?: () => void,
      onFailure?: () => void,
      options?: {
        /**
         * 提交后立即释放 isSubmitting（不等 submit 返回）。
         *
         * 用于普通发消息：消息一上屏、草稿一清空，输入区就该恢复可用。若等到整条
         * 发送链路（远程主机下 create/switch/prompt 串行可达数秒）结束才释放，
         * 用户会盯着变灰的发送按钮，以为没发出去而重复点。
         */
        releaseImmediately?: boolean
      },
    ) => {
      if (isSubmitting) return false

      setIsSubmitting(true)
      let released = false
      const release = () => {
        if (released) return
        released = true
        setIsSubmitting(false)
      }
      try {
        const pending = submit()
        if (options?.releaseImmediately) release()
        const result = await pending
        if (result === false) {
          onFailure?.()
          return false
        }

        onSuccess?.()
        return true
      } catch (err) {
        uiErrorHandler('send message', err)
        onFailure?.()
        return false
      } finally {
        release()
      }
    },
    [isSubmitting],
  )

  const handleSend = useCallback(() => {
    if (!canSend || isSubmitting) return

    // 检测 command attachment
    const commandAttachment = attachments.find(a => a.type === 'command')
    if (commandAttachment && commandAttachment.commandName) {
      if (!onCommand) return

      // 提取命令后的参数文本
      const textRange = commandAttachment.textRange
      const afterCommand = textRange ? text.slice(textRange.end).trim() : ''
      const commandStr = `/${commandAttachment.commandName}${afterCommand ? ' ' + afterCommand : ''}`
      submitCommandOptimistically(commandStr)
      return
    }

    // 从 attachments 中找 agent mention
    const agentAttachment = attachments.find(a => a.type === 'agent')
    const mentionedAgent = agentAttachment?.agentName

    // 乐观清空：与 submitCommandOptimistically 一致，先把输入框清掉让点击立即有反馈，
    // 网络往返在后台进行；失败时若用户没有重新输入则恢复草稿。
    // 否则后端繁忙时点击发送要等整个 prompt 请求返回才看到输入框变化。
    const draftSnapshot: HistoryEntry = { text, attachments: [...attachments] }
    resetDraft()

    void runSubmit(
      () =>
        onSend(text, attachments, {
          agent: mentionedAgent || selectedAgent,
          variant: selectedVariant,
        }),
      () => {
        onClearRevert?.()
        // 发送成功：清掉该会话的草稿桶，切回来不会显示已发送的旧预输入
        if (sessionId) inputDraftStore.clear(sessionId)
      },
      () => {
        const currentDraft = latestDraftRef.current
        if (currentDraft.text.length === 0 && currentDraft.attachments.length === 0) {
          restoreDraft(draftSnapshot)
        }
      },
      // 普通发消息：输入区立即恢复可用（详见 runSubmit 的 releaseImmediately）
      { releaseImmediately: true },
    )
  }, [
    attachments,
    canSend,
    isSubmitting,
    onCommand,
    onClearRevert,
    onSend,
    resetDraft,
    restoreDraft,
    runSubmit,
    selectedAgent,
    selectedVariant,
    sessionId,
    submitCommandOptimistically,
    text,
  ])


  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent
      const isImeComposing = isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229

      if (isImeComposing && (e.key === 'Enter' || e.key === 'Tab')) return

      // Slash Command 菜单打开时，拦截导航键
      if (slashOpen && slashMenuRef.current) {
        switch (e.key) {
          case 'ArrowUp':
            e.preventDefault()
            slashMenuRef.current.moveUp()
            return
          case 'ArrowDown':
            e.preventDefault()
            slashMenuRef.current.moveDown()
            return
          case 'Enter':
          case 'Tab':
            e.preventDefault()
            slashMenuRef.current.selectCurrent()
            return
          case 'Escape':
            e.preventDefault()
            setSlashOpen(false)
            return
        }
      }

      // Mention 菜单打开时，拦截导航键
      if (mentionOpen && mentionMenuRef.current) {
        switch (e.key) {
          case 'ArrowUp':
            e.preventDefault()
            mentionMenuRef.current.moveUp()
            return
          case 'ArrowDown':
            e.preventDefault()
            mentionMenuRef.current.moveDown()
            return
          case 'ArrowRight': {
            // 进入文件夹
            const selected = mentionMenuRef.current.getSelectedItem()
            if (selected?.type === 'folder') {
              e.preventDefault()
              const basePath = (selected.relativePath || selected.displayName).replace(/\/+$/, '')
              const folderPath = basePath + '/'
              updateMentionQuery(folderPath)
            }
            return
          }
          case 'ArrowLeft': {
            // 返回上一级
            if (mentionQuery.includes('/')) {
              e.preventDefault()
              const parts = mentionQuery.replace(/\/$/, '').split('/')
              // 记住当前目录名，返回后定位到它
              const folderName = parts[parts.length - 1]
              if (folderName) {
                mentionMenuRef.current.setRestoreFolder(folderName)
              }
              parts.pop()
              const parentPath = parts.length > 0 ? parts.join('/') + '/' : ''
              updateMentionQuery(parentPath)
            }
            return
          }
          case 'Enter':
          case 'Tab':
            e.preventDefault()
            mentionMenuRef.current.selectCurrent()
            return
          case 'Escape':
            e.preventDefault()
            setMentionOpen(false)
            return
        }
      }

      // Tab 键：mention 菜单关闭时，不做任何事（阻止跳到工具栏）
      if (e.key === 'Tab') {
        e.preventDefault()
        return
      }

      // 历史消息导航（类终端体验）
      const historyResult = handleHistoryKeyDown(e, text, attachments)
      if (historyResult) {
        setText(historyResult.text)
        setAttachments(historyResult.attachments)
        requestAnimationFrame(() => {
          if (!textareaRef.current) return
          const cursorPos = historyResult.cursor === 'start' ? 0 : historyResult.text.length
          textareaRef.current.focus()
          textareaRef.current.setSelectionRange(cursorPos, cursorPos)
        })
        return
      }

      // 发送消息：发送方式设置决定 Enter / Shift+Enter 哪个是发送键；
      // 另一个键保留默认换行。自定义 sendMessage 键（默认 Ctrl+Enter）始终可用。
      const sendKey = keybindingStore.getKey('sendMessage')
      const isPlainEnter = e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey

      if (!sendOnEnter) {
        // Shift+Enter 发送：裸 Enter 只换行，Shift+Enter 直接发送
        if (e.key === 'Enter' && e.shiftKey && !isImeComposing) {
          e.preventDefault()
          handleSend()
        } else if (sendKey && !isImeComposing && !isPlainEnter && matchesKeybinding(nativeEvent, sendKey)) {
          e.preventDefault()
          handleSend()
        }
        return
      }

      // Enter 发送（默认）：裸 Enter 直接发送
      if (isPlainEnter && !isImeComposing) {
        e.preventDefault()
        handleSend()
      } else if (sendKey && !isImeComposing && !isPlainEnter && matchesKeybinding(nativeEvent, sendKey)) {
        e.preventDefault()
        handleSend()
      }
    },
    [
      mentionOpen,
      slashOpen,
      mentionQuery,
      updateMentionQuery,
      setMentionOpen,
      setSlashOpen,
      handleSend,
      text,
      attachments,
      handleHistoryKeyDown,
      sendOnEnter,
    ],
  )

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newText = e.target.value
      setText(newText)

      // 移动端 IME 兜底：全选删除时 compositionend 可能不触发（已知的
      // 移动端输入法行为），isComposingRef 会永久卡在 true——之后回车
      // 发送永远被 isImeComposing 拦截。文本被清空说明 composition 已
      // 被中断，强制复位。
      if (isComposingRef.current && newText.length === 0) {
        isComposingRef.current = false
        if (compositionEndTimerRef.current !== null) {
          clearTimeout(compositionEndTimerRef.current)
          compositionEndTimerRef.current = null
        }
      }

      // 用户修改了内容，检查是否应退出历史模式
      handleHistoryChange(newText)

      // 同步检测 mention 是否被破坏/删除
      // 比对 attachments 的 textRange：如果文本中对应位置不再匹配，删除该 attachment
      setAttachments(prev => {
        const surviving = prev.filter(a => {
          if (!a.textRange) return true // 图片等无 textRange 的保留
          const { start, end, value } = a.textRange
          const actual = newText.slice(start, end)
          return actual === value
        })
        // 只在数量变化时更新（避免不必要的 re-render）
        return surviving.length === prev.length ? prev : surviving
      })

      // 检测 @ 触发
      const cursorPos = e.target.selectionStart || 0
      const trigger = detectMentionTrigger(newText, cursorPos, '@')

      if (trigger) {
        mention.updateQuery(trigger.query, trigger.startIndex)
        setMentionOpen(true)
        setSlashOpen(false) // 关闭斜杠菜单
      } else {
        setMentionOpen(false)

        // 检测 / 触发（只在行首或空白后）
        const slashTrigger = detectSlashTrigger(newText, cursorPos)
        if (slashTrigger) {
          slash.updateQuery(slashTrigger.query, slashTrigger.startIndex)
          setSlashOpen(true)
        } else {
          setSlashOpen(false)
        }
      }
    },
    [handleHistoryChange, mention, slash, setMentionOpen, setSlashOpen],
  )

  const handleCompositionStart = useCallback(() => {
    if (compositionEndTimerRef.current !== null) {
      clearTimeout(compositionEndTimerRef.current)
      compositionEndTimerRef.current = null
    }
    isComposingRef.current = true
  }, [])

  const handleCompositionEnd = useCallback(() => {
    if (compositionEndTimerRef.current !== null) {
      clearTimeout(compositionEndTimerRef.current)
    }

    compositionEndTimerRef.current = window.setTimeout(() => {
      isComposingRef.current = false
      compositionEndTimerRef.current = null
    }, 0)
  }, [])

  // @ Mention 选择处理
  const handleMentionSelect = useCallback(
    (item: MentionItem & { _enterFolder?: boolean }) => {
      mention.selectItem(item)
    },
    [mention],
  )

  const handleMentionClose = mention.close

  const handleSlashSelect = useCallback(
    (command: Command) => {
      slash.select(command)
    },
    [slash],
  )

  const handleSlashClose = slash.close

  // 通用文件上传 — 根据模型能力判断是否接受
  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || !supportsAnyFile || isSubmitting) return

      const nextAttachments: Attachment[] = []
      const rejected: { name: string; type: 'size' | 'type' }[] = []

      for (const rawFile of files) {
        const file = ensureFileMime(rawFile)

        // 按 MIME 类型检查模型能力
        if (!isFileSupported(file.type, fileCaps)) {
          rejected.push({ name: file.name, type: 'type' })
          continue
        }

        // 大小上限：此前只有 Tauri 外拖路径校验，选择器/粘贴/浏览器拖拽可塞入任意大文件
        if (file.size > MAX_DROPPED_FILE_SIZE) {
          rejected.push({ name: file.name, type: 'size' })
          continue
        }

        try {
          // 图片走压缩链（缩放 + WebP），其它文件直接读为 data URL
          const { dataUrl, mime } = file.type.startsWith('image/')
            ? await compressImageFile(file)
            : { dataUrl: await readFileAsDataUrl(file), mime: file.type }

          nextAttachments.push({
            id: crypto.randomUUID(),
            type: 'file',
            displayName: file.name,
            url: dataUrl,
            mime,
          })
        } catch (err) {
          logger.warn('[InputBox] Failed to process file:', err)
        }
      }

      if (rejected.length > 0) {
        const tooLarge = rejected.filter(item => item.type === 'size')
        if (tooLarge.length > 0) {
          notificationStore.push(
            'error',
            t('inputBox.fileTooLarge'),
            t('inputBox.fileTooLargeBody', { name: tooLarge[0].name, size: MAX_DROPPED_FILE_SIZE_LABEL }),
            sessionId ?? '',
          )
        }
        // 类型不被当前模型支持：必须明确告知。
        // 此前这条分支只处理「文件太大」，类型不支持时完全静默 —— 用户粘贴/选择图片
        // 后什么都没发生（没有附件、没有报错），看起来就是「发图片没反应」。
        const unsupported = rejected.filter(item => item.type === 'type')
        if (unsupported.length > 0) {
          notificationStore.push(
            'error',
            t('inputBox.fileTypeUnsupported'),
            t('inputBox.fileTypeUnsupportedBody', { name: unsupported[0].name }),
            sessionId ?? '',
          )
        }
      }

      if (nextAttachments.length > 0) {
        setAttachments(prev => [...prev, ...nextAttachments])
      }
    },
    [supportsAnyFile, fileCaps, isSubmitting, sessionId, t],
  )

  // 删除附件
  const handleRemoveAttachment = useCallback(
    (id: string) => {
      if (isSubmitting) return

      const attachment = attachments.find(a => a.id === id)
      if (!attachment) return

      // 如果有 textRange，从文本中删除 @mention
      if (attachment.textRange) {
        const { value } = attachment.textRange
        // 删除 @mention 和后面的空格
        const newText = text.replace(value + ' ', '').replace(value, '')
        setText(newText)
      }

      setAttachments(prev => prev.filter(a => a.id !== id))
    },
    [attachments, isSubmitting, text],
  )

  // 判断粘贴文本是否达到「大文本」阈值（字符数或行数任一超限）
  const isLargePaste = useCallback((value: string): boolean => {
    if (value.length >= LARGE_PASTE_CHAR_THRESHOLD) return true
    let lines = 1
    for (let i = 0; i < value.length; i++) {
      if (value.charCodeAt(i) === 10) {
        lines += 1
        if (lines >= LARGE_PASTE_LINE_THRESHOLD) return true
      }
    }
    return false
  }, [])

  // 在光标处插入文本（不替换已有内容）
  const insertInlineText = useCallback(
    (value: string) => {
      const textarea = textareaRef.current
      if (!textarea) {
        setText(prev => prev + value)
        return
      }
      const start = textarea.selectionStart ?? text.length
      const end = textarea.selectionEnd ?? text.length
      setText(prev => prev.slice(0, start) + value + prev.slice(end))
      requestAnimationFrame(() => {
        const pos = start + value.length
        textarea.focus()
        textarea.setSelectionRange(pos, pos)
      })
    },
    [text.length],
  )

  // 把大文本作为 .txt 附件加入
  const applyLargePasteAsAttachment = useCallback(
    async (value: string) => {
      const blob = new Blob([value], { type: 'text/plain' })
      const file = new File([blob], `pasted-${Date.now()}.txt`, { type: 'text/plain' })
      await handleFilesSelected([file])
    },
    [handleFilesSelected],
  )

  // 粘贴处理 — 根据模型能力过滤可粘贴的文件类型
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (supportsAnyFile) {
        const items = e.clipboardData?.items
        const files: File[] = []

        if (items) {
          for (let i = 0; i < items.length; i++) {
            if (items[i].kind === 'file') {
              const file = items[i].getAsFile()
              if (file && isFileSupported(ensureFileMime(file).type, fileCaps)) files.push(file)
            }
          }
        }

        if (files.length > 0) {
          e.preventDefault()
          void handleFilesSelected(files)
          return
        }
      }

      // 大文本粘贴：超过阈值时按偏好询问/自动处理，避免长内容撑爆输入框
      const pasted = e.clipboardData?.getData('text/plain') ?? ''
      if (isLargePaste(pasted)) {
        e.preventDefault()
        if (largePasteBehavior === 'attach') {
          void applyLargePasteAsAttachment(pasted)
        } else if (largePasteBehavior === 'inline') {
          insertInlineText(pasted)
        } else {
          setPendingLargePaste(pasted)
        }
        return
      }

      // 普通文本粘贴：让 textarea 默认处理（天然支持换行和 undo）
    },
    [supportsAnyFile, fileCaps, handleFilesSelected, largePasteBehavior, applyLargePasteAsAttachment, insertInlineText, isLargePaste],
  )

  // 拖拽文件到输入框
  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current++
      if (supportsAnyFile && e.dataTransfer.types.includes('Files')) {
        setIsDragging(true)
      }
    },
    [supportsAnyFile],
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDragging(false)
    }
  }, [])

  // 将拖入的文件信息插入为 @mention 附件
  const insertDraggedFiles = useCallback(
    (fileInfos: DraggedFileInfo[]) => {
      if (fileInfos.length === 0) return

      const currentText = textareaRef.current?.value ?? text
      const cursorPos = textareaRef.current?.selectionStart ?? currentText.length
      const beforeCursor = currentText.slice(0, cursorPos)
      const afterCursor = currentText.slice(cursorPos)
      const needSpaceBefore = beforeCursor.length > 0 && !beforeCursor.endsWith(' ') && !beforeCursor.endsWith('\n')
      const prefix = needSpaceBefore ? ' ' : ''
      const mentions = fileInfos.map(fileInfo => {
        const relativePath = normalizePath(fileInfo.path)
        return {
          fileInfo,
          relativePath,
          mentionText: `@${relativePath}`,
        }
      })
      const insertedText = `${prefix}${mentions.map(item => item.mentionText).join(' ')} `
      const newText = beforeCursor + insertedText + afterCursor
      let mentionStart = cursorPos + prefix.length

      const nextAttachments: Attachment[] = mentions.map(({ fileInfo, relativePath, mentionText }) => {
        const start = mentionStart
        mentionStart += mentionText.length + 1

        return {
          id: crypto.randomUUID(),
          type: fileInfo.type,
          displayName: fileInfo.name,
          relativePath,
          url: toFileUrl(fileInfo.absolute),
          mime: fileInfo.type === 'file' ? 'text/plain' : undefined,
          textRange: {
            value: mentionText,
            start,
            end: start + mentionText.length,
          },
        }
      })

      setText(newText)
      setAttachments(prev => [...prev, ...nextAttachments])

      requestAnimationFrame(() => {
        if (!textareaRef.current) return
        const newCursorPos = cursorPos + insertedText.length
        textareaRef.current.setSelectionRange(newCursorPos, newCursorPos)
        textareaRef.current.focus()
      })
    },
    [text],
  )

  const insertDraggedFile = useCallback(
    (fileInfo: DraggedFileInfo) => insertDraggedFiles([fileInfo]),
    [insertDraggedFiles],
  )

  useEffect(() => {
    const updateInternalFileDragState = () => {
      const active = getInternalDragSnapshot().active
      if (!active || active.payload.kind !== 'file-mention') {
        setIsInternalFileDragging(false)
        return
      }
      setIsInternalFileDragging(isInternalPointInsideElement(active.current, inputContainerRef.current))
    }

    updateInternalFileDragState()
    return subscribeInternalDrag(updateInternalFileDragState)
  }, [])

  useEffect(() => {
    return subscribeInternalDrop(event => {
      if (event.payload.kind !== 'file-mention') return
      if (!isInternalPointInsideElement(event.point, inputContainerRef.current)) return
      insertDraggedFile(event.payload.file)
    })
  }, [insertDraggedFile])

  const buildDraggedFileInfo = useCallback(
    (fileInfo: DroppedPathInfo): DraggedFileInfo => ({
      type: fileInfo.type,
      path: getMentionPathForDroppedPath(fileInfo.path, rootPath),
      absolute: fileInfo.path,
      name: fileInfo.name || getFileName(fileInfo.path),
    }),
    [rootPath],
  )

  const createUploadAttachmentFromDroppedPath = useCallback(
    async (fileInfo: DroppedPathInfo): Promise<Attachment | null> => {
      if (fileInfo.type !== 'file') return null

      const mime = getMimeFromPath(fileInfo.path)
      if (!isFileSupported(mime, fileCaps)) return null

      const displayName = fileInfo.name || getFileName(fileInfo.path)

      try {
        const { readFile, stat } = await import('@tauri-apps/plugin-fs')

        // 先读取元数据判断大小，避免先把整个文件读进内存再转 base64（膨胀约 1.33 倍）
        const fileStat = await stat(fileInfo.path)
        if (fileStat.size > MAX_DROPPED_FILE_SIZE) {
          notificationStore.push(
            'error',
            t('inputBox.fileTooLarge'),
            t('inputBox.fileTooLargeBody', { name: displayName, size: MAX_DROPPED_FILE_SIZE_LABEL }),
            sessionId ?? '',
          )
          return null
        }

        const bytes = await readFile(fileInfo.path)
        return {
          id: crypto.randomUUID(),
          type: 'file',
          displayName,
          url: bytesToDataUrl(bytes, mime),
          mime,
        }
      } catch (err) {
        logger.warn('[InputBox] Failed to read dropped file for upload:', err)
        return null
      }
    },
    [fileCaps, sessionId, t],
  )

  const handleTauriExternalDrop = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0 || isSubmitting) return

      try {
        const droppedPaths = await getDroppedPathsInfo(paths)
        const uploadAttachments: Attachment[] = []
        const mentionFiles: DraggedFileInfo[] = []

        for (const droppedPath of droppedPaths) {
          if (externalFileDropMode === 'mention') {
            mentionFiles.push(buildDraggedFileInfo(droppedPath))
            continue
          }

          const uploadAttachment = await createUploadAttachmentFromDroppedPath(droppedPath)
          if (uploadAttachment) {
            uploadAttachments.push(uploadAttachment)
          } else {
            mentionFiles.push(buildDraggedFileInfo(droppedPath))
          }
        }

        if (uploadAttachments.length > 0) {
          setAttachments(prev => [...prev, ...uploadAttachments])
        }

        insertDraggedFiles(mentionFiles)
      } catch (err) {
        logger.warn('[InputBox] Failed to process Tauri dropped paths:', err)
      }
    },
    [
      buildDraggedFileInfo,
      createUploadAttachmentFromDroppedPath,
      externalFileDropMode,
      insertDraggedFiles,
      isSubmitting,
    ],
  )

  const handleTauriDragDropEvent = useCallback(
    (event: TauriDragDropEvent) => {
      if (event.type === 'leave') {
        dragCounterRef.current = 0
        setIsDragging(false)
        return
      }

      const insideInput = isTauriDropPointInsideElement(event.position, inputContainerRef.current)

      if (event.type === 'enter' || event.type === 'over') {
        setIsDragging(insideInput)
        return
      }

      dragCounterRef.current = 0
      setIsDragging(false)
      if (insideInput) {
        lastTauriDropAtRef.current = Date.now()
        void handleTauriExternalDrop(event.paths)
      }
    },
    [handleTauriExternalDrop],
  )

  useEffect(() => subscribeTauriDragDrop(handleTauriDragDropEvent), [handleTauriDragDropEvent])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current = 0
      setIsDragging(false)

      // 原生文件拖拽（从操作系统拖入）
      if (e.dataTransfer.files.length > 0) {
        if (Date.now() - lastTauriDropAtRef.current < 750) return
        void handleFilesSelected(Array.from(e.dataTransfer.files))
      }
    },
    [handleFilesSelected],
  )

  // 滚动同步（备用，overlay 内部也监听了 scroll）
  const handleScroll = useCallback(() => {
    // overlay 通过 useEffect 自动同步，这里留空
  }, [])

  // ============================================
  // Render
  // ============================================

  // 计算已选择的 items (用于过滤菜单)
  const excludeValues = useMemo(() => {
    const set = new Set<string>()
    attachments.forEach(a => {
      if (a.url) set.add(a.url)
      if (a.agentName) set.add(a.agentName)
    })
    return set
  }, [attachments])

  // 底部缓冲基准值：
  // - 信息栏可见：底部那条 h-8(2rem) 信息栏本身就撑出了呼吸空间，基准 = 2rem；
  // - 信息栏隐藏（默认）：没有信息栏托底，若不留缓冲输入框会直接贴底，
  //   所以把基准改为 0.75rem(12px)，用 padding 补出与信息栏相当的呼吸空间。
  // 底部 padding 计算：
  // 核心约束：收起/展开态的总底部缓冲必须相等，否则折叠时 inputBoxHeight 变化
  // → bottomPadding 变化 → virtualizer paddingEnd 变化（virtual-core 不补偿 paddingEnd）
  // → dist 平移 → isCollapsed 翻转回 → 振荡闪烁。
  //
  // Footer 的布局高度恒为 h-8=2rem（信息栏内容是否渲染都一样），所以：
  //   展开态总缓冲 = Footer(2rem) + padding = 2rem + max(0, env-2rem) = max(2rem, env)
  //   收起态总缓冲 = 0(无 Footer) + padding → padding 必须 = max(2rem, env)
  //
  // - env ≥ 2rem（iPhone home indicator）：收起 = env，胶囊贴 safe-area 顶，无多截
  // - env < 2rem（PC / 部分 Android）：收起 = 2rem，胶囊与展开态 Footer 位置对齐
  //
  // 但 2rem(32px) 对胶囊来说视觉上离底部太远，下方用 translateY 把收起态内容
  // 整体下移补偿——transform 不影响布局高度，inputBoxHeight 不变，不破坏上述约束。
  const bottomDockPadding = isCollapsed
    ? 'max(2rem, var(--safe-area-inset-bottom, 0px))'
    : 'max(0px, calc(var(--safe-area-inset-bottom, 0px) - 2rem))'
  // 收起态视觉下移：把 2rem 撑出的多余缓冲吃掉，只留 0.75rem(12px) 呼吸空间
  const collapsedVisualOffset = isCollapsed ? 'translateY(calc(2rem - 0.75rem))' : 'none'

  // ---- FAB 模式：收起态回到底部，展开态发送 / 停止（与工具栏共用同一套判定） ----
  // 运行中（isStreaming）且输入框为空即进入停止态，不再排除 isSubmitting：
  // prompt 请求往返期间 isSubmitting 仍为 true，若据此回退到 send 分支，按钮会被
  // disabled 变灰，用户看到「正在运行却点不了停止」。
  const fabMode: ChatFabMode = isCollapsed ? 'scroll' : !canSend && isStreaming ? 'stop' : 'send'
  const fabDisabled = fabMode === 'send' && (!canSend || isSubmitting)
  const handleFabClick = useCallback(() => {
    if (fabMode === 'scroll') {
      // 收起态点击回到底部；没有回底回调时退化为展开输入框。
      if (onScrollToBottom) onScrollToBottom()
      else handleExpandInput()
      return
    }
    if (fabMode === 'stop') {
      onAbort?.()
      return
    }
    handleSend()
  }, [fabMode, handleExpandInput, handleSend, onAbort, onScrollToBottom])

  // ---- 单元素几何变形：输入框本体从圆角矩形「长」成药丸 ----
  //
  // 纯 CSS 过渡驱动 width / height / border-radius（同一条缓动），边框与背景全程
  // 依附在同一个元素上，不存在淡出再出现的切换。
  // 高度是内容驱动的 auto，CSS 无法在 auto 之间插值，所以把展开态高度也钉成
  // 「内容自然高度的像素值」，height 两端就都是确定值、可被 CSS 插值。
  //
  // 关键约束：外层 contentWrap 在收起态用 minHeight 钉住展开高度，composer 只在
  // 里面变形——这样 ChatPane 量到的输入区总高不变，virtualizer 的 bottomPadding
  // 不动，消息列表不会随每一帧的高度变化重排（那是卡顿的主要来源）。
  //
  // 几何过渡只在「收起/展开翻转」期间打开（data-morphing）：平时输入增高需要即时
  // 响应，不能被 480ms 过渡拖住。
  const expandedContentRef = useRef<HTMLDivElement>(null)
  const prevCollapsedRef = useRef(isCollapsed)
  const morphTimerRef = useRef<number | null>(null)
  // 展开态内容的真实宽度，每个展开 commit 记录一次。收起那一帧 DOM 已切到
  // absolute（会收缩到内容宽），当场量不准，所以必须用上一次展开态记下的值。
  const expandedWidthRef = useRef(0)
  // 翻转期间保持 true：外层 contentWrap 用 minHeight 钉住展开高度，composer 只在
  // 里面变形，ChatPane 量到的输入区总高恒定 → virtualizer bottomPadding 不动，
  // 消息列表不会随每一帧的高度变化重排。
  const [isMorphing, setIsMorphing] = useState(false)
  // 收起变形期间把展开内容冻在展开宽度上，避免逐帧收窄导致工具栏 reflow。
  const [morphContentWidth, setMorphContentWidth] = useState(0)
  // 本组件当前是否持有 chatMorph 的降载占用（引用计数），卸载时据此释放。
  const morphClaimRef = useRef(false)
  // 变形世代：每次翻转 +1。收尾信号（transitionend / 兜底定时器）入队时带上
  // 世代号，回来时与 ref 比对，不符即丢弃——防止「收起刚结束就立刻展开」时，
  // 旧过渡入队的 rAF 或旧定时器在新动画刚启动时摘掉 data-morphing（几何瞬跳）。
  // state 镜像用于让过渡监听器随世代重建，closure 不持有过期世代。
  const morphGenerationRef = useRef(0)
  const [morphGeneration, setMorphGeneration] = useState(0)

  useEffect(
    () => () => {
      if (morphTimerRef.current !== null) window.clearTimeout(morphTimerRef.current)
      if (morphClaimRef.current) {
        morphClaimRef.current = false
        setChatMorphing(false)
      }
    },
    [],
  )

  const syncBoxHeight = useCallback(() => {
    const el = inputContainerRef.current
    if (!el) return
    let target: number
    if (isCollapsed) {
      target = COLLAPSED_BOX_HEIGHT
    } else {
      const natural = expandedContentRef.current?.offsetHeight ?? 0
      if (natural <= 0) return
      target = natural + 2 // 上下各 1px 边框
    }
    if (Math.abs(el.offsetHeight - target) > 0.5) el.style.height = `${target}px`
  }, [isCollapsed, inputContainerRef])

  // 变形收尾：摘掉 data-morphing 会把 width/height/border-radius 从 transition
  // 列表里移除。若在几何过渡真正跑完之前摘，正在进行的过渡会被取消、几何直接
  // 瞬跳到终点——表现就是「收起动画没走完」。所以收尾以 transitionend 为准，
  // 定时器只作兜底（几何值没变、没有过渡事件时用）。
  // expectedGeneration 见 morphGenerationRef：只接受当前世代的收尾请求。
  // 收尾时顺带补一次 syncBoxHeight：翻转那一帧若量不到展开内容高度（元素刚切回
  // 文档流），高度会停在上一个态；这里在动画结束后自愈，避免输入框被 overflow
  // 裁成半截。
  const finishMorph = useCallback(
    (expectedGeneration: number) => {
      if (expectedGeneration !== morphGenerationRef.current) return
      if (morphTimerRef.current !== null) {
        window.clearTimeout(morphTimerRef.current)
        morphTimerRef.current = null
      }
      inputContainerRef.current?.removeAttribute('data-morphing')
      setIsMorphing(false)
      if (morphClaimRef.current) {
        morphClaimRef.current = false
        setChatMorphing(false)
      }
      syncBoxHeight()
    },
    [inputContainerRef, syncBoxHeight],
  )

  // 几何过渡结束信号：只听目标元素自身、且只认几何属性，避免 border-color /
  // background-color（360ms）或 transform（480ms）先结束时提前收尾。
  // 三个几何属性共享同一时长与缓动、通常在同一帧结束，用 rAF 合并成一次收尾，
  // 避免只等其中一个（先到者摘掉 data-morphing，其余属性被瞬跳）。
  useEffect(() => {
    if (!isMorphing) return
    const el = inputContainerRef.current
    if (!el) return
    // closure 绑定当前世代：监听器随 morphGeneration 重建，不会拿着过期世代
    // 去处理新过渡的事件（陈旧入队信号直接被 finishMorph 丢弃）。
    const generation = morphGeneration
    let finishFrame: number | null = null
    const scheduleFinish = () => {
      if (finishFrame !== null) cancelAnimationFrame(finishFrame)
      finishFrame = requestAnimationFrame(() => {
        finishFrame = null
        finishMorph(generation)
      })
    }
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target !== el) return
      if (event.propertyName === 'width' || event.propertyName === 'height' || event.propertyName === 'border-radius') {
        scheduleFinish()
      }
    }
    el.addEventListener('transitionend', onTransitionEnd)
    return () => {
      if (finishFrame !== null) cancelAnimationFrame(finishFrame)
      el.removeEventListener('transitionend', onTransitionEnd)
    }
  }, [isMorphing, morphGeneration, finishMorph, inputContainerRef])

  useLayoutEffect(() => {
    const el = inputContainerRef.current
    const toggled = prevCollapsedRef.current !== isCollapsed
    prevCollapsedRef.current = isCollapsed

    // 展开态每个 commit 同步刷新一次内容宽度：收起那一帧 DOM 已切到 absolute，
    // 当场量不准，必须用展开态记下的值；ResizeObserver 是本帧之后才触发的，
    // 首次收起会拿不到，所以这里同步记一次兜底。
    if (!isCollapsed) {
      const inner = expandedContentRef.current
      if (inner && inner.offsetWidth > 0) expandedWidthRef.current = inner.offsetWidth
    }

    if (el && toggled) {
      // 收起方向：用展开态记下的内容宽度把内容冻住，否则容器逐帧收窄会把
      // 工具栏/textarea 一路 reflow，看起来就是不丝滑。
      if (isCollapsed) setMorphContentWidth(expandedWidthRef.current)
      // 新世代：上一世代的收尾信号（transitionend / 兜底定时器 / 已入队的 rAF）
      // 到此全部失效，防止它们在新过渡刚启动时提前摘掉 data-morphing。
      // ref 供 finishMorph 校验，state 驱动监听器重建（closure 不持过期世代）。
      morphGenerationRef.current += 1
      const generation = morphGenerationRef.current
      setMorphGeneration(generation)
      el.setAttribute('data-morphing', '')
      setIsMorphing(true)
      // 变形期间降载：通知虚拟列表降低 overscan，把主线程让给几何动画，
      // 减少快速滚动时的掉帧（毛玻璃由 [data-input-box][data-morphing] 就地关闭）。
      if (!morphClaimRef.current) {
        morphClaimRef.current = true
        setChatMorphing(true)
      }
      if (morphTimerRef.current !== null) window.clearTimeout(morphTimerRef.current)
      // 兜底：万一没有产生 transitionend（几何值恰好没变、或环境不派发过渡事件），
      // 也必须收尾，否则 data-morphing 永久挂着。时长取得比过渡明显长，
      // 保证正常情况下是 transitionend 先到、不会在动画中途被定时器截断。
      morphTimerRef.current = window.setTimeout(() => {
        morphTimerRef.current = null
        finishMorph(generation)
      }, MORPH_FALLBACK_MS)
    }

    // 收起态几何（宽度 / 圆角）与 data-morphing 在同一帧写入：保证宽度过渡先
    // armed 再改值。若交给 CSS [data-collapsed]，属性在 render 阶段就挂上、而
    // data-morphing 到 layout effect 才挂，中间任何一次布局读取触发样式重算时，
    // 宽度会在过渡尚未打开时被定型，表现为横向瞬间收窄、纵向才走动画。展开态清掉
    // 内联值，回到 CSS 的 width:100%。
    if (el) {
      if (isCollapsed) {
        el.style.width = `${COLLAPSED_BOX_WIDTH}px`
        el.style.borderRadius = `${COLLAPSED_BOX_RADIUS}px`
      } else {
        el.style.width = ''
        el.style.borderRadius = ''
      }
    }

    syncBoxHeight()
  }, [isCollapsed, syncBoxHeight, finishMorph, text, attachments.length, inputContainerMaxHeight])

  // 展开态内容变化（增高、变宽、附件、工具栏）时同步容器高度，并记录内容宽度，
  // 供收起时把内容冻住。
  useEffect(() => {
    const inner = expandedContentRef.current
    if (!inner || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (prevCollapsedRef.current) return
      if (inner.offsetWidth > 0) expandedWidthRef.current = inner.offsetWidth
      syncBoxHeight()
    })
    ro.observe(inner)
    return () => ro.disconnect()
  }, [syncBoxHeight])

  return (
    <div className="w-full">
      <div
        className={`mx-auto chat-content-width-transition ${getContentPaddingClass(isCompact)} ${
          isCollapsed ? 'pointer-events-none' : 'pointer-events-auto'
        }`}
        style={{ ...chatContentMaxWidthStyle, paddingBottom: bottomDockPadding }}
      >
        <div
          ref={contentWrapRef}
          onPointerDown={handleContainerPointerDown}
          className={`relative flex flex-col gap-2 ${isCollapsed || isMorphing ? 'justify-end' : ''}`}
          style={{
            // 翻转全程（isMorphing）用固定 height 钉住展开高度：composer 在里面变形、
            // FloatingActions 进出文档流都不会改变外层盒子高度 → ChatPane 量到的
            // inputBoxHeight 恒定 → virtualizer bottomPadding 不动 → 消息列表不重排
            // （卡顿根因）。用 height 而非 minHeight，是因为收起瞬间 FA 回到文档流会把
            // 内容撑高，minHeight 挡不住。超出部分向上溢出，正好让 FA 浮在药丸上方。
            ...(isMorphing && expandedHeightRef.current > 0
              ? { height: expandedHeightRef.current }
              : isCollapsed && expandedHeightRef.current > 0
                ? { minHeight: expandedHeightRef.current }
                : {}),
            maxHeight: composerMaxHeight,
            // 收起态视觉下移；transform 与几何用同一条缓动，展开时平滑归零。
            transform: isCollapsed ? collapsedVisualOffset : 'none',
            transition: 'transform 480ms cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          {/* FloatingActions —
              展开态：absolute 定位在内容区上方，不占文档流，避免显隐变化影响高度导致滚动抖动
              收起态：正常文档流，紧贴变形后的药丸上方
              始终同一 DOM 节点，切换时 FloatingActions 不 remount，避免入场动画闪烁。 */}
          <div
            data-floating-actions
            className={
              isCollapsed
                ? 'flex justify-center pb-2'
                : 'absolute bottom-full left-0 right-0 flex justify-center pb-2 pointer-events-none'
            }
          >
            <div className={isCollapsed ? undefined : 'pointer-events-auto'}>
              <FloatingActions
                canRedo={canRedo}
                revertSteps={revertSteps}
                onRedo={onRedo}
                onRedoAll={onRedoAll}
                collapsedPermission={collapsedPermission}
                collapsedQuestion={collapsedQuestion}
              />
            </div>
          </div>

          {/* Wrapper — 菜单在 glass 容器外，避免嵌套 backdrop-filter 导致模糊失效。
              收起态只做视觉隐藏，不能卸载输入区，否则移动端虚拟键盘会随焦点元素销毁而关闭。
              变形主体是容器本身（见下方 [data-input-box]），这里只负责菜单定位。 */}
          <div className="relative z-30">
            {/* @ Mention Menu */}
            <MentionMenu
              ref={mentionMenuRef}
              isOpen={mentionOpen}
              query={mentionQuery}
              agents={agents}
              rootPath={rootPath}
              excludeValues={excludeValues}
              onSelect={handleMentionSelect}
              onNavigate={updateMentionQuery}
              onClose={handleMentionClose}
            />

            {/* / Slash Command Menu */}
            <SlashCommandMenu
              ref={slashMenuRef}
              isOpen={slashOpen}
              query={slashQuery}
              rootPath={rootPath}
              onSelect={handleSlashSelect}
              onClose={handleSlashClose}
            />

            {/* 大文本粘贴处理选择 */}
            <LargeTextPasteDialog
              isOpen={pendingLargePaste !== null}
              charCount={pendingLargePaste?.length ?? 0}
              onClose={() => setPendingLargePaste(null)}
              onAttach={remember => {
                const value = pendingLargePaste
                setPendingLargePaste(null)
                if (remember) largeTextPasteStore.setBehavior('attach')
                if (value !== null) void applyLargePasteAsAttachment(value)
              }}
              onInline={remember => {
                const value = pendingLargePaste
                setPendingLargePaste(null)
                if (remember) largeTextPasteStore.setBehavior('inline')
                if (value !== null) insertInlineText(value)
              }}
            />

            {/* Input Container + FAB：FAB 锚点宽度跟随输入框（132 ↔ 整列），
                FAB 是锚点的子节点，因此 right 相对输入框右缘解析——
                收起时挂在药丸右侧，展开时滑到输入框右下角。 */}
            <div className="relative">
              {/* 顶边角标（欢迎页项目选择）：做成骑在输入框顶边的「标签」——
                  底边与输入框顶边重合、只保留上方圆角，与输入框连成一体。 */}
              {topAccessory && (
                <div className="absolute left-6 bottom-full z-40 -mb-px">{topAccessory}</div>
              )}
              <div className="chat-fab-anchor" data-collapsed={isCollapsed}>
                <ChatFab
                  collapsed={isCollapsed}
                  mode={fabMode}
                  sending={isSubmitting}
                  disabled={fabDisabled}
                  onClick={handleFabClick}
                />
              </div>
              <div
                ref={inputContainerRef}
                data-input-box
                data-collapsed={isCollapsed ? '' : undefined}
                data-pane-id={paneId}
                onClick={isCollapsed ? handleExpandInput : undefined}
                onPointerDown={handleContainerPointerDown}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`glass rounded-2xl relative overflow-hidden focus-within:outline-none shadow-lg ${
                  isCollapsed ? 'pointer-events-auto' : ''
                } ${
                  isDragging || isInternalFileDragging
                    ? 'border border-accent-main-100 ring-2 ring-accent-main-100/30'
                    : isStreaming
                      ? 'border border-accent-main-100/50 animate-border-pulse'
                      : 'border border-border-200/60'
                }`}
                style={{ maxHeight: isCollapsed ? undefined : inputContainerMaxHeight }}
              >
                {/* Drop overlay */}
                {(isDragging || isInternalFileDragging) && (
                  <div className="absolute inset-0 z-50 rounded-2xl bg-accent-main-100/5 backdrop-blur-[1px] flex items-center justify-center pointer-events-none">
                    <span className="text-[length:var(--fs-base)] text-accent-main-100 font-medium">
                      {t('inputBox.dropFilesHere')}
                    </span>
                  </div>
                )}

                {/* 收起态内容层：固定尺寸 + 居中，绝对定位不参与尺寸变化，只切 opacity。
                  收起时立即淡入（与展开层的淡出交叉），展开时快速淡出。 */}
                <div
                  aria-hidden={!isCollapsed || undefined}
                  className={`absolute inset-0 flex items-center justify-center gap-1.5 text-text-300 pointer-events-none transition-opacity ${
                    isCollapsed ? 'opacity-100 duration-200' : 'opacity-0 duration-[120ms]'
                  }`}
                >
                  <ArrowUpIcon size={14} />
                  <span className="text-[length:var(--fs-xs)] whitespace-nowrap">{t('inputActions.reply')}</span>
                </div>

                {/* 展开态内容层：收起时绝对定位 + 冻结展开宽度 + 居中，容器收缩时由
                  overflow-hidden 把文字裁掉，同时淡出——不参与尺寸变化，因此不会逐帧
                  重排，也不会突然消失。展开时等容器长完（delay）再浮现。 */}
                <div
                  ref={expandedContentRef}
                  aria-hidden={isCollapsed || undefined}
                  inert={isCollapsed || undefined}
                  className={`transition-opacity ${
                    isCollapsed
                      ? 'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 pointer-events-none duration-[180ms]'
                      : 'relative opacity-100 delay-[220ms] duration-200'
                  }`}
                  style={
                    isMorphing && isCollapsed && morphContentWidth > 0
                      ? { width: `${morphContentWidth}px`, contain: 'layout style' }
                      : undefined
                  }
                >
                  <div className="overflow-hidden">
                    {/* Attachments Preview - 显示在输入框上方 */}
                    <div
                      ref={attachmentSectionRef}
                      className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${
                        attachments.length > 0 ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                      }`}
                    >
                      <div className="overflow-hidden">
                        <div className="px-4 pt-3 pb-1">
                          <div className="relative">
                            <div
                              ref={attachmentRailRef}
                              onScroll={syncAttachmentRailState}
                              onWheel={handleAttachmentRailWheel}
                              className="overflow-x-auto overflow-y-hidden overscroll-x-contain no-scrollbar touch-pan-x"
                              style={{ WebkitOverflowScrolling: 'touch' }}
                            >
                              <AttachmentPreview
                                attachments={attachments}
                                onRemove={handleRemoveAttachment}
                                variant="rail"
                                className={isSubmitting ? 'pr-4 pointer-events-none opacity-70' : 'pr-4'}
                              />
                            </div>

                            {attachmentsOverflowing && showAttachmentLeftFade && (
                              <div className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-bg-000/50 to-transparent" />
                            )}

                            {attachmentsOverflowing && showAttachmentRightFade && (
                              <div className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-bg-000/50 to-transparent" />
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Text Input - 简单的 textarea，直接显示文本 */}
                    <div className="pt-4 pb-2">
                      <textarea
                        ref={textareaRef}
                        value={text}
                        onChange={handleChange}
                        onKeyDown={handleKeyDown}
                        onCompositionStart={handleCompositionStart}
                        onCompositionEnd={handleCompositionEnd}
                        onPaste={handlePaste}
                        onScroll={handleScroll}
                        onFocus={handleFocus}
                        onBlur={handleBlur}
                        disabled={inputDisabled}
                        placeholder={isCompact ? t('inputBox.replyToAgentMobile') : t('inputBox.replyToAgent')}
                        className={`w-full resize-none focus:outline-none focus:ring-0 bg-transparent text-text-100 placeholder:text-text-400 custom-scrollbar ${isCompact ? 'px-3' : 'px-4'}`}
                        style={{
                          ...TEXT_STYLE,
                          minHeight: '24px',
                          maxHeight: textareaMaxHeight,
                        }}
                        rows={1}
                      />
                    </div>

                    {/* Bottom Bar -> InputToolbar */}
                    <div ref={toolbarRef}>
                      <InputToolbar
                        agents={agents}
                        selectedAgent={selectedAgent}
                        onAgentChange={onAgentChange}
                        variants={variants}
                        selectedVariant={selectedVariant}
                        onVariantChange={onVariantChange}
                        fileCapabilities={fileCaps}
                        onFilesSelected={handleFilesSelected}
                        isSending={isSubmitting}
                        models={models}
                        selectedModelKey={selectedModelKey}
                        onModelChange={onModelChange}
                        modelsLoading={modelsLoading}
                        inputContainerRef={inputContainerRef}
                        modelSelectorRef={modelSelectorRef}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer: 常驻 DOM，收起用 hidden。避免 isCollapsed 抖一下时卸载整行（自动放行/免责声明闪烁）。
            布局高度恒为 h-8（不随信息栏显隐变化）——它是底部缓冲不变量的一半，
            收起/展开总高必须相等，否则 inputBoxHeight 跳变、消息区跟着跳。
            信息栏内容本身按设置/欢迎态条件渲染：
            - 欢迎态（hideFooter）：空会话没有 token/任务统计；
            - 设置项 showInputStatusBar 关闭（默认）：用户不想看这条信息栏。 */}
        <div
          ref={footerRef}
          onPointerDown={handleContainerPointerDown}
          className={`h-8 ${isCollapsed ? 'hidden' : 'flex items-center justify-center'}`}
          aria-hidden={isCollapsed || undefined}
        >
          {!hideFooter && showInputStatusBar && (
            <InputFooter paneId={paneId} sessionId={sessionId} inputContainerRef={inputContainerRef} />
          )}
        </div>
      </div>
    </div>
  )
}

// ============================================
// Export with memo for performance optimization
// ============================================

export const InputBox = memo(InputBoxComponent)
