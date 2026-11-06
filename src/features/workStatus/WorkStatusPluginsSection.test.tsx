import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { workStatusStore } from '../../store/workStatusStore'
import type { PluginStatus } from '../../types/api/plugin'

const getPluginStatus = vi.fn<() => Promise<PluginStatus[]>>()

vi.mock('../../api/plugin', () => ({
  getPluginStatus: () => getPluginStatus(),
  invalidatePluginStatus: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { WorkStatusPluginsSection } from './WorkStatusSections'

function plugin(overrides: Partial<PluginStatus> & Pick<PluginStatus, 'id'>): PluginStatus {
  return {
    id: overrides.id,
    source: overrides.source ?? { type: 'local', path: `/plugins/${overrides.id}.ts` },
    features: overrides.features ?? { server: true, tui: false, rpc: false },
    state: overrides.state ?? { status: 'active' },
  }
}

function renderSection() {
  return render(
    <WorkStatusPluginsSection sessionId="s1" directory="/proj" contextLimit={0} onScrollToMessage={() => {}} />,
  )
}

describe('WorkStatusPluginsSection', () => {
  beforeEach(() => {
    localStorage.clear()
    workStatusStore.setSectionExpanded('plugins', true)
    getPluginStatus.mockReset()
  })

  /**
   * 核心行为：内置插件必须被过滤掉。
   * 本机实测 93 个里 90 个是 builtin，平铺会把面板撑满、把需要关注的信息挤没。
   */
  it('hides builtin plugins and keeps user-configured ones', async () => {
    getPluginStatus.mockResolvedValue([
      plugin({ id: 'opencode.agent', source: { type: 'builtin' } }),
      plugin({ id: 'opencode-bg' }),
      plugin({ id: 'open-code-review' }),
    ])

    renderSection()

    await waitFor(() => expect(screen.getByText('opencode-bg')).toBeInTheDocument())
    expect(screen.getByText('open-code-review')).toBeInTheDocument()
    expect(screen.queryByText('opencode.agent')).not.toBeInTheDocument()
  })

  it('renders nothing when only builtin plugins are loaded', async () => {
    getPluginStatus.mockResolvedValue([
      plugin({ id: 'opencode.agent', source: { type: 'builtin' } }),
      plugin({ id: 'opencode.plan', source: { type: 'builtin' } }),
    ])

    const { container } = renderSection()

    await waitFor(() => expect(getPluginStatus).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('surfaces failed plugins first and marks them', async () => {
    getPluginStatus.mockResolvedValue([
      plugin({ id: 'healthy' }),
      plugin({ id: 'broken', state: { status: 'failed', error: 'boom', ref: '/p/broken.ts:3' } }),
    ])

    renderSection()

    await waitFor(() => expect(screen.getByText('broken')).toBeInTheDocument())
    // 失败项标红
    expect(screen.getByText('workStatus.plugin.failed')).toBeInTheDocument()
    // 标题聚合值：1 个失败 / 共 2 个
    expect(screen.getByText('1/2')).toBeInTheDocument()
  })

  it('flags an outdated package instead of showing its version', async () => {
    getPluginStatus.mockResolvedValue([
      plugin({
        id: 'foo',
        source: { type: 'package', target: 'foo@1.0.0', version: '1.0.0', outdated: true },
      }),
    ])

    renderSection()

    await waitFor(() => expect(screen.getByText('workStatus.plugin.outdated')).toBeInTheDocument())
    expect(screen.queryByText('1.0.0')).not.toBeInTheDocument()
  })

  /**
   * 读取失败时板块静默消失，而不是变成一条用户无法处理的报错。
   * 插件状态是辅助信息，不能因此污染面板。
   */
  it('renders nothing instead of an error row when the request fails', async () => {
    getPluginStatus.mockRejectedValue(new Error('network down'))

    const { container } = renderSection()

    await waitFor(() => expect(getPluginStatus).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
