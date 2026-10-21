// ============================================
// 错误文案解析
// ============================================
//
// 从 MessageErrorView 里拆出来：组件文件只导出组件（Fast Refresh 要求），
// 而这个纯函数需要被单测直接调用。

import type { MessageError } from '../../../types/message'

/**
 * 解析错误信息
 */
export function getErrorInfo(
  error: MessageError,
  t: (key: string, opts?: Record<string, unknown>) => string,
): {
  title: string
  description: string
  details?: string
  severity: 'error' | 'warning'
} {
  switch (error.name) {
    case 'ProviderAuthError':
      return {
        title: t('errors.authError'),
        description: t('errors.authErrorDesc', { provider: error.data.providerID, message: error.data.message }),
        severity: 'error',
      }

    case 'MessageOutputLengthError':
      return {
        title: t('errors.outputTooLong'),
        description: t('errors.outputTooLongDesc'),
        severity: 'warning',
      }

    case 'MessageAbortedError':
      return {
        title: t('errors.messageAborted'),
        description: error.data.message || t('errors.messageAbortedDesc'),
        severity: 'warning',
      }

    case 'APIError': {
      /**
       * 413：请求体过大。
       *
       * 这个错误对用户完全不可理解：他只是发了「继续」两个字，却收到
       * 「http: request body too large」。真实原因在**服务端上下文**里 ——
       * 例如 AI 用 read 工具读了几张截图，每张 2MB 的 base64 内联进工具结果，
       * 累计十几 MB，再发给模型时被上游网关（GeneralMaxSize = 16MB）拒掉。
       *
       * 前端无法清掉那些图片（它们只存在于服务端会话历史），但必须把
       * 「为什么」和「怎么办」讲清楚，而不是丢一串英文。
       */
      if (error.data.statusCode === 413) {
        return {
          title: t('errors.payloadTooLarge'),
          description: t('errors.payloadTooLargeDesc'),
          details: error.data.message,
          severity: 'warning',
        }
      }
      return {
        title: error.data.statusCode
          ? t('errors.apiErrorWithCode', { code: error.data.statusCode })
          : t('errors.apiError'),
        description: error.data.message,
        details: error.data.responseBody,
        severity: error.data.isRetryable ? 'warning' : 'error',
      }
    }

    case 'UnknownError':
    default:
      return {
        title: t('errors.unknownError'),
        description: error.data?.message || t('errors.unknownErrorDesc'),
        severity: 'error',
      }
  }
}
