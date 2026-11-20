import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ModelSelector } from './ModelSelector'
import type { ModelInfo } from '../../api'

vi.mock('../../components/ui', () => ({
  DropdownMenu: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div>{children}</div> : null,
}))

const inputCapabilities = vi.hoisted(() => ({ canHover: false, preferTouchUi: false }))

vi.mock('../../hooks/useInputCapabilities', () => ({
  useInputCapabilities: () => ({
    preferTouchUi: inputCapabilities.preferTouchUi,
    canHover: inputCapabilities.canHover,
  }),
}))

vi.mock('../../utils/modelUtils', () => ({
  getModelKey: (model: ModelInfo) => `${model.providerId}:${model.id}`,
  groupModelsByProvider: (models: ModelInfo[]) => {
    const groups = new Map<string, { providerId: string; providerName: string; models: ModelInfo[] }>()
    for (const model of models) {
      const group = groups.get(model.providerId) ?? {
        providerId: model.providerId,
        providerName: model.providerName,
        models: [],
      }
      group.models.push(model)
      groups.set(model.providerId, group)
    }
    return [...groups.values()]
  },
  recordModelUsage: vi.fn(),
}))

const MODELS: ModelInfo[] = [
  {
    id: 'gpt-4.1',
    name: 'GPT-4.1',
    providerId: 'openai',
    providerName: 'OpenAI',
    family: 'gpt',
    contextLimit: 128000,
    inputLimit: 0,
    outputLimit: 32000,
    supportsReasoning: true,
    supportsImages: true,
    supportsPdf: true,
    supportsAudio: false,
    supportsVideo: false,
    supportsToolcall: true,
    variants: [],
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    providerId: 'openai',
    providerName: 'OpenAI',
    family: 'gpt',
    contextLimit: 128000,
    inputLimit: 0,
    outputLimit: 16000,
    supportsReasoning: false,
    supportsImages: true,
    supportsPdf: true,
    supportsAudio: false,
    supportsVideo: false,
    supportsToolcall: true,
    variants: [],
  },
]

describe('ModelSelector', () => {
  it('opens menu and selects a model', () => {
    const onSelect = vi.fn()

    render(<ModelSelector models={MODELS} selectedModelKey={'openai:gpt-4.1'} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: /^GPT-4\.1/ }))
    fireEvent.click(screen.getByText('GPT-4o Mini'))

    expect(onSelect).toHaveBeenCalledWith('openai:gpt-4o-mini', expect.objectContaining({ name: 'GPT-4o Mini' }))
  })

  it('always shows the endpoint row, even with a single provider', () => {
    render(<ModelSelector models={MODELS} selectedModelKey={'openai:gpt-4.1'} onSelect={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /^GPT-4\.1/ }))

    const endpointButton = screen.getByRole('button', { name: /Endpoint/ })
    expect(endpointButton).toHaveTextContent('OpenAI')
  })

  it('no longer renders a search box, pin buttons, or context length', () => {
    render(<ModelSelector models={MODELS} selectedModelKey={'openai:gpt-4.1'} onSelect={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /^GPT-4\.1/ }))

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Pin to top|Unpin/ })).not.toBeInTheDocument()
    expect(screen.queryByText('128k')).not.toBeInTheDocument()
  })

  it('opens from ArrowUp at the last model', async () => {
    render(<ModelSelector models={MODELS} selectedModelKey={'openai:gpt-4.1'} onSelect={vi.fn()} />)

    const trigger = screen.getByRole('button', { name: /^GPT-4\.1/ })
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })

    const lastOption = document.getElementById('ms-item-1') as HTMLButtonElement | null
    await waitFor(() => expect(lastOption).toHaveFocus())
  })

  it('returns focus to the toolbar input after selecting a model', async () => {
    const onSelect = vi.fn()

    function ToolbarSelectorHarness() {
      const containerRef = useRef<HTMLDivElement>(null)

      return (
        <div ref={containerRef}>
          <textarea aria-label="Chat input" />
          <ModelSelector
            models={MODELS}
            selectedModelKey={'openai:gpt-4.1'}
            onSelect={onSelect}
            trigger="toolbar"
            constrainToRef={containerRef}
          />
        </div>
      )
    }

    render(<ToolbarSelectorHarness />)

    fireEvent.click(screen.getByRole('button', { name: /^GPT-4\.1/ }))
    fireEvent.click(screen.getByText('GPT-4o Mini'))

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Chat input' })).toHaveFocus())
    expect(onSelect).toHaveBeenCalledWith('openai:gpt-4o-mini', expect.objectContaining({ name: 'GPT-4o Mini' }))
  })

  it('switches the thinking level with the merged slider', () => {
    const onVariantChange = vi.fn()

    render(
      <ModelSelector
        models={MODELS}
        selectedModelKey={'openai:gpt-4.1'}
        onSelect={vi.fn()}
        variants={['low', 'high']}
        selectedVariant="low"
        onVariantChange={onVariantChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /^GPT-4\.1/ }))
    expect(screen.getByText('Thinking level')).toBeInTheDocument()

    const slider = screen.getByRole('slider', { name: 'Thinking level' })
    // 档位序列为 [Default, low, high],拖到最后一档应切到 high。
    fireEvent.change(slider, { target: { value: '2' } })

    expect(onVariantChange).toHaveBeenCalledWith('high')
  })

  it('opens the endpoint submenu to the right and switches endpoints', () => {
    const anthropicModel: ModelInfo = {
      ...MODELS[0],
      id: 'claude-sonnet-4-5',
      name: 'Claude Sonnet 4.5',
      providerId: 'anthropic',
      providerName: 'Anthropic',
    }

    render(
      <ModelSelector models={[...MODELS, anthropicModel]} selectedModelKey={'openai:gpt-4.1'} onSelect={vi.fn()} />,
    )

    fireEvent.click(screen.getByRole('button', { name: /^GPT-4\.1/ }))

    // 默认只展示当前模型所属端点
    expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    expect(screen.queryByText('Claude Sonnet 4.5')).not.toBeInTheDocument()

    const endpointButton = screen.getByRole('button', { name: /Endpoint/ })
    fireEvent.click(endpointButton)

    // 端点列表是右侧浮层,不替换模型列表
    expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: /Anthropic/ }))

    expect(screen.getByText('Claude Sonnet 4.5')).toBeInTheDocument()
    expect(screen.queryByText('GPT-4o Mini')).not.toBeInTheDocument()
  })

  it('shows a loading indicator instead of the chevron and disables the trigger while models load', () => {
    render(<ModelSelector models={[]} selectedModelKey={null} onSelect={vi.fn()} isLoading />)

    const trigger = screen.getByRole('button')
    expect(trigger).toBeDisabled()
    expect(trigger.querySelector('[data-loading-indicator="true"]')).not.toBeNull()
  })

  it('swaps the loading indicator back to the chevron once models are available', () => {
    const { rerender } = render(<ModelSelector models={[]} selectedModelKey={null} onSelect={vi.fn()} isLoading />)
    expect(document.querySelector('[data-loading-indicator="true"]')).not.toBeNull()

    rerender(<ModelSelector models={MODELS} selectedModelKey={'openai:gpt-4.1'} onSelect={vi.fn()} />)

    const trigger = screen.getByRole('button')
    expect(trigger).not.toBeDisabled()
    expect(trigger.querySelector('[data-loading-indicator="true"]')).toBeNull()
  })

  it('keeps the chevron when models are loaded but nothing is selected', () => {
    render(<ModelSelector models={MODELS} selectedModelKey={null} onSelect={vi.fn()} />)

    const trigger = screen.getByRole('button')
    expect(trigger).not.toBeDisabled()
    expect(trigger.querySelector('[data-loading-indicator="true"]')).toBeNull()
  })

  it('keeps capability icons beside the name and the check mark in its own trailing column', () => {
    render(<ModelSelector models={MODELS} selectedModelKey={'openai:gpt-4.1'} onSelect={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /^GPT-4\.1/ }))

    const selectedItem = document.querySelector('[data-model-key="openai:gpt-4.1"]') as HTMLElement
    const cells = Array.from(selectedItem.children)

    expect(cells).toHaveLength(3)
    expect(cells[0]).toHaveTextContent('GPT-4.1')
    expect(cells[1].querySelectorAll('[data-model-capability]')).toHaveLength(2)
    expect(cells[2].className).toContain('ml-auto')
    expect(cells[2].querySelector('svg')).not.toBeNull()

    const unselectedItem = document.querySelector('[data-model-key="openai:gpt-4o-mini"]') as HTMLElement
    const unselectedCheckColumn = Array.from(unselectedItem.children)[2]

    expect(unselectedCheckColumn.className).toContain('ml-auto')
    expect(unselectedCheckColumn.querySelector('svg')).toBeNull()
  })

  it('opens the endpoint list on hover when the pointer supports hover', () => {
    inputCapabilities.canHover = true

    try {
      render(<ModelSelector models={MODELS} selectedModelKey={'openai:gpt-4.1'} onSelect={vi.fn()} />)

      fireEvent.click(screen.getByRole('button', { name: /^GPT-4\.1/ }))
      expect(screen.queryByRole('option', { name: /OpenAI/ })).not.toBeInTheDocument()

      fireEvent.mouseEnter(screen.getByRole('button', { name: /Endpoint/ }))

      expect(screen.getByRole('option', { name: /OpenAI/ })).toBeInTheDocument()
    } finally {
      inputCapabilities.canHover = false
    }
  })

  it('does not focus the composer input on touch after selecting a model', async () => {
    inputCapabilities.preferTouchUi = true

    try {
      const Harness = () => {
        const constrainToRef = useRef<HTMLDivElement>(null)
        return (
          <div>
            <div ref={constrainToRef}>
              <textarea data-testid="composer" />
            </div>
            <ModelSelector
              models={MODELS}
              selectedModelKey={'openai:gpt-4.1'}
              onSelect={vi.fn()}
              trigger="toolbar"
              constrainToRef={constrainToRef}
            />
          </div>
        )
      }

      render(<Harness />)

      fireEvent.click(screen.getByRole('button', { name: /^GPT-4\.1/ }))
      fireEvent.click(screen.getByText('GPT-4o Mini'))

      await new Promise(resolve => setTimeout(resolve, 0))
      expect(screen.getByTestId('composer')).not.toHaveFocus()
    } finally {
      inputCapabilities.preferTouchUi = false
    }
  })
})
