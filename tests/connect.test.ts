// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { connect } from '../src/index.js'
import { message } from '../src/protocol.js'
import type { ConnectOptions } from '../src/types.js'
import {
  context,
  deliver,
  entry,
  lastConnect,
  open,
  parent,
  parentOrigin,
  setup,
  teardown,
  TestPort,
  widgets,
} from './helpers/kv-host.js'

beforeEach(setup)
afterEach(teardown)

describe('KV connection handshake', () => {
  it('returns an immutable context and sends no widget identity or credentials', async () => {
    const hostContext = context()
    const { widget, transport, connectionId } = await open({}, hostContext)

    expect(parent.postMessage).toHaveBeenCalledWith({ ...message('connect'), connectionId }, '*')
    expect(widget.blockId).toBe('block-1')
    expect(widget.versionId).toBe('version-1')
    expect(widget.mode).toBe('editor')
    expect(Object.isFrozen(widget)).toBe(true)
    expect(Object.isFrozen(widget.capabilities)).toBe(true)
    expect(widget.capabilities).not.toBe(hostContext.capabilities)
    expect(transport.start).toHaveBeenCalledOnce()
    expect(document.documentElement.hasAttribute('data-quillow-environment')).toBe(false)
  })

  it('checks the direct parent, exact origin, protocol and connection ID before accepting a port', async () => {
    const promise = connect({ parentOrigin })
    const { connectionId } = lastConnect()
    const port = new TestPort()
    const response = { ...message('connected'), connectionId, context: context() }

    deliver(response, [port.port], parentOrigin, window)
    deliver(response, [port.port], 'https://other.example.com')
    deliver(response, [port.port], 'null')
    deliver({ ...response, connectionId: 'another-instance' }, [port.port])
    deliver({ ...response, protocol: 'unrelated' }, [port.port])
    expect(port.start).not.toHaveBeenCalled()
    expect(port.close).not.toHaveBeenCalled()

    deliver(response, [port.port])
    const widget = await promise
    widgets.add(widget)
    expect(port.start).toHaveBeenCalledOnce()
    expect(parent.postMessage).toHaveBeenCalledWith(
      { ...message('connect'), connectionId },
      parentOrigin
    )
  })

  it('responds to a late host hello without consuming legacy context messages', async () => {
    const promise = connect()
    const { connectionId } = lastConnect()
    const port = new TestPort()

    deliver(message('context'))
    deliver(message('hello'))
    expect(parent.postMessage).toHaveBeenLastCalledWith(
      { ...message('connect'), connectionId },
      parentOrigin
    )
    deliver({ ...message('connected'), connectionId, context: context() }, [port.port])
    widgets.add(await promise)
  })

  it('reports protocol mismatch and closes transferred ports', async () => {
    const promise = connect()
    const { connectionId } = lastConnect()
    const port = new TestPort()

    deliver({ ...message('connected'), version: 2, connectionId, context: context() }, [port.port])
    await expect(promise).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
    expect(port.close).toHaveBeenCalledOnce()
  })

  it.each([
    { blockId: '' },
    { versionId: null },
    { mode: 'published' },
    { capabilities: {} },
    { capabilities: ['storage.get', 'storage.get'] },
    { capabilities: [null] },
  ])('rejects malformed contexts: %j', async (changes) => {
    const promise = connect()
    const { connectionId } = lastConnect()
    const port = new TestPort()

    deliver({ ...message('connected'), connectionId, context: { ...context(), ...changes } }, [
      port.port,
    ])
    await expect(promise).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(port.close).toHaveBeenCalledOnce()
  })

  it('requires exactly one port and preserves handshake error codes', async () => {
    const promise = connect()
    const { connectionId } = lastConnect()

    deliver({ ...message('connected'), connectionId, context: context() })
    await expect(promise).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })

    const rejected = connect()
    deliver({
      ...message('connect-error'),
      connectionId: lastConnect().connectionId,
      error: {
        code: 'widget_not_available',
        message: 'Not available',
        details: { reason: 'removed' },
      },
    })
    await expect(rejected).rejects.toMatchObject({
      code: 'widget_not_available',
      details: { reason: 'removed' },
    })
  })

  it('times out old or absent hosts and removes the handshake listener', async () => {
    vi.useFakeTimers()
    const remove = vi.spyOn(window, 'removeEventListener')
    const rejected = expect(connect({ timeout: 25 })).rejects.toMatchObject({
      code: 'CONNECT_TIMEOUT',
    })

    deliver(message('context'))
    await vi.advanceTimersByTimeAsync(25)
    await rejected
    expect(remove).toHaveBeenCalledWith('message', expect.any(Function))
    const sends = parent.postMessage.mock.calls.length
    deliver(message('hello'))
    expect(parent.postMessage).toHaveBeenCalledTimes(sends)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails clearly outside an iframe', async () => {
    Object.defineProperty(window, 'parent', { configurable: true, value: window })
    await expect(connect()).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' })
  })

  it.each([
    null,
    { timeout: 0 },
    { timeout: null },
    { timeout: 1.5 },
    { requestTimeout: NaN },
    { requestTimeout: 2 ** 31 },
    { parentOrigin: 'https://app.example.com/path' },
    { parentOrigin: 'https://user:secret@app.example.com' },
    { parentOrigin: 'null' },
    { blockId: 'someone-else' },
  ])('rejects invalid connect options: %j', async (options) => {
    await expect(connect(options as ConnectOptions)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(parent.postMessage).not.toHaveBeenCalled()
  })

  it('cleans up if contacting the parent or starting the port throws', async () => {
    vi.useFakeTimers()
    parent.postMessage.mockImplementationOnce(() => {
      throw new Error('Window closed')
    })
    await expect(connect()).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' })
    expect(vi.getTimerCount()).toBe(0)

    const promise = connect()
    const port = new TestPort()
    port.start.mockImplementationOnce(() => {
      throw new Error('Port closed')
    })
    deliver(
      { ...message('connected'), connectionId: lastConnect().connectionId, context: context() },
      [port.port]
    )
    await expect(promise).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(vi.getTimerCount()).toBe(0)
    expect(port.close).toHaveBeenCalled()
  })
})

describe('RPC isolation and lifecycle', () => {
  it('correlates concurrent replies received out of order', async () => {
    const host = await open()
    const first = host.widget.storage.get('first')
    const firstRequest = host.lastRequest()
    const second = host.widget.storage.get('second')

    host.respond(entry('second'))
    host.respond(entry('first'), firstRequest)
    await expect(first).resolves.toMatchObject({ key: 'first' })
    await expect(second).resolves.toMatchObject({ key: 'second' })
  })

  it('isolates two widgets even when their per-session request IDs coincide', async () => {
    const first = await open()
    const second = await open({}, context({ blockId: 'block-2' }))
    expect(first.connectionId).not.toBe(second.connectionId)

    const a = first.widget.storage.get('settings')
    const b = second.widget.storage.get('settings')
    const settled = vi.fn()
    void b.then(settled)

    second.transport.deliver({
      ...first.frame('response'),
      requestId: second.lastRequest().requestId,
      ok: true,
      result: null,
    })
    first.respond(entry())
    await a
    expect(settled).not.toHaveBeenCalled()
    second.respond(null)
    await expect(b).resolves.toBeNull()
  })

  it('never retries timed-out mutations and ignores their late responses', async () => {
    vi.useFakeTimers()
    const host = await open({ requestTimeout: 20 })
    const rejected = expect(host.widget.storage.set('settings', null)).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      mutationMayHaveSucceeded: true,
    })
    const timedOut = host.lastRequest()

    await vi.advanceTimersByTimeAsync(20)
    await rejected
    expect(host.transport.postMessage).toHaveBeenCalledOnce()

    const read = host.widget.storage.get('settings')
    host.respond(entry('settings', null), timedOut)
    host.respond(entry('settings', null))
    await expect(read).resolves.toMatchObject({ value: null })
  })

  it('destroys once, rejects pending work, removes listeners and clears all timers', async () => {
    vi.useFakeTimers()
    const host = await open()
    const remove = vi.spyOn(host.transport, 'removeEventListener')
    const read = host.widget.storage.get('settings')
    const write = host.widget.storage.set('settings', null)

    host.widget.destroy()
    host.widget.destroy()
    await expect(read).rejects.toMatchObject({ code: 'DESTROYED', mutationMayHaveSucceeded: false })
    await expect(write).rejects.toMatchObject({ code: 'DESTROYED', mutationMayHaveSucceeded: true })
    await expect(host.widget.storage.get('settings')).rejects.toMatchObject({ code: 'DESTROYED' })
    expect(host.transport.close).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith('message', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('messageerror', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
    expect(
      host.transport.postMessage.mock.calls.filter(([data]) => data.type === 'disconnect')
    ).toHaveLength(1)
  })

  it.each(['disconnect', 'messageerror', 'pagehide', 'bad-envelope', 'bad-version', 'bad-error'])(
    'handles %s without leaving pending promises',
    async (kind) => {
      vi.useFakeTimers()
      const host = await open()
      const pending = host.widget.storage.set('settings', null)

      if (kind === 'disconnect')
        host.transport.deliver({ ...host.frame('disconnect'), reason: 'Removed' })
      if (kind === 'messageerror') host.transport.dispatchEvent(new MessageEvent('messageerror'))
      if (kind === 'pagehide') window.dispatchEvent(new Event('pagehide'))
      if (kind === 'bad-envelope') host.transport.deliver({ unexpected: true })
      if (kind === 'bad-version') host.transport.deliver({ ...host.frame('response'), version: 2 })
      if (kind === 'bad-error')
        host.transport.deliver({
          ...host.frame('response'),
          requestId: host.lastRequest().requestId,
          ok: false,
          error: { code: 'bad_details', message: 'Bad details', details: undefined },
        })

      await expect(pending).rejects.toMatchObject({
        code:
          kind === 'bad-version'
            ? 'PROTOCOL_MISMATCH'
            : ['disconnect', 'pagehide'].includes(kind)
              ? 'DISCONNECTED'
              : 'PROTOCOL_ERROR',
        mutationMayHaveSucceeded: true,
      })
      expect(host.transport.close).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('handles send failures, and destroy remains unconditional when posting fails', async () => {
    const host = await open()
    host.transport.postMessage.mockImplementationOnce(() => {
      throw new Error('closed')
    })
    await expect(host.widget.storage.set('settings', null)).rejects.toMatchObject({
      code: 'DISCONNECTED',
      mutationMayHaveSucceeded: true,
    })

    const other = await open()
    other.transport.postMessage.mockImplementationOnce(() => {
      throw new Error('closed')
    })
    other.widget.destroy()
    await expect(other.widget.storage.get('settings')).rejects.toMatchObject({ code: 'DESTROYED' })
  })

  it('detects a silent disconnect using ping/pong, without retrying storage operations', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const host = await open()

    await vi.advanceTimersByTimeAsync(15_000)
    const ping = host.lastRequest()
    expect(ping.type).toBe('ping')
    host.transport.deliver({ ...host.frame('pong'), requestId: ping.requestId })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(host.transport.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(host.transport.close).toHaveBeenCalledOnce()
    await expect(host.widget.storage.get('settings')).rejects.toMatchObject({
      code: 'DISCONNECTED',
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('pauses liveness probes in hidden documents and replies to host pings', async () => {
    vi.useFakeTimers()
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    const host = await open()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.transport.postMessage).not.toHaveBeenCalled()
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(host.lastRequest().type).toBe('ping')

    hidden.mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.transport.close).not.toHaveBeenCalled()
    host.transport.deliver({ ...host.frame('ping'), requestId: 'host-ping' })
    expect(host.lastRequest()).toEqual({ ...host.frame('pong'), requestId: 'host-ping' })
  })
})
