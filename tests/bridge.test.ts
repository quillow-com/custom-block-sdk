// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createCustomBlockHost } from '../src/host.js'
import { createCustomBlockSDK } from '../src/index.js'
import { message, type BlockContext } from '../src/protocol.js'

const context = (): BlockContext => ({
  theme: {
    mode: 'light',
    cornerStyle: 'Normal',
    variables: { '--quillow-accent-color': '#ff0000', '--quillow-typography': 'Inter, sans-serif' },
    fontStylesheet: 'https://fonts.googleapis.com/css2?family=Inter',
  },
  layout: { size: '1:1', width: 156, height: 156, viewport: 'desktop' },
  environment: 'editor',
})

const parent = { postMessage: vi.fn() } as unknown as Window
const parentOrigin = 'https://app.example.com'
let sdk: ReturnType<typeof createCustomBlockSDK>

function deliver(data: unknown, origin = parentOrigin, source: Window = parent) {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source }))
}

beforeEach(() => {
  Object.defineProperty(window, 'parent', { configurable: true, value: parent })
  sdk = createCustomBlockSDK()
})

afterEach(() => {
  sdk.destroy()
  document.documentElement.removeAttribute('style')
  document.body.innerHTML = ''
  Object.defineProperty(window, 'parent', { configurable: true, value: window })
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('widget bridge', () => {
  it('isolates replay errors and returns an unsubscribe function for failing subscribers', () => {
    const error = new Error('Render failed')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = vi.fn(() => {
      throw error
    })
    const healthy = vi.fn()

    sdk.start()
    deliver(message('context', context()))

    const unsubscribe = sdk.subscribe(failing)

    expect(log).toHaveBeenCalledWith('[Quillow SDK] Subscriber failed', error)
    sdk.subscribe(healthy)
    deliver(message('context', context()))
    expect(failing).toHaveBeenCalledTimes(2)
    expect(healthy).toHaveBeenCalledTimes(2)

    unsubscribe()
    deliver(message('context', context()))
    expect(failing).toHaveBeenCalledTimes(2)
    expect(healthy).toHaveBeenCalledTimes(3)
  })

  it('handshakes without a referrer, applies theme, and delivers responsive updates without reloading', async () => {
    const ready = sdk.ready()

    expect(parent.postMessage).toHaveBeenCalledWith(message('ready'), '*')
    deliver(message('context', context()))
    expect((await ready).layout.size).toBe('1:1')
    expect(document.documentElement.style.getPropertyValue('--quillow-accent-color')).toBe(
      '#ff0000'
    )
    expect(document.querySelector('link')?.href).toBe(context().theme.fontStylesheet)

    const listener = vi.fn()
    const unsubscribe = sdk.subscribe(listener)

    expect(listener).toHaveBeenCalledTimes(1)

    const next = context()

    deliver(
      message('context', {
        ...next,
        theme: {
          ...next.theme,
          mode: 'dark',
          fontStylesheet: null,
          variables: { '--quillow-accent-color': '#000000' },
        },
        layout: { size: '2:1', width: 336, height: 156, viewport: 'mobile' },
      })
    )
    expect(listener).toHaveBeenCalledTimes(2)
    expect(document.documentElement.dataset.quillowViewport).toBe('mobile')
    expect(document.documentElement.dataset.quillowSize).toBe('2:1')
    expect(document.documentElement.dataset.quillowTheme).toBe('dark')
    expect(document.documentElement.style.getPropertyValue('--quillow-typography')).toBe('')
    expect(document.querySelector('link')).toBeNull()
    expect(Object.isFrozen(sdk.getContext()?.theme.variables)).toBe(true)
    unsubscribe()
    deliver(message('context', context()))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('rejects wrong windows, pinned origins, protocol versions and malformed contexts', () => {
    sdk.destroy()
    sdk = createCustomBlockSDK({ parentOrigin })

    const listener = vi.fn()

    sdk.subscribe(listener)
    deliver(message('context', context()), parentOrigin, window)
    deliver(message('context', context()), 'https://other.example.com')
    deliver({ ...message('context', context()), version: 2 })
    deliver({ ...message('context'), context: { theme: {} } })

    const invalid = context()

    deliver(
      message('context', { ...invalid, theme: { ...invalid.theme, variables: { color: 'red' } } })
    )
    deliver(message('context', { ...invalid, layout: { ...invalid.layout, width: NaN } }))
    expect(listener).not.toHaveBeenCalled()
    deliver(message('context', context()))
    expect(listener).toHaveBeenCalledOnce()
  })

  it('pins a discovered parent origin and responds to hello after a late host attachment', () => {
    sdk.start()
    deliver(message('hello'))
    expect(parent.postMessage).toHaveBeenLastCalledWith(message('ready'), parentOrigin)
    deliver(message('context', context()), 'https://other.example.com')
    expect(sdk.getContext()).toBeUndefined()
    deliver(message('context', context()))
    expect(sdk.getContext()).toBeDefined()
  })

  it('restores existing styles and attributes and removes listeners on destroy', () => {
    document.documentElement.style.setProperty('--quillow-accent-color', 'blue')
    document.documentElement.dataset.quillowTheme = 'original'
    sdk.start()
    deliver(message('context', context()))
    sdk.destroy()
    expect(document.documentElement.style.getPropertyValue('--quillow-accent-color')).toBe('blue')
    expect(document.documentElement.dataset.quillowTheme).toBe('original')
    expect(document.querySelector('link')).toBeNull()
    deliver(message('context', context()))
    expect(sdk.getContext()).toBeUndefined()
    delete document.documentElement.dataset.quillowTheme
  })

  it('times out pending ready calls and allows a later connection', async () => {
    vi.useFakeTimers()

    const rejected = expect(sdk.ready({ timeout: 50 })).rejects.toThrow('Timed out')

    await vi.advanceTimersByTimeAsync(50)
    await rejected

    const ready = sdk.ready()

    deliver(message('context', context()))
    await expect(ready).resolves.toEqual(context())
    sdk.destroy()
    await expect(sdk.ready()).rejects.toThrow('destroyed')
  })

  it('rejects pending ready on destroy and supports opting out of DOM changes', async () => {
    const pending = sdk.ready()

    sdk.destroy()
    await expect(pending).rejects.toThrow('destroyed')
    sdk = createCustomBlockSDK({ applyStyles: false })
    sdk.start()
    deliver(message('context', context()))
    expect(sdk.getContext()).toEqual(context())
    expect(document.documentElement.style.length).toBe(0)
    expect(document.querySelector('link')).toBeNull()
  })
})

describe('host bridge', () => {
  it('isolates sibling frames, deduplicates updates and reconnects after load', () => {
    const iframe = document.createElement('iframe')

    iframe.src = 'https://widgets.example.com/block/index.html'
    document.body.append(iframe)

    const post = vi.spyOn(iframe.contentWindow!, 'postMessage')
    let current = context()
    const bridge = createCustomBlockHost(iframe, () => current)

    expect(post).toHaveBeenLastCalledWith(message('hello'), 'https://widgets.example.com')
    post.mockClear()

    const ready = (
      source: Window = iframe.contentWindow!,
      origin = 'https://widgets.example.com'
    ) => {
      deliver(message('ready'), origin, source)
    }

    ready(window)
    ready(iframe.contentWindow!, 'https://other.example.com')
    expect(post).not.toHaveBeenCalled()
    ready()
    expect(post).toHaveBeenLastCalledWith(
      message('context', current),
      'https://widgets.example.com'
    )
    bridge.update()
    expect(post).toHaveBeenCalledOnce()
    current = {
      ...current,
      layout: { ...current.layout, size: '2:2', width: 336, height: 336, viewport: 'mobile' },
    }
    bridge.update()
    expect(post).toHaveBeenCalledTimes(2)
    iframe.dispatchEvent(new Event('load'))
    ready()
    expect(post).toHaveBeenLastCalledWith(
      message('context', current),
      'https://widgets.example.com'
    )
    bridge.destroy()
    post.mockClear()
    ready()
    bridge.update()
    iframe.dispatchEvent(new Event('load'))
    expect(post).not.toHaveBeenCalled()
  })
})
