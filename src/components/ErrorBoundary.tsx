import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from './ui/Button'
import { globalErrorHandler } from '../utils/errorHandling'
import { cn } from '../utils/cn'
import i18n from '../i18n'

/**
 * 错误边界的呈现档位:
 * - full:整页兜底(应用根),原行为
 * - panel:面板内居中卡片(侧栏 / 右侧面板 / 会话区),不铺满整页
 * - inline:内嵌卡片,用于嵌套在内容里的小区域
 * - compact:单行小条,用于密集工具栏
 * - silent:不渲染任何兜底,仅上报(用于可选装饰区域)
 */
export type ErrorBoundaryVariant = 'full' | 'panel' | 'inline' | 'compact' | 'silent'

interface ErrorBoundaryProps {
  children: ReactNode
  onOpenSettings?: () => void
  variant?: ErrorBoundaryVariant
  /** 变化时自动清除已捕获的错误(如切换 session / 服务器后重挂载子树) */
  resetKeys?: readonly unknown[]
  /** 上报用作用域标识,便于定位崩溃来源 */
  scope?: string
  className?: string
}

interface ErrorBoundaryState {
  error: Error | null
}

function haveResetKeysChanged(prev?: readonly unknown[], next?: readonly unknown[]): boolean {
  if (prev === next) return false
  if (!prev || !next) return true
  if (prev.length !== next.length) return true
  for (let i = 0; i < prev.length; i++) {
    if (!Object.is(prev[i], next[i])) return true
  }
  return false
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    globalErrorHandler(
      this.props.scope ? `render error (${this.props.scope})` : 'render error',
      error,
      false,
      info.componentStack,
    )
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (this.state.error && haveResetKeysChanged(prevProps.resetKeys, this.props.resetKeys)) {
      this.setState({ error: null })
    }
  }

  private handleRetry = () => {
    this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    const variant = this.props.variant ?? 'full'
    const message = error.message || i18n.t('common:errorBoundary.renderFailed')

    if (variant === 'silent') return null

    if (variant === 'compact') {
      return (
        <div
          className={cn(
            'flex items-center gap-2 rounded-md border border-danger-100/25 bg-danger-bg/60 px-2 py-1 text-ui-xs text-text-200',
            this.props.className,
          )}
        >
          <span className="min-w-0 flex-1 truncate">{message}</span>
          <button
            type="button"
            onClick={this.handleRetry}
            className="shrink-0 font-medium text-danger-100 hover:underline"
          >
            {i18n.t('common:errorBoundary.tryAgain')}
          </button>
        </div>
      )
    }

    if (variant === 'inline') {
      return (
        <div className={cn('rounded-lg border border-danger-100/25 bg-danger-bg/60 p-3', this.props.className)}>
          <div className="text-ui-caption font-medium text-danger-100">{i18n.t('common:errorBoundary.title')}</div>
          <div className="mt-1 text-ui-sm text-text-200">{message}</div>
          <button
            type="button"
            onClick={this.handleRetry}
            className="mt-2 rounded-md border border-border-200 px-2 py-1 text-ui-sm font-medium text-text-200 hover:bg-bg-200"
          >
            {i18n.t('common:errorBoundary.tryAgain')}
          </button>
        </div>
      )
    }

    const shellClass =
      variant === 'panel'
        ? 'flex h-full min-h-0 items-center justify-center overflow-y-auto bg-bg-100 p-4 text-text-100'
        : 'h-full min-h-0 overflow-y-auto bg-bg-000 px-5 pb-40 pt-24 text-text-100'

    return (
      <div className={cn(shellClass, this.props.className)}>
        <div className="mx-auto w-full max-w-2xl space-y-3">
          <div className="rounded-2xl border border-danger-100/25 bg-danger-bg/60 p-4 shadow-sm">
            <div className="mb-2 text-ui-lg font-semibold text-danger-100">{i18n.t('common:errorBoundary.title')}</div>
            <div className="text-ui-caption leading-relaxed text-text-200">{message}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            {this.props.onOpenSettings && (
              <Button type="button" onClick={this.props.onOpenSettings}>
                {i18n.t('common:errorBoundary.openSettings')}
              </Button>
            )}
            <button
              type="button"
              onClick={this.handleRetry}
              className="rounded-lg border border-border-200 px-3 py-2 text-ui-caption font-medium text-text-200 hover:bg-bg-200"
            >
              {i18n.t('common:errorBoundary.tryAgain')}
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg border border-border-200 px-3 py-2 text-ui-caption font-medium text-text-200 hover:bg-bg-200"
            >
              {i18n.t('common:errorBoundary.reload')}
            </button>
          </div>
        </div>
      </div>
    )
  }
}

/** 局部错误边界:与 ErrorBoundary 同实现,用于按故障域包裹面板/区域。 */
export const ScopedErrorBoundary = ErrorBoundary
