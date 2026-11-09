import { invalidArgument, protocolError, uncertainMutation, WidgetSDKError } from './errors.js'
import { readOptions, snapshotJson } from './json.js'
import { isHttpUrl, isMessage, isRecord, message, PROTOCOL, VERSION } from './protocol.js'
import type { Request, RPCMethod } from './rpc.js'
import { createStorage } from './storage.js'
import type { ConnectOptions, Widget, WidgetContext } from './types.js'

const HEARTBEAT_INTERVAL = 15_000
const HEARTBEAT_TIMEOUT = 10_000

function timeoutOption(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2_147_483_647)
    invalidArgument(`${name} must be a positive integer no greater than 2147483647 milliseconds`)

  return value
}

function readContext(value: unknown): WidgetContext {
  if (
    !isRecord(value) ||
    typeof value.blockId !== 'string' ||
    value.blockId.length === 0 ||
    typeof value.versionId !== 'string' ||
    value.versionId.length === 0 ||
    (value.mode !== 'public' && value.mode !== 'editor') ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every(
      (capability) => typeof capability === 'string' && capability.length > 0
    ) ||
    new Set(value.capabilities).size !== value.capabilities.length ||
    (value.editor !== undefined &&
      (!isRecord(value.editor) || typeof value.editor.available !== 'boolean'))
  )
    throw protocolError('The host returned an invalid widget context')

  return Object.freeze({
    blockId: value.blockId,
    versionId: value.versionId,
    mode: value.mode,
    capabilities: Object.freeze([...value.capabilities]) as readonly string[],
    ...(isRecord(value.editor)
      ? { editor: Object.freeze({ available: value.editor.available as boolean }) }
      : {}),
  })
}

function readError(value: unknown): WidgetSDKError {
  if (
    !isRecord(value) ||
    typeof value.code !== 'string' ||
    value.code.length === 0 ||
    typeof value.message !== 'string' ||
    value.message.length === 0
  )
    throw protocolError('The host returned an invalid error')

  try {
    return new WidgetSDKError(value.code, value.message, {
      ...(Object.hasOwn(value, 'details') ? { details: snapshotJson(value.details) } : {}),
    })
  } catch (error) {
    throw protocolError('The host returned non-JSON error details', error)
  }
}

function createWidget(
  context: WidgetContext,
  port: MessagePort,
  connectionId: string,
  requestTimeout: number
): Widget {
  let closed: WidgetSDKError | undefined
  let sequence = 0
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined
  let heartbeatId: string | undefined
  const pending = new Map<
    string,
    {
      method: RPCMethod
      resolve: (value: unknown) => void
      reject: (error: WidgetSDKError) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const frame = (type: string) => ({ ...message(type), connectionId })
  const mutation = (method: RPCMethod) => method === 'storage.set' || method === 'storage.delete'
  const assertOpen = () => {
    if (closed) throw closed
  }
  const close = (error: WidgetSDKError) => {
    if (closed) return

    closed = error
    clearTimeout(heartbeatTimer)
    port.removeEventListener('message', receive)
    port.removeEventListener('messageerror', messageError)
    window.removeEventListener('pagehide', pagehide)
    document.removeEventListener('visibilitychange', visibilityChanged)
    port.close()
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(mutation(waiter.method) ? uncertainMutation(error) : error)
    }
    pending.clear()
  }
  const send = (data: Record<string, unknown>) => {
    try {
      port.postMessage(data)
    } catch (cause) {
      close(new WidgetSDKError('DISCONNECTED', 'Unable to send a message to the host', { cause }))
    }
  }
  const scheduleHeartbeat = () => {
    clearTimeout(heartbeatTimer)
    heartbeatId = undefined
    if (closed || document.hidden) return

    heartbeatTimer = setTimeout(() => {
      heartbeatId = `ping:${++sequence}`
      send({ ...frame('ping'), requestId: heartbeatId })
      if (closed) return

      heartbeatTimer = setTimeout(() => {
        close(new WidgetSDKError('DISCONNECTED', 'The Quillow host stopped responding'))
      }, HEARTBEAT_TIMEOUT)
    }, HEARTBEAT_INTERVAL)
  }
  const visibilityChanged = () => scheduleHeartbeat()
  const pagehide = () =>
    close(new WidgetSDKError('DISCONNECTED', 'The widget document was unloaded'))
  const messageError = () => close(protocolError('Unable to decode a host message'))
  const receive = (event: MessageEvent) => {
    const data: unknown = event.data

    // Another session can never satisfy this session's requests, even if an ID is reused.
    if (
      isRecord(data) &&
      typeof data.connectionId === 'string' &&
      data.connectionId !== connectionId
    )
      return

    try {
      if (event.ports.length > 0) {
        for (const transferred of event.ports) transferred.close()
        throw protocolError('Unexpected MessagePort in a host RPC message')
      }
      if (!isRecord(data) || data.protocol !== PROTOCOL || data.connectionId !== connectionId)
        throw protocolError('Invalid host message envelope')
      if (data.version !== VERSION)
        throw new WidgetSDKError(
          'PROTOCOL_MISMATCH',
          'The host uses an incompatible bridge protocol'
        )

      if (data.type === 'disconnect') {
        if (data.reason !== undefined && typeof data.reason !== 'string')
          throw protocolError('Invalid disconnect message')
        close(new WidgetSDKError('DISCONNECTED', data.reason || 'The Quillow host disconnected'))

        return
      }
      if (typeof data.requestId !== 'string' || data.requestId.length === 0)
        throw protocolError('The host message is missing its request ID')

      if (data.type === 'ping') {
        send({ ...frame('pong'), requestId: data.requestId })

        return
      }
      if (data.type === 'pong') {
        if (data.requestId === heartbeatId) scheduleHeartbeat()

        return
      }
      if (data.type !== 'response') throw protocolError('Unknown host message type')

      const waiter = pending.get(data.requestId)

      // Late and duplicate replies must not affect any later request.
      if (!waiter) return

      const success =
        data.ok === true && Object.hasOwn(data, 'result') && !Object.hasOwn(data, 'error')
      const failure =
        data.ok === false && Object.hasOwn(data, 'error') && !Object.hasOwn(data, 'result')

      if (!success && !failure) throw protocolError('Invalid host response')

      const error = failure ? readError(data.error) : undefined

      pending.delete(data.requestId)
      clearTimeout(waiter.timer)
      if (error) waiter.reject(error)
      else waiter.resolve(data.result)
    } catch (error) {
      close(error instanceof WidgetSDKError ? error : protocolError('Invalid host message', error))
    }
  }
  const request: Request = (method, params) =>
    new Promise((resolve, reject) => {
      assertOpen()

      const requestId = `request:${++sequence}`
      const timer = setTimeout(() => {
        pending.delete(requestId)
        const error = new WidgetSDKError('REQUEST_TIMEOUT', `Timed out waiting for ${method}`)

        reject(mutation(method) ? uncertainMutation(error) : error)
      }, requestTimeout)

      pending.set(requestId, { method, resolve, reject, timer })
      send({ ...frame('request'), requestId, method, params })
    })

  try {
    port.addEventListener('message', receive)
    port.addEventListener('messageerror', messageError)
    window.addEventListener('pagehide', pagehide)
    document.addEventListener('visibilitychange', visibilityChanged)
    port.start()
    scheduleHeartbeat()
  } catch (cause) {
    const error = new WidgetSDKError('DISCONNECTED', 'Unable to start the host transport', {
      cause,
    })

    close(error)
    throw error
  }

  return Object.freeze({
    ...context,
    storage: createStorage(context, request, assertOpen),
    async openEditor() {
      assertOpen()
      if (context.mode !== 'editor')
        throw new WidgetSDKError(
          'PERMISSION_DENIED',
          'Opening the block editor requires editor mode'
        )
      if (context.editor?.available === false)
        throw new WidgetSDKError(
          'EDITOR_UNAVAILABLE',
          'This block has no available manifest.editor screen'
        )
      if (!context.capabilities.includes('editor.open'))
        throw new WidgetSDKError('PERMISSION_DENIED', 'The host has not permitted editor.open')

      const result = await request('editor.open', {})

      if (result !== true) throw protocolError('The host did not confirm opening the block editor')
    },
    destroy() {
      if (closed) return
      try {
        port.postMessage({ ...frame('disconnect'), reason: 'The widget destroyed its connection' })
      } catch {
        // Teardown is local and unconditional, even when the host can no longer receive messages.
      }
      close(new WidgetSDKError('DESTROYED', 'The widget connection has been destroyed'))
    },
  })
}

/** Connect one independent host session. This does not start or alter the legacy theme bridge. */
export async function connect(options: ConnectOptions = {}): Promise<Widget> {
  const settings = readOptions(options, ['parentOrigin', 'timeout', 'requestTimeout'])
  const timeout = timeoutOption(
    settings.timeout === undefined ? 10_000 : settings.timeout,
    'timeout'
  )
  const requestTimeout = timeoutOption(
    settings.requestTimeout === undefined ? 10_000 : settings.requestTimeout,
    'requestTimeout'
  )
  const origin = settings.parentOrigin

  if (
    origin !== undefined &&
    (typeof origin !== 'string' || !isHttpUrl(origin) || new URL(origin).origin !== origin)
  )
    invalidArgument('parentOrigin must be an exact HTTP(S) origin')
  if (typeof window === 'undefined' || window.parent === window)
    throw new WidgetSDKError('HOST_UNAVAILABLE', 'Quillow connect() requires an iframe with a host')
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function')
    throw new WidgetSDKError(
      'HOST_UNAVAILABLE',
      'Quillow connect() requires a secure browser context'
    )

  const parent = window.parent
  const connectionId = crypto.randomUUID()

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      window.removeEventListener('message', receive)
    }
    const fail = (error: unknown) => {
      cleanup()
      reject(error)
    }
    const request = (targetOrigin: string) => {
      try {
        parent.postMessage({ ...message('connect'), connectionId }, targetOrigin)
      } catch (cause) {
        fail(
          new WidgetSDKError('HOST_UNAVAILABLE', 'Unable to contact the Quillow host', { cause })
        )
      }
    }
    const receive = (event: MessageEvent) => {
      if (
        event.source !== parent ||
        !isHttpUrl(event.origin) ||
        new URL(event.origin).origin !== event.origin ||
        (origin !== undefined && event.origin !== origin)
      )
        return

      if (isMessage(event.data, 'hello')) {
        request(event.origin)

        return
      }

      const data: unknown = event.data

      if (!isRecord(data) || data.protocol !== PROTOCOL || data.connectionId !== connectionId)
        return

      try {
        if (data.version !== VERSION)
          throw new WidgetSDKError(
            'PROTOCOL_MISMATCH',
            'The host uses an incompatible bridge protocol'
          )
        if (data.type === 'connect-error') throw readError(data.error)
        if (data.type !== 'connected' || event.ports.length !== 1)
          throw protocolError(
            'The host must return a connected message with exactly one MessagePort'
          )

        const context = readContext(data.context)
        const widget = createWidget(context, event.ports[0]!, connectionId, requestTimeout)

        cleanup()
        resolve(widget)
      } catch (error) {
        for (const port of event.ports) port.close()
        fail(
          error instanceof WidgetSDKError ? error : protocolError('Invalid host handshake', error)
        )
      }
    }
    const timer = setTimeout(() => {
      fail(
        new WidgetSDKError(
          'CONNECT_TIMEOUT',
          'Timed out connecting to Quillow: no compatible host responded'
        )
      )
    }, timeout)

    window.addEventListener('message', receive)
    request((origin as string | undefined) ?? '*')
  })
}
