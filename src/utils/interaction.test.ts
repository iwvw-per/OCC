import { describe, expect, it } from 'vitest'
import { resolveHapticTarget } from './interaction'

describe('resolveHapticTarget', () => {
  it('finds the nearest pressable ancestor and defaults to light', () => {
    const outer = document.createElement('button')
    const inner = document.createElement('span')
    outer.appendChild(inner)
    document.body.appendChild(outer)

    expect(resolveHapticTarget(inner)).toEqual({ element: outer, strength: 'light' })

    document.body.innerHTML = ''
  })

  it('ignores disabled elements', () => {
    const button = document.createElement('button')
    button.setAttribute('disabled', '')
    document.body.appendChild(button)
    expect(resolveHapticTarget(button)).toBeNull()

    const ariaDisabled = document.createElement('div')
    ariaDisabled.setAttribute('role', 'button')
    ariaDisabled.setAttribute('aria-disabled', 'true')
    document.body.appendChild(ariaDisabled)
    expect(resolveHapticTarget(ariaDisabled)).toBeNull()

    document.body.innerHTML = ''
  })

  it('returns null for non-element targets', () => {
    expect(resolveHapticTarget(null)).toBeNull()
  })

  it('does not treat a content container with only an onClick as pressable', () => {
    const container = document.createElement('div')
    container.setAttribute('onclick', 'void 0')
    const text = document.createElement('span')
    container.appendChild(text)
    document.body.appendChild(container)

    expect(resolveHapticTarget(text)).toBeNull()

    document.body.innerHTML = ''
  })

  it('reads an explicit data-haptic strength', () => {
    const row = document.createElement('div')
    row.setAttribute('data-haptic', 'medium')
    document.body.appendChild(row)

    expect(resolveHapticTarget(row)).toEqual({ element: row, strength: 'medium' })

    document.body.innerHTML = ''
  })

  it('stops at a data-haptic="none" ancestor', () => {
    const zone = document.createElement('div')
    zone.setAttribute('data-haptic', 'none')
    const inner = document.createElement('span')
    zone.appendChild(inner)
    document.body.appendChild(zone)

    expect(resolveHapticTarget(inner)).toBeNull()

    document.body.innerHTML = ''
  })

  it('still fires for a real control nested inside a data-haptic="none" zone', () => {
    const zone = document.createElement('div')
    zone.setAttribute('data-haptic', 'none')
    const button = document.createElement('button')
    zone.appendChild(button)
    document.body.appendChild(zone)

    expect(resolveHapticTarget(button)).toEqual({ element: button, strength: 'light' })

    document.body.innerHTML = ''
  })
})
