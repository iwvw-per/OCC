import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ModelsSettings } from './ModelsSettings'
import type { ModelInfo } from '../../../api'

const { useModelsMock, useHiddenModelKeysMock, useHiddenProviderNamesMock, setVisibleMock, setProviderVisibleMock } = vi.hoisted(() => ({
  useModelsMock: vi.fn(),
  useHiddenModelKeysMock: vi.fn(),
  useHiddenProviderNamesMock: vi.fn(),
  setVisibleMock: vi.fn(),
  setProviderVisibleMock: vi.fn(),
}))

vi.mock('../../../hooks', () => ({
  useModels: useModelsMock,
}))

vi.mock('../../../store', () => ({
  modelVisibilityStore: {
    setVisible: setVisibleMock,
    setManyVisible: vi.fn(),
    setProviderVisible: setProviderVisibleMock,
  },
  useHiddenModelKeys: useHiddenModelKeysMock,
  useHiddenProviderNames: useHiddenProviderNamesMock,
}))

vi.mock('../../../utils/modelUtils', () => ({
  getModelKey: (model: ModelInfo) => `${model.providerId}:${model.id}`,
  groupModelsByProvider: (models: ModelInfo[]) => [
    {
      providerName: 'OpenAI',
      models,
    },
  ],
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

describe('ModelsSettings', () => {
  beforeEach(() => {
    useModelsMock.mockReturnValue({ models: MODELS, isLoading: false })
    useHiddenModelKeysMock.mockReturnValue([])
    useHiddenProviderNamesMock.mockReturnValue([])
    setVisibleMock.mockReset()
    setProviderVisibleMock.mockReset()
  })

  it('renders model rows with semantic buttons and labeled switches', () => {
    render(<ModelsSettings />)

    const modelButton = screen.getByRole('button', { name: /GPT-4.1/i })
    const modelSwitch = screen.getByRole('switch', { name: 'Hide GPT-4.1' })

    expect(modelSwitch).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(modelButton)

    expect(modelButton).toHaveAttribute('aria-pressed', 'true')
    expect(setVisibleMock).toHaveBeenCalledWith(MODELS[0], false)
  })

  it('keeps the whole model row clickable outside the text button and switch', () => {
    render(<ModelsSettings />)

    const modelButton = screen.getByRole('button', { name: /GPT-4.1/i })
    const modelRow = modelButton.parentElement

    expect(modelRow).not.toBeNull()

    fireEvent.click(modelRow!)

    expect(setVisibleMock).toHaveBeenCalledWith(MODELS[0], false)
  })

  it('reflects each model visibility state', () => {
    useHiddenModelKeysMock.mockReturnValue(['openai:gpt-4.1'])

    render(<ModelsSettings />)

    expect(screen.getByRole('switch', { name: 'Show GPT-4.1' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('switch', { name: 'Hide GPT-4o Mini' })).toHaveAttribute('aria-checked', 'true')
  })

  it('shows the endpoint count and toggles the endpoint itself from the left column', () => {
    useHiddenModelKeysMock.mockReturnValue(['openai:gpt-4o-mini'])
    useHiddenProviderNamesMock.mockReturnValue(['OpenAI'])

    render(<ModelsSettings />)

    expect(screen.getByText('1/2')).toBeInTheDocument()

    const endpointToggle = screen.getByRole('switch', { name: /OpenAI · Enable endpoint/ })
    expect(endpointToggle).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(endpointToggle)
    expect(setProviderVisibleMock).toHaveBeenCalledWith('OpenAI', true)
  })
})
