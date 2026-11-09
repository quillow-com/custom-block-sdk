// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WidgetSDKError } from '../src/index.js'
import { context, open, setup, teardown } from './helpers/kv-host.js'

beforeEach(setup)
afterEach(teardown)

const editorContext = () => context({ capabilities: ['editor.open'], editor: { available: true } })

describe('block editor', () => {
  it('requests only the connected block editor and resolves on confirmation', async () => {
    const hostContext = editorContext()
    const host = await open({}, hostContext)
    const pending = host.widget.openEditor()

    expect(host.lastRequest()).toMatchObject({ method: 'editor.open', params: {} })
    expect(host.widget.editor).toEqual({ available: true })
    expect(Object.isFrozen(host.widget.editor)).toBe(true)
    expect(host.widget.editor).not.toBe(hostContext.editor)
    host.respond(true)
    await expect(pending).resolves.toBeUndefined()
  })

  it('distinguishes a missing manifest editor from missing permission without sending a request', async () => {
    const missing = await open({}, context({ editor: { available: false } }))
    await expect(missing.widget.openEditor()).rejects.toMatchObject({ code: 'EDITOR_UNAVAILABLE' })
    expect(missing.transport.postMessage).not.toHaveBeenCalled()

    for (const editor of [undefined, { available: true }]) {
      const denied = await open({}, context({ editor }))
      await expect(denied.widget.openEditor()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      expect(denied.transport.postMessage).not.toHaveBeenCalled()
    }
  })

  it('denies public sessions even when the host incorrectly advertises editor access', async () => {
    const host = await open({}, { ...editorContext(), mode: 'public' })

    await expect(host.widget.openEditor()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(host.transport.postMessage).not.toHaveBeenCalled()
  })

  it('accepts a capability without optional metadata for extensible v1 hosts', async () => {
    const host = await open({}, context({ capabilities: ['editor.open'] }))
    const pending = host.widget.openEditor()

    host.respond(true)
    await expect(pending).resolves.toBeUndefined()
  })

  it.each([null, false, {}, 'true', undefined])(
    'rejects an invalid opening confirmation: %j',
    async (result) => {
      const host = await open({}, editorContext())
      const pending = host.widget.openEditor()

      host.respond(result)
      await expect(pending).rejects.toMatchObject({
        code: 'PROTOCOL_ERROR',
        mutationMayHaveSucceeded: false,
      })
      expect(host.transport.close).not.toHaveBeenCalled()
    }
  )

  it.each(['EDITOR_UNAVAILABLE', 'PERMISSION_DENIED', 'HOST_REQUEST_FAILED'])(
    'preserves host error %s',
    async (code) => {
      const host = await open({}, editorContext())
      const pending = host.widget.openEditor()

      host.reject(code)
      await expect(pending).rejects.toBeInstanceOf(WidgetSDKError)
      await expect(pending).rejects.toMatchObject({ code, mutationMayHaveSucceeded: false })
    }
  )

  it('does not retry a timed-out opening or treat it as a storage mutation', async () => {
    vi.useFakeTimers()
    const host = await open({ requestTimeout: 20 }, editorContext())
    const rejected = expect(host.widget.openEditor()).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      mutationMayHaveSucceeded: false,
    })
    const expired = host.lastRequest()

    await vi.advanceTimersByTimeAsync(20)
    await rejected
    expect(host.transport.postMessage).toHaveBeenCalledOnce()
    const pending = host.widget.openEditor()
    const settled = vi.fn()
    void pending.then(settled)
    host.respond(true, expired)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    host.respond(true)
    await expect(pending).resolves.toBeUndefined()
  })

  it.each(['destroy', 'disconnect'])('rejects pending openings on %s', async (kind) => {
    const host = await open({}, editorContext())
    const pending = host.widget.openEditor()

    if (kind === 'destroy') host.widget.destroy()
    else host.transport.deliver({ ...host.frame('disconnect') })

    const code = kind === 'destroy' ? 'DESTROYED' : 'DISCONNECTED'
    await expect(pending).rejects.toMatchObject({ code, mutationMayHaveSucceeded: false })
    await expect(host.widget.openEditor()).rejects.toMatchObject({ code })
  })
})
