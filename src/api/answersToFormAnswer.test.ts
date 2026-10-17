import { describe, expect, it } from 'vitest'
import { answersToFormAnswer } from './permission'

describe('answersToFormAnswer', () => {
  it('maps string / multiselect / boolean / number answers back to field keys', () => {
    const fields = [
      { key: 'env', type: 'string' },
      { key: 'tags', type: 'multiselect' },
      { key: 'debug', type: 'boolean' },
      { key: 'port', type: 'integer' },
    ]
    const answers = [['prod'], ['a', 'b'], ['true'], ['8080']]

    expect(answersToFormAnswer(answers, fields)).toEqual({
      env: 'prod',
      tags: ['a', 'b'],
      debug: true,
      port: 8080,
    })
  })

  it('defaults missing answers per field type', () => {
    const fields = [{ key: 'env', type: 'string' }, { key: 'debug', type: 'boolean' }, { key: 'tags', type: 'multiselect' }]
    expect(answersToFormAnswer([], fields)).toEqual({ env: '', debug: false, tags: [] })
  })
})
