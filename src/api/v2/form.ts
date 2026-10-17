// ============================================
// v2 OMO Form → v1 QuestionRequest 适配
//
// OMO 用 Form 体系取代 v1 的 question：事件是 form.created（{ id, sessionID,
// title, fields }），列表是 client.form.list（FormInfo[]）。前端沿用 InlineQuestion
// 的 Q&A 卡片，这里把 fields 转成 questions[]，并内嵌 fieldKey/fieldType 供回复时
// 映射回 form answer（见 permission.ts 的 answersToFormAnswer）。
// 本模块只做纯映射，不发请求。
// ============================================

import { rec, str, list } from './adapt'

/** OMO form field → v1 QuestionInfo（内嵌 fieldKey/fieldType）。 */
export function formFieldToQuestion(field: unknown): Record<string, unknown> | undefined {
  const f = rec(field)
  const key = str(f.key)
  const type = str(f.type)
  if (!key) return undefined
  const title = str(f.title) ?? key
  // 选项直接取 value 当展示文案（FormOption.value 通常是可直接回填的值），
  // 回复时无需再做 label→value 二次映射。
  const options: Array<{ label: string; description?: string }> = []
  for (const o of list(f.options)) {
    const r = rec(o)
    const label = str(r.value) ?? str(r.label) ?? ''
    if (!label) continue
    options.push({ label, description: str(r.description) })
  }
  const base = { header: title, question: title, fieldKey: key, fieldType: type }
  switch (type) {
    case 'multiselect':
      return { ...base, options, multiple: true, custom: f.custom !== false }
    case 'boolean':
      return { ...base, options: [{ label: 'true' }, { label: 'false' }], multiple: false, custom: false }
    case 'number':
    case 'integer':
    default:
      return { ...base, options, multiple: false, custom: true }
  }
}

/** fields[] → questions[]（跳过无效字段）。 */
export function formFieldsToQuestions(fields: unknown): Array<Record<string, unknown>> {
  return list(fields)
    .map(formFieldToQuestion)
    .filter((q): q is Record<string, unknown> => !!q)
}

/** 把 OMO Form（{ id, sessionID, title, fields }）适配成 v1 QuestionRequest 形状。 */
export function adaptFormToQuestionRequest(form: unknown): Record<string, unknown> {
  const f = rec(form)
  return { ...f, questions: formFieldsToQuestions(f.fields) }
}
