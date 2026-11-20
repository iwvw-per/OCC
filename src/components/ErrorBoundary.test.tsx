import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary, ScopedErrorBoundary } from './ErrorBoundary'

vi.mock('../utils/errorHandling', () => ({ globalErrorHandler: vi.fn() }))

function Boom(): never {
  throw new Error('boom')
}

function Toggle({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('boom')
  return <div>ok</div>
}

describe('ErrorBoundary', () => {
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <div>ok</div>
      </ErrorBoundary>,
    )
    expect(screen.getByText('ok')).toBeInTheDocument()
  })

  it('renders the fallback with the error message when a child throws', () => {
    render(
      <ErrorBoundary variant="panel">
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByText('boom')).toBeInTheDocument()
  })

  it('renders nothing for the silent variant', () => {
    const { container } = render(
      <ErrorBoundary variant="silent">
        <Boom />
      </ErrorBoundary>,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the inline and compact variants with the error message', () => {
    const { unmount } = render(
      <ErrorBoundary variant="inline">
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByText('boom')).toBeInTheDocument()
    unmount()

    render(
      <ErrorBoundary variant="compact">
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByText('boom')).toBeInTheDocument()
  })

  it('clears the captured error when resetKeys change', () => {
    const { rerender } = render(
      <ErrorBoundary resetKeys={[1]}>
        <Toggle shouldThrow />
      </ErrorBoundary>,
    )
    expect(screen.getByText('boom')).toBeInTheDocument()

    rerender(
      <ErrorBoundary resetKeys={[2]}>
        <Toggle shouldThrow={false} />
      </ErrorBoundary>,
    )
    expect(screen.getByText('ok')).toBeInTheDocument()
  })

  it('keeps the error when resetKeys are unchanged', () => {
    const { rerender } = render(
      <ErrorBoundary resetKeys={[1]}>
        <Toggle shouldThrow />
      </ErrorBoundary>,
    )
    rerender(
      <ErrorBoundary resetKeys={[1]}>
        <Toggle shouldThrow />
      </ErrorBoundary>,
    )
    expect(screen.queryByText('ok')).not.toBeInTheDocument()
    expect(screen.getByText('boom')).toBeInTheDocument()
  })

  it('exposes ScopedErrorBoundary as the same implementation', () => {
    expect(ScopedErrorBoundary).toBe(ErrorBoundary)
  })
})
