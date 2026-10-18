import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getCommands } from './command'

const listMock = vi.fn()

let skillList: unknown[] = []

vi.mock('../store/serverStore', () => ({
  serverStore: {
    getActiveServerId: () => 'test-server',
  },
}))

vi.mock('./skill', () => ({
  getSkills: async () => skillList,
}))

vi.mock('./v2NativeCommand', () => ({
  nativeListCommands: async () => {
    const r = await listMock()
    return Array.isArray(r) ? r : (r?.data ?? [])
  },
  nativeListSkills: async () => skillList,
}))

describe('getCommands', () => {
  beforeEach(() => {
    listMock.mockReset()
    skillList = []
  })

  it('marks frontend and api commands with stable sources', async () => {
    listMock.mockResolvedValue({ data: [{ name: 'review', description: 'Run project review' }] })

    const commands = await getCommands('/workspace/project')

    expect(commands).toEqual([
      { name: 'review', description: 'Run project review', source: 'api' },
      { name: 'new', description: 'Create a new chat session', source: 'frontend' },
      { name: 'compact', description: 'Compact session by summarizing conversation history', source: 'frontend' },
    ])
  })

  it('keeps API commands as api commands even if names overlap frontend commands', async () => {
    listMock.mockResolvedValue({ data: [{ name: 'compact', description: 'Native compact command' }] })

    const commands = await getCommands('/workspace/project-overlap')

    expect(commands).toEqual([
      { name: 'compact', description: 'Native compact command', source: 'api' },
      { name: 'new', description: 'Create a new chat session', source: 'frontend' },
    ])
  })

  it('合并 slash skill 到命令面板', async () => {
    listMock.mockResolvedValue({ data: [{ name: 'init', description: 'Init project' }] })
    skillList = [
      { name: 'prototype', description: 'Build a throwaway prototype' },
      { name: 'init', description: 'clash with api command name' },
    ]

    const commands = await getCommands('/workspace/v2-project')

    // 纯命令 + 合并的 skill（与纯命令重名的 skill 被去重）
    expect(commands).toContainEqual({ name: 'prototype', description: 'Build a throwaway prototype', source: 'api' })
    // init 已在 api 命令里，skill 同名不再重复
    expect(commands.filter(c => c.name === 'init')).toHaveLength(1)
    expect(commands.some(c => c.name === 'new')).toBe(true)
  })
})
