import { useEffect, type RefObject } from 'react'
import { useBackClose } from './useBackClose'

const FOCUSABLE_SELECTOR =
  'button:not([disabled]):not([tabindex="-1"]), [href]:not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'

function hasNestedModalOpen(): boolean {
  if (typeof document === 'undefined') return false
  return !!document.querySelector('[role="dialog"][aria-modal="true"][data-dialog-open="true"]')
}

interface UseOverlayDialogA11yOptions {
  isOpen: boolean
  onClose: () => void
  containerRef: RefObject<HTMLElement | null>
}

export function useOverlayDialogA11y({ isOpen, onClose, containerRef }: UseOverlayDialogA11yOptions) {
  useBackClose(isOpen, onClose)

  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (hasNestedModalOpen()) return

      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }

      if (event.key !== 'Tab') return

      const container = containerRef.current
      if (!container) return

      const focusable = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (event.shiftKey) {
        if (document.activeElement === first || !container.contains(document.activeElement)) {
          event.preventDefault()
          last.focus()
        }
      } else if (document.activeElement === last || !container.contains(document.activeElement)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose, containerRef])
}
