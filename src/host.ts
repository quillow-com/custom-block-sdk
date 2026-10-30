import { isContext, isHttpUrl, isMessage, message, type BlockContext } from './protocol.js'

export type { BlockContext } from './protocol.js'

/** One bridge per iframe. Call update after host state changes; destroy on removal. */
export function createCustomBlockHost(iframe: HTMLIFrameElement, getContext: () => BlockContext) {
  const hostWindow = iframe.ownerDocument.defaultView!
  let destroyed = false
  let connected = false
  let lastContext = ''
  const targetOrigin = () => {
    if (!isHttpUrl(iframe.src)) return undefined

    const origin = new URL(iframe.src).origin

    return origin !== hostWindow.location.origin ? origin : undefined
  }
  const update = (force = false) => {
    const origin = targetOrigin()

    if (destroyed || !connected || !origin) return

    const context = getContext()

    if (!isContext(context)) throw new Error('Invalid Quillow block context')

    const serialized = JSON.stringify(context)

    if (!force && serialized === lastContext) return

    lastContext = serialized
    iframe.contentWindow?.postMessage(message('context', context), origin)
  }
  const hello = () => {
    connected = false
    lastContext = ''

    const origin = targetOrigin()

    if (origin) iframe.contentWindow?.postMessage(message('hello'), origin)
  }
  const receive = (event: MessageEvent) => {
    if (
      event.source !== iframe.contentWindow ||
      event.origin !== targetOrigin() ||
      !isMessage(event.data, 'ready')
    )
      return

    connected = true
    update(true)
  }

  hostWindow.addEventListener('message', receive)
  iframe.addEventListener('load', hello)
  hello()

  return {
    update,
    destroy() {
      destroyed = true
      hostWindow.removeEventListener('message', receive)
      iframe.removeEventListener('load', hello)
    },
  }
}
