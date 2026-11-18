import type { JsonValue } from './types.js'

export type StorageMethod = 'storage.get' | 'storage.list' | 'storage.set' | 'storage.delete'
export type Request = (method: StorageMethod, params: Record<string, JsonValue>) => Promise<unknown>
