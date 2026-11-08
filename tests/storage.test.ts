// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { StorageDeleteOptions, StorageListOptions, StorageSetOptions } from '../src/index.js'
import { context, entry, open, setup, teardown } from './helpers/kv-host.js'

beforeEach(setup)
afterEach(teardown)

describe('widget storage', () => {
  it('distinguishes missing entries from empty strings and does not return a backend blockId field', async () => {
    const host = await open()
    const missing = host.widget.storage.get('settings')
    host.respond(null)
    await expect(missing).resolves.toBeNull()

    const present = host.widget.storage.get('settings')
    host.respond({ ...entry('settings', ''), blockId: host.widget.blockId })
    await expect(present).resolves.toEqual(entry('settings', ''))
    expect(host.lastRequest()).toMatchObject({ method: 'storage.get', params: { key: 'settings' } })
  })

  it('creates, updates and deletes using only caller-provided revisions', async () => {
    const host = await open()
    const create = host.widget.storage.set('settings', '', { expectedRevision: undefined })
    expect(host.lastRequest().params).toEqual({ key: 'settings', value: '' })
    host.respond(entry('settings', ''))
    const created = await create

    const update = host.widget.storage.set('settings', '{"theme":"light"}', {
      expectedRevision: created.revision,
    })
    expect(host.lastRequest().params).toEqual({
      key: 'settings',
      value: '{"theme":"light"}',
      expectedRevision: created.revision,
    })
    host.respond({ ...entry('settings', '{"theme":"light"}'), revision: 'opaque-revision-2' })
    const saved = await update

    const deleted = host.widget.storage.delete('settings', { expectedRevision: saved.revision })
    expect(host.lastRequest().params).toEqual({
      key: 'settings',
      expectedRevision: 'opaque-revision-2',
    })
    host.respond(true)
    await expect(deleted).resolves.toBe(true)

    const createOnly = host.widget.storage.set('settings', 'again')
    expect(host.lastRequest().params).not.toHaveProperty('expectedRevision')
    host.respond(entry('settings', 'again'))
    await createOnly
  })

  it.each(['', 'plain text', ' \nЖ 🧮 ', 'not { JSON', '{ "nested": true }'])(
    'preserves opaque text without serialization: %j',
    async (value) => {
      const host = await open()
      const saved = host.widget.storage.set('settings', value)

      expect(host.lastRequest().params).toEqual({
        key: 'settings',
        value,
      })
      host.respond(entry('settings', value))
      expect((await saved).value).toBe(value)
    }
  )

  it('paginates explicitly without fetching additional pages automatically', async () => {
    const host = await open()
    const first = host.widget.storage.list({ limit: 1 })
    expect(host.lastRequest().params).toEqual({ limit: 1 })
    host.respond({ entries: [entry('a', '1')], nextCursor: 'a' })
    const page = await first
    expect(page.nextCursor).toBe('a')
    expect(host.transport.postMessage).toHaveBeenCalledOnce()

    const next = host.widget.storage.list({ after: page.nextCursor!, limit: 1 })
    expect(host.lastRequest().params).toEqual({ after: 'a', limit: 1 })
    host.respond({ entries: [entry('b', 'false')], nextCursor: null })
    await expect(next).resolves.toEqual({ entries: [entry('b', 'false')], nextCursor: null })

    const defaults = host.widget.storage.list()
    expect(host.lastRequest().params).toEqual({ limit: 50 })
    host.respond({ entries: [], nextCursor: null })
    await defaults
  })

  it.each([
    'widget_storage_conflict',
    'widget_storage_quota_exceeded',
    'widget_storage_invalid',
    'widget_storage_not_found',
    'forbidden',
    'unknown_future_backend_code',
  ])('preserves backend error %s, including details, without retrying', async (code) => {
    const host = await open()
    const pending = host.widget.storage.set('settings', '')
    host.reject(code, { limit: 256, field: 'settings' })

    await expect(pending).rejects.toMatchObject({
      name: 'WidgetSDKError',
      code,
      message: `Backend: ${code}`,
      details: { limit: 256, field: 'settings' },
      mutationMayHaveSucceeded: false,
    })
    expect(host.transport.postMessage).toHaveBeenCalledOnce()
  })

  it('denies public writes even when the host accidentally advertises write capabilities', async () => {
    const host = await open({}, context({ mode: 'public' }))

    await expect(host.widget.storage.set('settings', '')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    await expect(
      host.widget.storage.delete('settings', { expectedRevision: 'r' })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(host.transport.postMessage).not.toHaveBeenCalled()

    const read = host.widget.storage.get('settings')
    host.respond(null)
    await expect(read).resolves.toBeNull()
    const list = host.widget.storage.list()
    host.respond({ entries: [], nextCursor: null })
    await list
  })

  it('checks each capability independently in editor mode', async () => {
    const host = await open({}, context({ capabilities: ['storage.set', 'future-capability'] }))

    await expect(host.widget.storage.get('settings')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    await expect(host.widget.storage.list()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    await expect(
      host.widget.storage.delete('settings', { expectedRevision: 'r' })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(host.transport.postMessage).not.toHaveBeenCalled()
    const write = host.widget.storage.set('settings', 'true')
    host.respond(entry('settings', 'true'))
    await write
  })

  it.each(['', 'x'.repeat(129), 'я'.repeat(65), 'line\nbreak', '\u0000', '\u007f', '\ud800'])(
    'rejects invalid keys before sending: %j',
    async (key) => {
      const host = await open()
      await expect(host.widget.storage.get(key)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      await expect(host.widget.storage.set(key, '')).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      })
      await expect(
        host.widget.storage.delete(key, { expectedRevision: 'r' })
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      expect(host.transport.postMessage).not.toHaveBeenCalled()
    }
  )

  it('allows Unicode and validates key length in bytes without normalizing keys', async () => {
    const host = await open()
    const key = '😀'.repeat(32)
    const read = host.widget.storage.get(key)
    expect(host.lastRequest().params).toEqual({ key })
    host.respond(entry(key))
    await read
  })

  it.each([
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: Infinity },
    { limit: null },
    { after: '' },
    { after: null },
    { scope: 'private' },
    { blockId: 'other' },
  ])('rejects invalid list options: %j', async (options) => {
    const host = await open()
    await expect(host.widget.storage.list(options as StorageListOptions)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(host.transport.postMessage).not.toHaveBeenCalled()
  })

  it('rejects missing delete revisions and invalid or foreign options', async () => {
    const host = await open()
    for (const options of [
      undefined,
      null,
      {},
      { expectedRevision: undefined },
      { expectedRevision: '' },
    ]) {
      await expect(
        host.widget.storage.delete('settings', options as StorageDeleteOptions)
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    for (const options of [
      { expectedRevision: null },
      { expectedRevision: 1 },
      { scope: 'public' },
      { blockId: 'other' },
    ]) {
      await expect(
        host.widget.storage.set('settings', '', options as StorageSetOptions)
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    expect(host.transport.postMessage).not.toHaveBeenCalled()
  })

  it.each([
    null,
    true,
    42,
    {},
    [],
    undefined,
    { nested: undefined },
    [BigInt(1)],
    { number: NaN },
    new Date(),
    '\u0000',
    '\ud800',
  ])('rejects non-string or malformed text values before sending: %#', async (value) => {
    const host = await open()
    await expect(
      host.widget.storage.set('settings', value as unknown as string)
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(host.transport.postMessage).not.toHaveBeenCalled()
  })

  it.each([
    undefined,
    { ...entry(), key: 'another-key' },
    { ...entry(), value: undefined },
    { ...entry(), value: null },
    { ...entry(), value: {} },
    { ...entry(), value: 42 },
    { ...entry(), value: '\u0000' },
    { ...entry(), revision: '' },
    { ...entry(), updatedAt: 'yesterday' },
    {
      key: 'settings',
      revision: 'r',
      createdAt: '2026-11-04T00:00:00Z',
      updatedAt: '2026-11-04T00:00:00Z',
    },
  ])('rejects malformed get results instead of treating them as absent: %#', async (result) => {
    const host = await open()
    const read = host.widget.storage.get('settings')
    host.respond(result)
    await expect(read).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it.each([
    { entries: [], nextCursor: 'more' },
    { entries: [entry()], nextCursor: undefined },
    { entries: [entry(), entry()], nextCursor: null },
    { entries: [null], nextCursor: null },
    { entries: null, nextCursor: null },
  ])('rejects malformed list results: %#', async (result) => {
    const host = await open()
    const list = host.widget.storage.list()
    host.respond(result)
    await expect(list).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('marks malformed mutation confirmations as an unknown outcome', async () => {
    const host = await open()
    const write = host.widget.storage.set('settings', '')
    host.respond(null)
    await expect(write).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      mutationMayHaveSucceeded: true,
    })

    const deleted = host.widget.storage.delete('settings', { expectedRevision: 'r' })
    host.respond(false)
    await expect(deleted).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      mutationMayHaveSucceeded: true,
    })
  })
})
