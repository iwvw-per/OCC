import { describe, expect, it } from 'vitest'
import { resolveHapticTarget, resolvePressTarget } from './interaction'

describe('resolvePressTarget', () => {
  it('finds the nearest pressable ancestor for touch and defaults to light', () => {
    const outer = document.createElement('button')
    const inner = document.createElement('span')
    outer.appendChild(inner)
    document.body.appendChild(outer)

    expect(resolvePressTarget(inner, 'touch')).toEqual({ element: outer, strength: 'light' })

    document.body.innerHTML = ''
  })

  it('ignores non-touch pointer types', () => {
    const button = document.createElement('button')
    document.body.appendChild(button)

    expect(resolvePressTarget(button, 'mouse')).toBeNull()
    expect(resolvePressTarget(button, 'pen')).toBeNull()

    document.body.innerHTML = ''
  })

  it('ignores disabled elements', () => {
    const button = document.createElement('button')
    button.setAttribute('disabled', '')
    document.body.appendChild(button)
    expect(resolvePressTarget(button, 'touch')).toBeNull()

    const ariaDisabled = document.createElement('div')
    ariaDisabled.setAttribute('role', 'button')
    ariaDisabled.setAttribute('aria-disabled', 'true')
    document.body.appendChild(ariaDisabled)
    expect(resolvePressTarget(ariaDisabled, 'touch')).toBeNull()

    document.body.innerHTML = ''
  })

  it('returns null for non-element targets', () => {
    expect(resolvePressTarget(null, 'touch')).toBeNull()
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
