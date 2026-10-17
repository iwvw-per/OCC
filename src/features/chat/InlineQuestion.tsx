/**
 * InlineQuestion — 融入信息流的提问交互
 *
 * 紧凑的 inline 卡片，选项清晰，自定义输入居中对齐。
 */

import { memo, useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckIcon, QuestionIcon, TimerIcon } from '../../components/Icons'
import { ApprovalCard } from '../../components/ui/ApprovalCard'
import type { ApiQuestionRequest, ApiQuestionInfo, QuestionAnswer } from '../../api'
import { keybindingStore, matchesKeybinding } from '../../store/keybindingStore'
import { useQuestionAutoSelect } from '../../hooks/useQuestionAutoSelect'
import { buildAutoSelectAnswers, canAutoSelect } from '../../utils/questionAutoSelect'

interface InlineQuestionProps {
  request: ApiQuestionRequest
  onReply: (requestId: string, answers: QuestionAnswer[]) => void
  onReject: (requestId: string) => void
  isReplying: boolean
}

export const InlineQuestion = memo(function InlineQuestion({
  request,
  onReply,
  onReject,
  isReplying,
}: InlineQuestionProps) {
  const { t } = useTranslation(['chat', 'common'])

  // 兜底：任何来源的请求都必须带 questions 数组（v2 表单已由事件层转成 questions）。
  // 缺省时按空卡片渲染，绝不因 questions 为 undefined 崩溃。
  const questions = useMemo(() => (Array.isArray(request.questions) ? request.questions : []), [request.questions])

  const [answers, setAnswers] = useState<Map<number, Set<string>>>(() => {
    const map = new Map<number, Set<string>>()
    questions.forEach((_, idx) => map.set(idx, new Set()))
    return map
  })

  const [customEnabled, setCustomEnabled] = useState<Map<number, boolean>>(() => {
    const map = new Map<number, boolean>()
    questions.forEach((_, idx) => map.set(idx, false))
    return map
  })

  const [customValues, setCustomValues] = useState<Map<number, string>>(() => {
    const map = new Map<number, string>()
    questions.forEach((_, idx) => map.set(idx, ''))
    return map
  })

  const selectOption = useCallback((qIdx: number, label: string) => {
    setAnswers(prev => {
      const m = new Map(prev)
      m.set(qIdx, new Set([label]))
      return m
    })
    setCustomEnabled(prev => {
      const m = new Map(prev)
      m.set(qIdx, false)
      return m
    })
  }, [])

  const selectCustom = useCallback((qIdx: number) => {
    setAnswers(prev => {
      const m = new Map(prev)
      m.set(qIdx, new Set())
      return m
    })
    setCustomEnabled(prev => {
      const m = new Map(prev)
      m.set(qIdx, true)
      return m
    })
  }, [])

  const toggleOption = useCallback((qIdx: number, label: string) => {
    setAnswers(prev => {
      const m = new Map(prev)
      const s = new Set(prev.get(qIdx) || [])
      if (s.has(label)) s.delete(label)
      else s.add(label)
      m.set(qIdx, s)
      return m
    })
  }, [])

  const toggleCustom = useCallback((qIdx: number) => {
    setCustomEnabled(prev => {
      const m = new Map(prev)
      m.set(qIdx, !prev.get(qIdx))
      return m
    })
  }, [])

  const updateCustomValue = useCallback((qIdx: number, value: string) => {
    setCustomValues(prev => {
      const m = new Map(prev)
      m.set(qIdx, value)
      return m
    })
  }, [])

  const handleSubmit = useCallback(() => {
    const result: QuestionAnswer[] = questions.map((q, idx) => {
      const selected = Array.from(answers.get(idx) || [])
      const isCustom = customEnabled.get(idx)
      const customValue = customValues.get(idx)?.trim()
      if (q.multiple) {
        return isCustom && customValue && q.custom !== false ? [...selected, customValue] : selected
      }
      return isCustom && customValue ? [customValue] : selected
    })
    onReply(request.id, result)
  }, [request, questions, answers, customEnabled, customValues, onReply])

  const handleAutoSelect = useCallback(() => {
    if (canAutoSelect(request)) {
      onReply(request.id, buildAutoSelectAnswers(request))
    } else {
      onReject(request.id)
    }
  }, [request, onReply, onReject])

  const autoSelectRemaining = useQuestionAutoSelect(request.id, handleAutoSelect, !isReplying)

  const canSubmit = questions.every((_q, idx) => {
    const selected = answers.get(idx) || new Set()
    const isCustom = customEnabled.get(idx)
    const customValue = customValues.get(idx)?.trim()
    return selected.size > 0 || (isCustom && !!customValue)
  })

  const totalQuestions = questions.length
  const isPaged = totalQuestions > 1
  const [page, setPage] = useState(0)
  const safePage = Math.min(page, totalQuestions - 1)
  const answeredCount = questions.reduce((acc, _q, idx) => {
    const selected = answers.get(idx) || new Set()
    const isCustom = customEnabled.get(idx)
    const customValue = customValues.get(idx)?.trim()
    return acc + (selected.size > 0 || (isCustom && !!customValue) ? 1 : 0)
  }, 0)
  const isLastPage = safePage >= totalQuestions - 1
  const goPrev = useCallback(() => setPage(p => Math.max(0, p - 1)), [])
  const goNext = useCallback(() => setPage(p => Math.min(totalQuestions - 1, p + 1)), [totalQuestions])

  // 键盘快捷键：和主输入框一致的 send keybinding 提交，Escape 跳过
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onReject(request.id)
        return
      }
      const sendKey = keybindingStore.getKey('sendMessage')
      if (sendKey && matchesKeybinding(e.nativeEvent, sendKey)) {
        e.preventDefault()
        if (canSubmit && !isReplying) {
          handleSubmit()
        }
      }
    },
    [onReject, request.id, canSubmit, isReplying, handleSubmit],
  )

  return (
    <ApprovalCard
      className="border-border-300/70 focus-within:border-accent-main-100/80"
      header={
        <>
          <QuestionIcon size={14} className="shrink-0 text-text-400" />
          <span className="font-medium text-text-300">{t('chat:questionDialog.title')}</span>
          {isPaged && (
            <span className="ml-auto flex items-center gap-1.5">
              <span className="tabular-nums text-[length:var(--fs-xxs)] text-text-500">
                {t('chat:questionDialog.pageOf', { current: safePage + 1, total: totalQuestions })}
              </span>
              <span className="flex items-center gap-1">
                {questions.map((_q, idx) => (
                  <span
                    key={idx}
                    className={`size-1 rounded-full transition-colors ${
                      idx === safePage
                        ? 'bg-text-300'
                        : (answers.get(idx) || new Set()).size > 0
                          ? 'bg-text-500'
                          : 'bg-border-300'
                    }`}
                  />
                ))}
              </span>
            </span>
          )}
        </>
      }
      footer={
        <>
          {isPaged && (
            <button
              onClick={goPrev}
              disabled={safePage === 0 || isReplying}
              className="px-2.5 h-7 rounded-md text-[length:var(--fs-sm)] text-text-400 hover:bg-bg-200 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {t('common:previous')}
            </button>
          )}
          {isPaged && !isLastPage ? (
            <button
              onClick={goNext}
              disabled={isReplying}
              className="px-2.5 h-7 rounded-md text-[length:var(--fs-sm)] font-medium bg-text-100 text-bg-000 hover:bg-text-200 transition-colors disabled:opacity-50"
            >
              {t('common:next')}
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={!canSubmit || isReplying}
              data-haptic="medium"
              className="px-2.5 h-7 rounded-md text-[length:var(--fs-sm)] font-medium bg-text-100 text-bg-000 hover:bg-text-200 transition-colors disabled:opacity-50"
            >
              {t('common:submit')}
            </button>
          )}
          <button
            onClick={() => onReject(request.id)}
            disabled={isReplying}
            data-haptic="strong"
            className="px-2.5 h-7 rounded-md text-[length:var(--fs-sm)] text-text-400 hover:bg-bg-200 transition-colors disabled:opacity-50"
          >
            {t('common:skip')}
          </button>
          {autoSelectRemaining !== null && (
            <span className="ml-auto inline-flex items-center gap-1 tabular-nums text-[length:var(--fs-xxs)] text-text-500">
              <TimerIcon size={12} className="shrink-0" />
              {t('chat:questionDialog.autoSelectIn', { seconds: autoSelectRemaining })}
            </span>
          )}
          {isPaged && (
            <span
              className={`${autoSelectRemaining === null ? 'ml-auto' : ''} tabular-nums text-[length:var(--fs-xxs)] text-text-500`}
            >
              {t('chat:questionDialog.answeredCount', { done: answeredCount, total: totalQuestions })}
            </span>
          )}
        </>
      }
    >
      <div className="space-y-3" onKeyDown={handleKeyDown}>
        {(isPaged ? [questions[safePage]] : questions).map((question, i) => {
          const qIdx = isPaged ? safePage : i
          return (
            <InlineQuestionItem
              key={qIdx}
              question={question}
              selected={answers.get(qIdx) || new Set()}
              isCustomEnabled={customEnabled.get(qIdx) || false}
              customValue={customValues.get(qIdx) || ''}
              onSelectOption={label => selectOption(qIdx, label)}
              onSelectCustom={() => selectCustom(qIdx)}
              onToggleOption={label => toggleOption(qIdx, label)}
              onToggleCustom={() => toggleCustom(qIdx)}
              onCustomValueChange={value => updateCustomValue(qIdx, value)}
            />
          )
        })}
      </div>
    </ApprovalCard>
  )
})

// ============================================
// InlineQuestionItem
// ============================================

interface InlineQuestionItemProps {
  question: ApiQuestionInfo
  selected: Set<string>
  isCustomEnabled: boolean
  customValue: string
  onSelectOption: (label: string) => void
  onSelectCustom: () => void
  onToggleOption: (label: string) => void
  onToggleCustom: () => void
  onCustomValueChange: (value: string) => void
}

function InlineQuestionItem({
  question,
  selected,
  isCustomEnabled,
  customValue,
  onSelectOption,
  onSelectCustom,
  onToggleOption,
  onToggleCustom,
  onCustomValueChange,
}: InlineQuestionItemProps) {
  const { t } = useTranslation('chat')
  const isMultiple = question.multiple || false
  const allowCustom = question.custom !== false
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (isCustomEnabled && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [isCustomEnabled])

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 100)}px`
    }
  }, [])

  return (
    <div className="space-y-2">
      {/* 问题文字 */}
      <div>
        {question.header && (
          <div className="text-[length:var(--fs-xs)] text-text-400 font-medium mb-0.5">{question.header}</div>
        )}
        <div className="text-[length:var(--fs-md)] text-text-100">{question.question}</div>
      </div>

      {/* 选项 — 紧凑按钮组；勾选框用首行高度容器对齐，不随换行拉伸 */}
      <div className="flex flex-wrap gap-1.5">
        {question.options.map((option, idx) => {
          const isSelected = selected.has(option.label)
          return (
            <button
              key={idx}
              onClick={() => (isMultiple ? onToggleOption(option.label) : onSelectOption(option.label))}
              title={option.description}
              className={`inline-flex min-h-7 items-start gap-1.5 px-2.5 py-1 text-[length:var(--fs-sm)] leading-5 rounded-md transition-colors border ${
                isSelected ? 'bg-bg-200 text-text-100 border-border-200' : 'text-text-300 hover:bg-bg-200 border-transparent'
              }`}
            >
              {isMultiple && (
                <span className="inline-flex h-5 w-3.5 shrink-0 items-center justify-center">
                  <span
                    className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors ${
                      isSelected ? 'border-text-100 bg-text-100 text-bg-000' : 'border-border-300'
                    }`}
                  >
                    {isSelected && <CheckIcon size={10} className="shrink-0" />}
                  </span>
                </span>
              )}
              <span className="min-w-0 whitespace-normal break-words text-left">{option.label}</span>
            </button>
          )
        })}
      </div>

      {/* 自定义输入 — 与选项同高同边距，勾选框对齐首行 */}
      {allowCustom && (
        <div
          onClick={() => {
            if (!isCustomEnabled) {
              if (isMultiple) onToggleCustom()
              else onSelectCustom()
            }
          }}
          className={`flex min-h-7 items-start gap-1.5 rounded-md px-2.5 py-1 transition-colors ${
            isCustomEnabled ? 'bg-bg-200' : 'hover:bg-bg-200'
          }`}
        >
          {isMultiple && (
            <span className="inline-flex h-5 w-3.5 shrink-0 items-center justify-center">
              <span
                className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors ${
                  isCustomEnabled ? 'border-text-100 bg-text-100 text-bg-000' : 'border-border-300'
                }`}
              >
                {isCustomEnabled && <CheckIcon size={10} className="shrink-0" />}
              </span>
            </span>
          )}
          <textarea
            ref={textareaRef}
            value={customValue}
            onChange={e => {
              onCustomValueChange(e.target.value)
              adjustHeight()
            }}
            onClick={e => {
              e.stopPropagation()
              if (!isCustomEnabled) {
                if (isMultiple) onToggleCustom()
                else onSelectCustom()
              }
            }}
            placeholder={t('questionDialog.typeYourAnswer')}
            rows={1}
            className="min-h-5 flex-1 resize-none bg-transparent py-0 text-[length:var(--fs-sm)] leading-5 text-text-100 placeholder:text-text-500 focus:outline-none"
          />
        </div>
      )}
    </div>
  )
}
