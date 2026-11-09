export interface BlockContext {
  readonly theme: {
    readonly mode: 'light' | 'dark'
    readonly cornerStyle: 'Normal' | 'Pill' | 'Sharp'
    readonly variables: Readonly<Record<string, string>>
    /** Absolute stylesheet URL; null uses the block's own fonts. */
    readonly fontStylesheet: string | null
  }
  readonly layout: {
    /** Grid columns:rows, not the pixel aspect ratio. */
    readonly size: '1:1' | '2:1' | '2:2'
    readonly width: number
    readonly height: number
    readonly viewport: 'mobile' | 'desktop'
  }
  readonly environment: 'editor' | 'published'
}

/** Safe JSON data for protocol error details; storage values themselves are strings. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface StorageEntry {
  readonly key: string
  /** Opaque UTF-8 text; serialize structured settings explicitly. Empty strings are valid. */
  readonly value: string
  /** Opaque token. Never calculate or increment revisions in widget code. */
  readonly revision: string
  /** RFC 3339 timestamps, as returned by the backend. */
  readonly createdAt: string
  readonly updatedAt: string
}

export interface StoragePage {
  readonly entries: readonly StorageEntry[]
  readonly nextCursor: string | null
}

export interface StorageListOptions {
  after?: string
  /** Integer from 1 to 100. Default 50. */
  limit?: number
}

export interface StorageSetOptions {
  /** Omit (or use undefined) to create only; supply a revision to update. */
  expectedRevision?: string
}

export interface StorageDeleteOptions {
  expectedRevision: string
}

export interface WidgetStorage {
  get(key: string): Promise<StorageEntry | null>
  list(options?: StorageListOptions): Promise<StoragePage>
  set(key: string, value: string, options?: StorageSetOptions): Promise<StorageEntry>
  delete(key: string, options: StorageDeleteOptions): Promise<true>
}

export interface WidgetContext {
  readonly blockId: string
  readonly versionId: string
  readonly mode: 'public' | 'editor'
  /** Known capabilities are storage.get/list/set/delete and editor.open. Unknown names are retained. */
  readonly capabilities: readonly string[]
  /** Optional host metadata. False means the block has no available manifest.editor screen. */
  readonly editor?: { readonly available: boolean }
}

export interface Widget extends WidgetContext {
  readonly storage: WidgetStorage
  /** Requests the manifest.editor screen in editor mode. Resolves when opening is accepted, not on close. */
  openEditor(): Promise<void>
  /** Permanently closes this connection. Does not undo mutations already sent to the host. */
  destroy(): void
}

export interface ConnectOptions {
  /** Pin the host origin when known. Otherwise trust only the direct parent that completes the handshake. */
  parentOrigin?: string
  /** Connection timeout in milliseconds. Default 10,000. */
  timeout?: number
  /** Per-request timeout in milliseconds. Default 10,000. Mutations are never retried. */
  requestTimeout?: number
}
