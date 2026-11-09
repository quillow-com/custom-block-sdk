# Custom Block host connection contract

This specifies the **v1 connection** for string-only storage and the optional block editor UI implemented by this package. The host must implement this contract separately. It extends `quillow:custom-block` v1: `hello`, `ready`, and `context` theme/layout messages retain their existing meanings. Do not add RPC to theme messages or consider a theme-only host connected to RPC. Widget manifest `schemaVersion` also remains `1`.

All examples below are structured-clone objects, not JSON strings. Every message has:

```ts
{
  protocol: 'quillow:custom-block',
  version: 1,
  type: string,
  connectionId: string,
}
```

The SDK generates a fresh unpredictable `connectionId` with `crypto.randomUUID()` for each call to `connect()`. IDs correlate sessions; they are not authorization tokens. Storage parameters never include `blockId`, `versionId`, or `scope`.

## 1. Window handshake

Widget → direct parent, using `window.parent.postMessage`:

```ts
{
  protocol: 'quillow:custom-block',
  version: 1,
  type: 'connect',
  connectionId: '<unique connection ID>',
}
```

The target origin is the configured exact HTTP(S) `parentOrigin`, or `'*'` when unknown. This initial message contains no block data, values, or credentials. The SDK also resends this same handshake when the parent announces the existing v1 `hello`, accommodating a host that attaches late. The host must handle repeated handshake IDs without opening duplicate sessions.

A host loading editor metadata may defer accepting `connect` until that metadata is known, then send `hello` to request the same handshake again. It must not report `editor.available: false` merely because a manifest/publication fetch is still pending. The SDK's normal connection timeout bounds this wait; no request or accepted session is replayed.

The host must validate `event.source === iframe.contentWindow`, the iframe's expected origin, protocol, version, and message structure. It derives the block identity and permissions from trusted application state, never from the widget. Widgets must use a separate origin from the privileged host.

The host creates a fresh `MessageChannel` and retains one endpoint. It replies to the requesting iframe's exact origin, transferring exactly the other endpoint in the transfer list:

```ts
iframe.contentWindow.postMessage(
  {
    protocol: 'quillow:custom-block',
    version: 1,
    type: 'connected',
    connectionId: '<echo the request ID>',
    context: {
      blockId: '<trusted block ID>',
      versionId: '<running widget version ID>',
      mode: 'editor', // or 'public'
      capabilities: ['storage.get', 'storage.list', 'storage.set', 'storage.delete', 'editor.open'],
      editor: { available: true }, // optional editor UI extension; never includes the editor URL
    },
  },
  widgetOrigin,
  [channel.port2]
)
```

Both IDs must be non-empty strings. `capabilities` is a duplicate-free string array. Unknown capability names are retained for future extensions. A public host should advertise only read capabilities. Missing capabilities deny their corresponding methods. The legacy theme environment `published` corresponds to the KV mode `public`; `published` is not valid in this handshake.

`editor`, when supplied, must be an object with a boolean `available`. It reports whether a valid screen from the current block's `manifest.editor` is available. False means unavailable; omission means unknown (including legacy hosts), not false. This metadata does not grant access. Only editor-mode sessions with a permitted host UI handler and an available screen receive `editor.open`. The SDK freezes this metadata with the rest of the context. This optional extension requires no version bump and does not alter storage or theme-only integrations.

The SDK accepts only a response from its direct parent, with an HTTP(S) origin matching `parentOrigin` when configured, the exact connection ID, compatible version, valid context, and exactly one transferred port. Without an origin configured, the validated parent response establishes trust for this session. Other windows, origins, protocols, and session IDs are ignored. Once accepted, only the private port carries RPC messages; window messages cannot resolve RPC requests.

A host that cannot open the session can respond without transferring a port:

```ts
{
  protocol: 'quillow:custom-block',
  version: 1,
  type: 'connect-error',
  connectionId: '<echo the request ID>',
  error: { code: 'widget_not_available', message: 'This widget is not available' },
}
```

A correlated reply with an incompatible envelope version fails with `PROTOCOL_MISMATCH`. A host may instead use a v1 `connect-error` with that code to report incompatibility. Legacy hosts that do not implement `connect` are ignored and eventually cause `CONNECT_TIMEOUT`. Failed handshakes clean up handlers, timers and any ports received in the rejected correlated reply. Values must be strings regardless of an older SDK's broader input types; the host never automatically serializes non-string values.

## 2. RPC over the private port

Both endpoints call `port.start()` after adding listeners. All port messages retain the common envelope and connection ID. Each request has a non-empty `requestId`, unique within its connection. Do not share ports or pending-request maps across widgets.

Widget → host:

```ts
{
  protocol: 'quillow:custom-block',
  version: 1,
  connectionId: '<connection ID>',
  type: 'request',
  requestId: '<request ID>',
  method: 'storage.set',
  params: { key: 'settings', value: '{"theme":"dark"}', expectedRevision: '<opaque revision>' },
}
```

| Method / capability | Parameters                          | Success result                                     |
| ------------------- | ----------------------------------- | -------------------------------------------------- |
| `storage.get`       | `{ key }`                           | Entry or `null`                                    |
| `storage.list`      | `{ limit, after? }`                 | `{ entries: Entry[], nextCursor: string \| null }` |
| `storage.set`       | `{ key, value, expectedRevision? }` | Saved entry                                        |
| `storage.delete`    | `{ key, expectedRevision }`         | Literal `true`                                     |
| `editor.open`       | `{}`                                | Literal `true` when opening is accepted            |

### Block editor UI

`editor.open` asks the host to open the connected block's screen from `manifest.editor`, not a source-code editor. There are no URL, block ID, version ID or other parameters. The host owns URL validation, access checks and rendering; it must never navigate to a widget-selected URL. The UI handler is separate from the storage/backend adapter.

- Public sessions always fail with `PERMISSION_DENIED`, even if a capability was advertised incorrectly.
- In editor mode, an explicitly unavailable screen (`context.editor.available === false`) fails with `EDITOR_UNAVAILABLE`. The SDK can reject this locally without sending an RPC. Missing capability or UI support otherwise fails with `PERMISSION_DENIED`; unknown availability cannot be reported as a missing manifest editor.
- Independently validate current identity, permissions, availability and empty parameters before opening. Extra parameters fail with `INVALID_ARGUMENT`. A definite unavailable-screen rejection from the handler uses `EDITOR_UNAVAILABLE`; unexpected UI failures use a safe `HOST_REQUEST_FAILED` error, never raw internal details.
- Success means the host accepted opening its existing modal, not that the editor iframe loaded, settings were saved or the modal closed. The SDK maps literal `true` to `Promise<void>`; other results fail with `PROTOCOL_ERROR`.
- Repeated calls must reuse the modal, not create nested/duplicate windows. Replayed request IDs follow the same deduplication rules as storage. Do not give the settings iframe itself an opening handler/capability.
- No automatic retries or reconnects. A timeout does not prove the UI did not open. This is not a storage mutation: `mutationMayHaveSucceeded` remains false for editor requests, including timeout, teardown and malformed confirmations.

### Storage entries

Entry shape:

```ts
{
  key: string,
  value: string,
  revision: string,
  createdAt: string, // RFC 3339 timestamp; fractional seconds are preserved
  updatedAt: string,
}
```

The `value` field must exist and be a string, including for empty strings. A missing entry is a null entry, not an entry with an omitted value. Revisions are non-empty opaque tokens, not counters. Values are opaque UTF-8 text without zero bytes or lone surrogates. Preserve their exact contents; do not parse, normalize, or coerce them. Reject null, objects, arrays, numbers, booleans, undefined and other structured-clone values. The host/backend limit values to 65,536 UTF-8 bytes, without counting JSON transport escaping. Structured data requires explicit application-owned serialization and validation.

Keys are 1–128 UTF-8 bytes and cannot contain Unicode control characters or lone surrogates. SDK list limits are 1–100, default 50. Cursors are non-empty strings passed back without modification. `nextCursor: null` terminates pagination; an empty page must have a null cursor. Pages cannot contain duplicate keys or more entries than requested. Preserve backend ordering and cursor semantics.

Host → widget success:

```ts
{
  protocol: 'quillow:custom-block',
  version: 1,
  connectionId: '<connection ID>',
  type: 'response',
  requestId: '<echo the request ID>',
  ok: true,
  result: null, // replace with the method's actual result
}
```

Host → widget error:

```ts
{
  protocol: 'quillow:custom-block',
  version: 1,
  connectionId: '<connection ID>',
  type: 'response',
  requestId: '<echo the request ID>',
  ok: false,
  error: {
    code: 'widget_storage_conflict',
    message: 'Widget storage entry changed; read it again before updating',
    details: { key: 'settings' }, // optional JSON data; omit when unavailable
  },
}
```

A response has exactly one of `result` or `error`. Error code and message must be non-empty strings. Flatten the backend error's code into `error.code` without renaming it. Only forward safe, intentional details; never forward tokens, cookies, authorization headers, or raw internal exceptions. Preserve unknown backend codes as well as known conflict, quota, validation and authorization codes.

The SDK correlates responses to pending request IDs, allows out-of-order replies, and ignores unknown, expired or duplicate response IDs. A foreign connection ID cannot complete a request. Invalid envelopes terminate the connection. Method-specific invalid results reject that operation with `PROTOCOL_ERROR`; invalid mutation confirmations mark the mutation outcome as unknown. Unexpected additional ports are not allowed in RPC messages.

## 3. Host authorization and persistence

- Bind a session to the host's block ID and running version. KV belongs to the block, not the version; never expose a caller-selectable block or namespace.
- Authorize each operation using current trusted application state, not only the handshake snapshot. Public sessions may only call get/list and must never open the block editor; editor mutations also require the corresponding capability and backend authorization.
- Use the existing public backend queries for public reads and the owner queries for editor reads. Only the host makes authenticated mutations. No authenticated GraphQL or user tokens are passed into the iframe.
- Validate all parameters, string values, key/revision formats, quotas and backend results independently of the SDK. JSON is still allowed in safe error details, not as a storage value type. Treat the iframe as untrusted; do not accept a widget's claimed permissions or extra identity/scope fields.
- Omitting `expectedRevision` means create only. Never convert it into an upsert. A supplied revision performs a conditional update; deletion always requires one. Forward conflicts without automatic retries, merges, or overwrites.
- Do not retry mutations in either host or SDK after a timeout or transport failure. Completion of the backend mutation does not imply delivery of the response. Deleting/recreating a key must not reuse its old revision.
- Reply on the requesting session's port only. A result arriving after iframe removal/navigation must not be delivered to a replacement session. Release every retained port/session when its iframe is removed, navigates, disconnects or fails a liveness check.

## 4. Liveness and teardown

Both endpoints must respond to a valid `ping` with a `pong` carrying the same `requestId`, connection ID, and version:

```ts
{ ...envelope, type: 'ping', requestId: '<probe ID>' }
{ ...envelope, type: 'pong', requestId: '<same probe ID>' }
```

The SDK probes every 15 seconds in a visible document and expects a matching pong within 10 seconds. A pong for a different probe cannot satisfy it. Probes pause and their watchdog is cleared while the document is hidden; becoming visible starts a fresh probe interval. Hosts must tolerate browser background suspension and implement their own appropriate liveness cleanup. Do not rely on `MessagePort.close()` notifying the other endpoint in every browser.

Either endpoint can send `{ ...envelope, type: 'disconnect', reason?: string }` before closing its port. Host changes to block ID, version ID, mode, capabilities or editor availability require terminating the old session, not silently retargeting it. Widget authors can explicitly call `connect()` again; there is no automatic reconnection or replay.

The SDK also closes on document `pagehide`, decode failure, incompatible protocol or heartbeat failure. `destroy()` closes only its own session, clears request/heartbeat timers, removes listeners, and rejects all pending operations. It is idempotent. A failed per-request timeout removes that waiter but does not itself terminate the session.

For sent mutations whose confirmation is lost through timeout, disconnection, destruction, or malformed replies, `WidgetSDKError.mutationMayHaveSucceeded` is true. Re-read and reconcile explicitly. Destruction is not cancellation or rollback of a backend request that may already have committed.
