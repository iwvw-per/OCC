import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageError } from '../../../types/message'
import { getErrorInfo } from './errorInfo'
import { AlertCircleIcon, ChevronDownIcon } from '../../../components/Icons'
import { useCompositorExpand, useDisclosureScrollLock } from '../../../hooks'
import { CodeBlock } from '../../../components/CodeBlock'
import { useUiDisclosureState } from '../../../utils/uiDisclosureState'
import { MessageExpandPanel } from '../messageExpand'
import { chevronClass, useMessageExpandRender } from '../messageExpandShared'

interface MessageErrorViewProps {
  error: MessageError
  stateKey?: string
}

/**
 * 消息级别的错误显示（紧凑折叠式）
 * 用于 AssistantMessage 的 error 字段
 */
export const MessageErrorView = memo(function MessageErrorView({ error, stateKey }: MessageErrorViewProps) {
  const { t } = useTranslation('message')
  const { title, description, details, severity } = getErrorInfo(error, t)
  const hasDetails = !!(details || description)
  const [expanded, setExpanded] = useUiDisclosureState(stateKey ?? `message-error:${title}`, false)
  // Android expand: 展开用 max-height 假高度，避免 WebView 在 grid-rows 动画中画空白。
  const {
    contentRef: errorExpandContentRef,
    layoutOpen: errorLayoutOpen,
    keepMounted: errorKeepMounted,
    panelClassName: errorPanelClassName,
  } = useCompositorExpand(expanded)
  const shouldRenderBody = useMessageExpandRender(errorKeepMounted)
  const { rootRef, headerRef, withScrollLock } = useDisclosureScrollLock()

  const rawDiagnostics = error.name === 'APIError' ? error.data.metadata?.rawDiagnostics : undefined
  const [showRawDiagnostics, setShowRawDiagnostics] = useUiDisclosureState(
    `${stateKey ?? `message-error:${title}`}:raw-diagnostics`,
    false,
  )
  const {
    contentRef: rawDiagContentRef,
    layoutOpen: rawDiagLayoutOpen,
    keepMounted: rawDiagKeepMounted,
    panelClassName: rawDiagPanelClassName,
  } = useCompositorExpand(showRawDiagnostics)
  const shouldRenderRawDiagnostics = useMessageExpandRender(rawDiagKeepMounted)

  const colorClass = severity === 'error' ? 'text-danger-100' : 'text-warning-100'
  const borderClass = severity === 'error' ? 'border-danger-100/20' : 'border-warning-100/20'

  // details 如果是 JSON 就格式化方便阅读，否则原样展示
  const formattedDetails = useMemo(() => {
    if (!details) return undefined
    try {
      return JSON.stringify(JSON.parse(details), null, 2)
    } catch {
      return details
    }
  }, [details])

  // 检测 details 是否为 JSON，决定 CodeBlock 语言
  const detailsLang = useMemo(() => {
    if (!details) return 'text'
    try {
      JSON.parse(details)
      return 'json'
    } catch {
      return 'text'
    }
  }, [details])

  return (
    <div ref={rootRef} className={`px-3 py-2 rounded-md border ${borderClass} bg-bg-100/50`}>
      <div
        ref={headerRef}
        className={`flex items-center gap-2 ${hasDetails ? 'cursor-pointer' : ''}`}
        onClick={() => hasDetails && withScrollLock(() => setExpanded(!expanded))}
      >
        <AlertCircleIcon className={`w-4 h-4 ${colorClass} flex-shrink-0`} />
        <span className={`text-[length:var(--fs-base)] ${colorClass} flex-1 min-w-0 truncate`}>{title}</span>
        {hasDetails && <ChevronDownIcon className={chevronClass(expanded)} />}
      </div>

      <MessageExpandPanel
        open={errorLayoutOpen}
        variant="fade"
        panelClassName={errorPanelClassName}
        contentRef={errorExpandContentRef}
        innerClassName="overflow-hidden"
      >
        {shouldRenderBody && (
          <div className={`mt-2 pt-2 space-y-1.5 border-t ${borderClass}`}>
            <p className="text-[length:var(--fs-sm)] text-text-300 break-words">{description}</p>
            {formattedDetails && <CodeBlock code={formattedDetails} language={detailsLang} maxHeight={240} />}
            {rawDiagnostics && (
              <div>
                <button
                  type="button"
                  className="flex items-center gap-1 text-[length:var(--fs-sm)] text-text-400 hover:bg-bg-200 hover:border-border-200 border border-transparent rounded px-1 cursor-pointer"
                  onClick={() => withScrollLock(() => setShowRawDiagnostics(!showRawDiagnostics))}
                >
                  <ChevronDownIcon className={chevronClass(showRawDiagnostics)} />
                  <span>{t('errors.rawDiagnostics')}</span>
                </button>
                <MessageExpandPanel
                  open={rawDiagLayoutOpen}
                  variant="fade"
                  panelClassName={rawDiagPanelClassName}
                  contentRef={rawDiagContentRef}
                  innerClassName="overflow-hidden"
                >
                  {shouldRenderRawDiagnostics && (
                    <CodeBlock code={rawDiagnostics} language="text" maxHeight={240} />
                  )}
                </MessageExpandPanel>
              </div>
            )}
          </div>
        )}
      </MessageExpandPanel>
    </div>
  )
})

