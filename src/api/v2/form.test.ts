import { describe, expect, it } from 'vitest'
import { adaptFormToQuestionRequest, formFieldsToQuestions } from './form'

describe('adaptFormToQuestionRequest', () => {
  it('turns OMO form fields into questions with fieldKey/fieldType', () => {
    const q = adaptFormToQuestionRequest({
      id: 'f1',
      sessionID: 's',
      title: 'Deploy?',
      fields: [
        { key: 'env', type: 'string', title: 'Env', options: [{ value: 'prod', label: 'Production' }] },
        { key: 'force', type: 'boolean', title: 'Force' },
      ],
    })

    expect(q.id).toBe('f1')
    expect(q.sessionID).toBe('s')
    const questions = q.questions as Array<Record<string, unknown>>
    expect(questions).toHaveLength(2)
    expect(questions[0]).toMatchObject({ header: 'Env', fieldKey: 'env', fieldType: 'string' })
    expect(questions[1]).toMatchObject({ fieldKey: 'force', fieldType: 'boolean', multiple: false })
  })

  it('skips fields without a key', () => {
    const questions = formFieldsToQuestions([{ key: 'a', type: 'string', title: 'A' }, { type: 'string' }])
    expect(questions).toHaveLength(1)
    expect(questions[0]).toMatchObject({ fieldKey: 'a' })
  })

  it('normalizes a bare form object without fields to an empty questions array', () => {
    const q = adaptFormToQuestionRequest({ id: 'f2', sessionID: 's', title: 'x' })
    expect(Array.isArray(q.questions)).toBe(true)
    expect((q.questions as unknown[]).length).toBe(0)
  })
})
