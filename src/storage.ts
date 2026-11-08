import { invalidArgument, protocolError, uncertainMutation, WidgetSDKError } from './errors.js'
import { readOptions, snapshotJson } from './json.js'
import { isRecord } from './protocol.js'
import type { JsonValue, StorageEntry, StoragePage, WidgetContext, WidgetStorage } from './types.js'

export type StorageMethod = 'storage.get' | 'storage.list' | 'storage.set' | 'storage.delete'
export type Request = (method: StorageMethod, params: Record<string, JsonValue>) => Promise<unknown>

function validKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.length > 0 &&
    !/[\p{Cc}\uD800-\uDFFF]/u.test(key) &&
    new TextEncoder().encode(key).length <= 128
  )
}

function checkKey(key: unknown): asserts key is string {
  if (!validKey(key)) invalidArgument('Keys must be 1–128 UTF-8 bytes without control characters')
}

function checkRevision(revision: unknown): asserts revision is string {
  if (typeof revision !== 'string' || revision.length === 0)
    invalidArgument('expectedRevision must be a non-empty revision token')
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

function entry(value: unknown, expectedKey?: string): StorageEntry {
  if (
    !isRecord(value) ||
    !validKey(value.key) ||
    (expectedKey !== undefined && value.key !== expectedKey) ||
    !Object.hasOwn(value, 'value') ||
    typeof value.revision !== 'string' ||
    value.revision.length === 0 ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt)
  )
    throw protocolError('The host returned an invalid storage entry')

  let data: JsonValue

  try {
    data = snapshotJson(value.value)
  } catch (error) {
    throw protocolError('The host returned a non-JSON storage value', error)
  }

  return Object.freeze({
    key: value.key,
    value: data,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  })
}

export function createStorage(
  context: WidgetContext,
  request: Request,
  assertOpen: () => void
): WidgetStorage {
  const authorize = (method: StorageMethod) => {
    assertOpen()
    if (
      !context.capabilities.includes(method) ||
      ((method === 'storage.set' || method === 'storage.delete') && context.mode !== 'editor')
    )
      throw new WidgetSDKError('PERMISSION_DENIED', `The host has not permitted ${method}`)
  }

  return Object.freeze({
    async get(key) {
      authorize('storage.get')
      checkKey(key)
      const result = await request('storage.get', { key })

      return result === null ? null : entry(result, key)
    },
    async list(options = {}) {
      authorize('storage.list')
      const { after, limit = 50 } = readOptions(options, ['after', 'limit'])

      if (after !== undefined && (typeof after !== 'string' || after.length === 0))
        invalidArgument('after must be a non-empty cursor string')
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)
        invalidArgument('limit must be an integer from 1 to 100')

      const result = await request('storage.list', {
        limit,
        ...(after !== undefined ? { after: after as string } : {}),
      })

      if (
        !isRecord(result) ||
        !Array.isArray(result.entries) ||
        result.entries.length > limit ||
        (result.nextCursor !== null &&
          (typeof result.nextCursor !== 'string' || result.nextCursor.length === 0)) ||
        (result.entries.length === 0 && result.nextCursor !== null)
      )
        throw protocolError('The host returned an invalid storage page')

      const entries = result.entries.map((item) => entry(item))

      if (new Set(entries.map((item) => item.key)).size !== entries.length)
        throw protocolError('The host returned duplicate storage keys')

      return Object.freeze({
        entries: Object.freeze(entries),
        nextCursor: result.nextCursor,
      }) as StoragePage
    },
    async set(key, value, options = {}) {
      authorize('storage.set')
      checkKey(key)
      const { expectedRevision } = readOptions(options, ['expectedRevision'])

      if (expectedRevision !== undefined) checkRevision(expectedRevision)

      const result = await request('storage.set', {
        key,
        value: snapshotJson(value),
        ...(expectedRevision !== undefined ? { expectedRevision: expectedRevision as string } : {}),
      })

      try {
        return entry(result, key)
      } catch (error) {
        throw uncertainMutation(error as WidgetSDKError)
      }
    },
    async delete(key, options) {
      authorize('storage.delete')
      checkKey(key)
      const { expectedRevision } = readOptions(options, ['expectedRevision'])

      checkRevision(expectedRevision)
      const result = await request('storage.delete', { key, expectedRevision })

      if (result !== true)
        throw uncertainMutation(protocolError('The host did not confirm deletion'))

      return true
    },
  } satisfies WidgetStorage)
}
