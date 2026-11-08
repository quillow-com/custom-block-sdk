import { vi, type Mock } from 'vitest'

import { connect } from '../../src/index.js'
import { message } from '../../src/protocol.js'
import type {
  ConnectOptions,
  JsonValue,
  StorageEntry,
  Widget,
  WidgetContext,
} from '../../src/types.js'

export const parentOrigin = 'https://app.example.com'
export const parent = { postMessage: vi.fn() } as unknown as Window & {
  postMessage: ReturnType<typeof vi.fn>
}
export const widgets = new Set<Widget>()

export function context(overrides: Partial<WidgetContext> = {}): WidgetContext {
  return {
    blockId: 'block-1',
    versionId: 'version-1',
    mode: 'editor',
    capabilities: ['storage.get', 'storage.list', 'storage.set', 'storage.delete'],
    ...overrides,
  }
}

export function entry(key = 'settings', value = '{"theme":"dark"}'): StorageEntry {
  return {
    key,
    value,
    revision: 'opaque-revision-1',
    createdAt: '2026-11-04T10:00:00.123456789Z',
    updatedAt: '2026-11-04T10:00:00.123456789Z',
  }
}

export class TestPort {
  private events = new EventTarget()
  postMessage: Mock<(data: Record<string, unknown>) => void> = vi.fn()
  start: Mock<() => void> = vi.fn()
  close: Mock<() => void> = vi.fn()

  get port(): MessagePort {
    return this as unknown as MessagePort
  }

  addEventListener(...args: Parameters<EventTarget['addEventListener']>) {
    this.events.addEventListener(...args)
  }

  removeEventListener(...args: Parameters<EventTarget['removeEventListener']>) {
    this.events.removeEventListener(...args)
  }

  dispatchEvent(event: Event) {
    return this.events.dispatchEvent(event)
  }

  deliver(data: unknown) {
    this.events.dispatchEvent(new MessageEvent('message', { data }))
  }
}

export function deliver(
  data: unknown,
  ports: MessagePort[] = [],
  origin = parentOrigin,
  source: Window = parent
) {
  window.dispatchEvent(new MessageEvent('message', { data, ports, origin, source }))
}

export function lastConnect(): { connectionId: string } {
  return parent.postMessage.mock.calls.at(-1)![0] as { connectionId: string }
}

export async function open(options: ConnectOptions = {}, widgetContext: WidgetContext = context()) {
  const promise = connect(options)
  const { connectionId } = lastConnect()
  const transport = new TestPort()
  const frame = (type: string) => ({ ...message(type), connectionId })

  deliver({ ...frame('connected'), context: widgetContext }, [transport.port])
  const widget = await promise

  widgets.add(widget)

  return {
    widget,
    transport,
    connectionId,
    frame,
    lastRequest() {
      return transport.postMessage.mock.calls.at(-1)![0]!
    },
    respond(result: unknown, request = transport.postMessage.mock.calls.at(-1)![0]!) {
      transport.deliver({ ...frame('response'), requestId: request.requestId, ok: true, result })
    },
    reject(code: string, details?: JsonValue) {
      const request = transport.postMessage.mock.calls.at(-1)![0]!

      transport.deliver({
        ...frame('response'),
        requestId: request.requestId,
        ok: false,
        error: { code, message: `Backend: ${code}`, ...(details !== undefined ? { details } : {}) },
      })
    },
  }
}

export function setup() {
  Object.defineProperty(window, 'parent', { configurable: true, value: parent })
}

export function teardown() {
  for (const widget of widgets) widget.destroy()
  widgets.clear()
  Object.defineProperty(window, 'parent', { configurable: true, value: window })
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
}
