import type { JsonValue } from './types.js'

export type StorageMethod = 'storage.get' | 'storage.list' | 'storage.set' | 'storage.delete'
export type RPCMethod = StorageMethod | 'editor.open'
export type Request = (method: RPCMethod, params: Record<string, JsonValue>) => Promise<unknown>
