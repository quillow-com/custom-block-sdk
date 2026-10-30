import { isContext, isHttpUrl, isMessage, message, type BlockContext } from './protocol.js'

export type { BlockContext } from './protocol.js'

export interface SDKOptions {
  /** Pin the embedding origin when known. Otherwise trust the direct parent and pin its first valid message. */
  parentOrigin?: string
  /** Apply theme variables, font stylesheet and data attributes to <html>. Default true. */
  applyStyles?: boolean
}

export function createCustomBlockSDK(options: SDKOptions = {}) {
  let origin = options.parentOrigin

  if (origin && (!isHttpUrl(origin) || new URL(origin).origin !== origin)) {
    throw new Error('parentOrigin must be an HTTP(S) origin')
  }

  let context: BlockContext | undefined
  let started = false
  let destroyed = false
  let font: HTMLLinkElement | undefined
  const listeners = new Set<(context: BlockContext) => void>()
  const pending = new Set<{
    resolve: (context: BlockContext) => void
    reject: (error: Error) => void
  }>()
  const previousVariables = new Map<string, { value: string; priority: string }>()
  const previousAttributes = new Map<string, string | null>()
  let appliedVariables = new Set<string>()

  const restoreVariable = (key: string) => {
    const previous = previousVariables.get(key)

    if (previous?.value)
      document.documentElement.style.setProperty(key, previous.value, previous.priority)
    else document.documentElement.style.removeProperty(key)
  }

  const apply = (next: BlockContext) => {
    const root = document.documentElement

    for (const key of appliedVariables) {
      if (!(key in next.theme.variables)) restoreVariable(key)
    }
    for (const [key, value] of Object.entries(next.theme.variables)) {
      if (!previousVariables.has(key))
        previousVariables.set(key, {
          value: root.style.getPropertyValue(key),
          priority: root.style.getPropertyPriority(key),
        })

      root.style.setProperty(key, value)
    }
    appliedVariables = new Set(Object.keys(next.theme.variables))

    const attributes = {
      'data-quillow-theme': next.theme.mode,
      'data-quillow-size': next.layout.size,
      'data-quillow-viewport': next.layout.viewport,
      'data-quillow-corner-style': next.theme.cornerStyle,
      'data-quillow-environment': next.environment,
    }

    for (const [name, value] of Object.entries(attributes)) {
      if (!previousAttributes.has(name)) previousAttributes.set(name, root.getAttribute(name))

      root.setAttribute(name, value)
    }

    if (next.theme.fontStylesheet) {
      if (!font) {
        font = document.createElement('link')
        font.rel = 'stylesheet'
        ;(document.head ?? root).append(font)
      }
      if (font.href !== next.theme.fontStylesheet) font.href = next.theme.fontStylesheet
    } else {
      font?.remove()
      font = undefined
    }
  }

  const request = () => window.parent.postMessage(message('ready'), origin ?? '*')
  const notify = (listener: (context: BlockContext) => void, value: BlockContext) => {
    try {
      listener(value)
    } catch (error) {
      console.error('[Quillow SDK] Subscriber failed', error)
    }
  }
  const receive = (event: MessageEvent) => {
    if (
      event.source !== window.parent ||
      !isHttpUrl(event.origin) ||
      (origin && event.origin !== origin)
    )
      return
    if (isMessage(event.data, 'hello')) {
      origin = event.origin
      request()

      return
    }
    if (!isMessage(event.data, 'context') || !isContext(event.data.context)) return

    origin = event.origin

    const next = event.data.context

    context = Object.freeze({
      ...next,
      theme: Object.freeze({
        ...next.theme,
        variables: Object.freeze({ ...next.theme.variables }),
      }),
      layout: Object.freeze({ ...next.layout }),
    })

    if (options.applyStyles !== false) apply(context)

    for (const waiter of pending) waiter.resolve(context)
    pending.clear()
    for (const listener of listeners) {
      notify(listener, context)
    }
  }

  const start = () => {
    if (destroyed) throw new Error('Quillow SDK has been destroyed')
    if (started) return
    if (typeof window === 'undefined' || window.parent === window)
      throw new Error('Quillow SDK requires an embedded browser window')

    started = true
    window.addEventListener('message', receive)
    request()
  }

  return {
    /** Starts the bridge. Importing the module alone has no browser side effects. */
    start,
    getContext: () => context,
    ready({ timeout = 10000 }: { timeout?: number } = {}): Promise<BlockContext> {
      return new Promise((resolve, reject) => {
        start()

        if (context) {
          resolve(context)

          return
        }

        const timer = setTimeout(() => {
          pending.delete(waiter)
          reject(new Error('Timed out waiting for the Quillow host'))
        }, timeout)
        const waiter = {
          resolve: (value: BlockContext) => {
            clearTimeout(timer)
            resolve(value)
          },
          reject: (error: Error) => {
            clearTimeout(timer)
            reject(error)
          },
        }

        pending.add(waiter)
      })
    },
    /** Immediately replays the current context if already connected. */
    subscribe(listener: (context: BlockContext) => void) {
      start()
      listeners.add(listener)

      if (context) notify(listener, context)

      return () => {
        listeners.delete(listener)
      }
    },
    destroy() {
      if (destroyed) return

      destroyed = true

      if (started) window.removeEventListener('message', receive)

      for (const waiter of pending) waiter.reject(new Error('Quillow SDK has been destroyed'))
      pending.clear()
      listeners.clear()
      for (const key of appliedVariables) restoreVariable(key)
      for (const [name, value] of previousAttributes) {
        if (value === null) document.documentElement.removeAttribute(name)
        else document.documentElement.setAttribute(name, value)
      }
      font?.remove()
      context = undefined
    },
  }
}

export const Quillow = createCustomBlockSDK()
