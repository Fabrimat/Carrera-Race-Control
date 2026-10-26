import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { ControllerFields } from './ControllerFields'
import { useStore } from '../lib/store'
import type { ControllerSettings } from '../lib/types'

function Harness({
  initial,
  mode,
  spy,
}: {
  initial: ControllerSettings
  mode: 'car' | 'driver'
  spy: (v: ControllerSettings) => void
}) {
  const [v, setV] = useState(initial)
  return (
    <ControllerFields
      value={v}
      mode={mode}
      testId="c"
      presets
      onChange={(n) => {
        setV(n)
        spy(n)
      }}
    />
  )
}

const empty: ControllerSettings = { speed: null, brake: null, fuel: null }

describe('ControllerFields', () => {
  beforeEach(() => useStore.setState({ language: 'en' }))

  it('shows unset fields with a disabled slider and the CU wording', () => {
    render(<Harness initial={empty} mode="car" spy={vi.fn()} />)
    expect(screen.getByTestId('c-speed-value')).toHaveTextContent('Unset (CU value)')
    expect(screen.getByTestId('c-speed-slider')).toBeDisabled()
    expect(screen.getByTestId('c-speed-toggle')).not.toBeChecked()
    expect(screen.getByText(/still to be verified/)).toBeInTheDocument()
  })

  it('switching a field on sets a value, the slider edits it, switching off returns to null', () => {
    const spy = vi.fn()
    render(<Harness initial={empty} mode="car" spy={spy} />)
    fireEvent.click(screen.getByTestId('c-brake-toggle'))
    expect(spy).toHaveBeenLastCalledWith({ speed: null, brake: 8, fuel: null })
    const slider = screen.getByTestId('c-brake-slider') as HTMLInputElement
    expect(slider).toBeEnabled()
    expect(slider.min).toBe('0')
    expect(slider.max).toBe('15')
    fireEvent.change(slider, { target: { value: '3' } })
    expect(spy).toHaveBeenLastCalledWith({ speed: null, brake: 3, fuel: null })
    expect(screen.getByTestId('c-brake-value')).toHaveTextContent('3')
    fireEvent.click(screen.getByTestId('c-brake-toggle'))
    expect(spy).toHaveBeenLastCalledWith(empty)
  })

  it('a value of 0 is a value, not unset', () => {
    render(<Harness initial={{ speed: 0, brake: null, fuel: null }} mode="car" spy={vi.fn()} />)
    expect(screen.getByTestId('c-speed-toggle')).toBeChecked()
    expect(screen.getByTestId('c-speed-value')).toHaveTextContent('0')
  })

  it('presets fill the three values and clear unsets them', () => {
    const spy = vi.fn()
    render(<Harness initial={empty} mode="car" spy={spy} />)
    fireEvent.click(screen.getByTestId('c-preset-kid'))
    const kid = spy.mock.calls[0][0] as ControllerSettings
    expect(kid.speed).not.toBeNull()
    expect(kid.brake).not.toBeNull()
    expect(kid.fuel).not.toBeNull()
    expect(kid.speed).toBeLessThan(15)
    fireEvent.click(screen.getByTestId('c-preset-pro'))
    expect((spy.mock.calls[1][0] as ControllerSettings).speed).toBe(15)
    fireEvent.click(screen.getByTestId('c-clear'))
    expect(spy).toHaveBeenLastCalledWith(empty)
  })

  it('driver mode says inherit instead of unset', () => {
    render(<Harness initial={{ speed: 9, brake: null, fuel: null }} mode="driver" spy={vi.fn()} />)
    expect(screen.getByTestId('c-speed-value')).toHaveTextContent('9')
    expect(screen.getByTestId('c-brake-value')).toHaveTextContent("Inherit (car's value)")
    expect(screen.getByTestId('c-clear')).toHaveTextContent('Inherit all')
  })

  it('is keyboard accessible: labelled checkbox and slider', () => {
    render(<Harness initial={{ speed: 5, brake: null, fuel: null }} mode="car" spy={vi.fn()} />)
    expect(screen.getByRole('checkbox', { name: 'Set Speed' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Speed' })).toHaveValue('5')
  })
})
