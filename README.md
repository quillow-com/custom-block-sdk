# @quillow/custom-block-sdk

[![npm version](https://img.shields.io/npm/v/@quillow/custom-block-sdk)](https://www.npmjs.com/package/@quillow/custom-block-sdk)

Framework-independent SDK for authors of Custom Blocks embedded in Quillow. Connects to the host for block context, string storage and opening the block editor, and provides live theme and layout updates. Requires a modern browser; host connections also require a secure context and `MessageChannel` support in the host.

## Install

```sh
npm install @quillow/custom-block-sdk
```

## Connect and store strings

```ts
import { connect, WidgetSDKError } from '@quillow/custom-block-sdk'

const widget = await connect({
  // Optional: pin the embedding host when its origin is known.
  parentOrigin: 'https://your-page.example',
  timeout: 10_000,
  requestTimeout: 10_000,
})

console.log(widget.blockId, widget.versionId, widget.mode, widget.capabilities)

const settings = await widget.storage.get('settings')
const page = await widget.storage.list({ limit: 50 })
// Fetch the next page explicitly with { after: page.nextCursor, limit: 50 } when non-null.

if (widget.mode === 'editor' && widget.capabilities.includes('storage.set')) {
  try {
    const saved = await widget.storage.set('settings', JSON.stringify({ theme: 'dark' }), {
      expectedRevision: settings?.revision,
    })

    if (widget.capabilities.includes('storage.delete')) {
      await widget.storage.delete('settings', { expectedRevision: saved.revision })
    }
  } catch (error) {
    if (error instanceof WidgetSDKError && error.code === 'widget_storage_conflict') {
      // Read again and let the user decide how to resolve the conflict. No automatic overwrite.
    } else {
      throw error
    }
  }
}

widget.destroy()
```

`connect()` also works without options. Both timeouts default to 10 seconds and must be positive integer milliseconds. Outside an iframe it rejects with `HOST_UNAVAILABLE`. A missing or legacy-only host causes `CONNECT_TIMEOUT`; failed connections remove their listeners and timers. Importing the package has no browser side effects.

**Host support is required.** This repository implements the widget side, not the host's storage proxy or editor UI. Storage and editor requests use the v1 connection contract in [PROTOCOL.md](./PROTOCOL.md); the theme/layout API also remains v1. Published SDK 0.4.0 can already exchange string values over this protocol. Its broader `JsonValue` input types do not permit non-string storage values: the host rejects them without automatic serialization. This SDK narrows those types and validates strings before sending.

### Storage contract

There is one `widget.storage`. It has no public/private namespaces, `scope` option, or caller-supplied block ID. The host binds it to the connected block. `versionId` identifies the running code, not a separate KV namespace.

| Method                                    | Result                       |
| ----------------------------------------- | ---------------------------- |
| `get(key)`                                | `StorageEntry` or `null`     |
| `list({ after?, limit? }?)`               | `{ entries, nextCursor }`    |
| `set(key, value, { expectedRevision? }?)` | Saved `StorageEntry`         |
| `delete(key, { expectedRevision })`       | `true` on confirmed deletion |

A record contains `key`, `value`, `revision`, `createdAt`, and `updatedAt`. Timestamps remain RFC 3339 strings. Revisions are opaque strings; use a token returned by a previous read or write, never a calculated revision.

- Missing records are `null`. An existing record can contain `value: ''`; `null`, objects, arrays, booleans and numbers are not valid values.
- Omitting `expectedRevision` (or passing `undefined` for that option) creates only. It never overwrites an existing key. Updates and deletes require a revision.
- Every operation requires its matching capability: `storage.get`, `storage.list`, `storage.set`, or `storage.delete`. Public connections can only read, even if the host advertises a write capability. Writes require editor mode. These are convenience checks; host and backend must independently authorize every request.
- Keys are 1–128 UTF-8 bytes, without control characters or lone surrogates. Keys are not trimmed or normalized. List limits are integers from 1 to 100, defaulting to 50. Cursors are passed back unchanged.
- Values are opaque UTF-8 strings. No parsing, trimming, coercion or automatic serialization occurs. Empty strings and whitespace are preserved; zero bytes and lone surrogates are rejected. JSON, CSV, Markdown or plain text are application choices. For structured settings, call `JSON.stringify` before writing and validate the result of `JSON.parse(entry.value)` after reading. Never parse a missing entry or assume all values contain JSON.
- Size/count quotas are enforced by the host/backend. The current backend allows 64 KiB of UTF-8 text per value, 256 entries and 1 MiB per block including key bytes. JSON transport escaping does not count toward the value quota. Quota failures preserve the backend's error code.

Existing database values are migrated to their serialized JSON text without interpreting them. For example, an old object becomes `'{"theme":"dark"}'`, JSON null becomes `'null'`, and an old JSON string retains its quotes. Handle any application-specific migration explicitly; the SDK does not decode legacy data. Widget manifest `schemaVersion` stays `1`, independently of the KV protocol version.

### Open the block editor

`openEditor()` asks Quillow to open the current block's screen from `manifest.editor`. It does not open a source-code editor or accept a caller-selected URL. It is available on the widget returned by `connect()`, not the separate theme/layout `Quillow` instance.

```ts
const widget = await connect()

if (widget.capabilities.includes('editor.open')) {
  await widget.openEditor()
}
```

- Requires editor mode and the `editor.open` capability. Published/public sessions cannot open the editor.
- Resolves with `undefined` when the host accepts opening the existing modal, not when its iframe finishes loading or the user closes it. Repeated calls do not create additional modals. Closing it refreshes the block preview so it can read saved settings.
- A host reporting `widget.editor.available === false` causes an immediate `WidgetSDKError` with code `EDITOR_UNAVAILABLE`. This means no valid `manifest.editor` screen is available. `PERMISSION_DENIED` means the mode or capability does not allow opening it.
- `widget.editor` is optional, immutable availability metadata. Its absence on an older host does **not** establish that the manifest has no editor. Without the capability, the call fails with `PERMISSION_DENIED`, without waiting for a request timeout.
- If the host is still loading the applied block's editor metadata, it defers the handshake rather than reporting a missing screen. The usual `connect()` timeout still applies.
- The host independently checks current identity, access and availability. Opening requests are never retried automatically. After a timeout the modal may still have opened; `mutationMayHaveSucceeded` is reserved for storage writes and remains false for this UI request.

The editor preview currently disables pointer events inside its iframe to preserve grid dragging. This method supports programmatic calls; it does not make buttons inside that preview clickable.

### Errors and connection lifetime

`WidgetSDKError` extends `Error` and exposes `code`, optional JSON `details`, and `mutationMayHaveSucceeded`. Backend codes are preserved verbatim, including unknown future codes. Current storage codes include `widget_storage_conflict`, `widget_storage_quota_exceeded`, `widget_storage_invalid`, and `widget_storage_not_found`; authorization codes also pass through unchanged.

SDK-local codes are `HOST_UNAVAILABLE`, `CONNECT_TIMEOUT`, `REQUEST_TIMEOUT`, `PROTOCOL_MISMATCH`, `PROTOCOL_ERROR`, `DISCONNECTED`, `DESTROYED`, `INVALID_ARGUMENT`, `PERMISSION_DENIED`, and `EDITOR_UNAVAILABLE`.

**Mutations are never retried.** A request timeout does not mean the write failed. When `mutationMayHaveSucceeded` is true, re-read and reconcile explicitly; do not blindly resend. Closing or destroying a connection cannot undo an already dispatched mutation. A single request timeout does not close an otherwise healthy connection.

Each call to `connect()` creates an independent session and `MessagePort`. The SDK validates the parent window, origin, protocol version, handshake correlation ID, and message formats. Without `parentOrigin`, it trusts the direct parent that completes a valid handshake; this is not proof that the parent is operated by Quillow. Pin the origin when that distinction matters. No user tokens or authenticated GraphQL requests enter widget code.

`destroy()` is idempotent. It closes that session, removes its handlers, clears timers, and rejects pending work with `DESTROYED`. Host disconnects, document unloads, decode failures and missed heartbeats also terminate pending work. Heartbeats pause while the document is hidden. Connections never reconnect or replay requests automatically; call `connect()` explicitly for a new session. The host must close a session if its block identity, version, mode, capabilities or editor availability change.

## Theme and layout

```ts
import { Quillow } from '@quillow/custom-block-sdk'

const context = await Quillow.ready()
console.log(context.layout)

// Immediately replays the current context, then receives every change.
const unsubscribe = Quillow.subscribe((context) => {
  renderChart(context.layout.width, context.layout.height)
})

// When no longer needed:
unsubscribe()
// Quillow.destroy() // permanently stops this SDK instance
```

Importing the ESM module is SSR-safe and has no DOM side effects. `ready()`, `subscribe()` or `start()` starts the bridge. `ready({ timeout: 10000 })` rejects if the host does not respond; a timeout does not stop the bridge. Call `ready()` again after a timeout if needed. `ready()` means context is available, not that web fonts have finished loading; use the browser Font Loading API for font-dependent measurements.

Use `createCustomBlockSDK({ parentOrigin: 'https://your-page.example', applyStyles: false })` for a separately managed instance or JS-only integration. Use one active SDK instance per document when applying styles. `connect()` is independent of this theme bridge: it does not apply styles, and `Quillow.destroy()` does not destroy separately connected KV sessions (or vice versa).

## Plain HTML / ZIP blocks

Copy `dist/runtime.js` from this package into the ZIP next to `index.html`:

```html
<script src="./runtime.js"></script>
<style>
  body {
    margin: 0;
    color: var(--quillow-text-color, #222);
    background: var(--quillow-surface-color, white);
    font-family: var(--quillow-typography, sans-serif);
  }
  button {
    background: var(--quillow-accent-color, purple);
    color: var(--quillow-accent-text-color, white);
    border-radius: var(--quillow-radius, 16px);
  }
  html[data-quillow-viewport='mobile'] .details {
    display: none;
  }
  html[data-quillow-size='2:2'] .card {
    flex-direction: column;
  }
</style>
<script>
  window.Quillow.subscribe((context) => console.log(context.layout))
</script>
```

The standalone runtime auto-starts inside an iframe and exposes `window.Quillow`. Do not load it alongside a bundled ESM SDK instance. Variables and attributes are available after the first host response; CSS fallbacks cover the initial render and standalone previews.

For automatic integration, the widget hosting/ZIP pipeline must copy the versioned runtime into each package and insert its script before the author's scripts. That backend is outside this repository; existing ZIPs must currently include the script or bundle the npm SDK. Parent code cannot inject a runtime into a cross-origin iframe. The widget's CSP must permit the runtime, inline style attributes used for variables, and the provided font stylesheet/font origins (currently Google Fonts).

## Context

```ts
interface BlockContext {
  theme: {
    mode: 'light' | 'dark'
    cornerStyle: 'Normal' | 'Pill' | 'Sharp'
    variables: Readonly<Record<string, string>>
    fontStylesheet: string | null
  }
  layout: {
    size: '1:1' | '2:1' | '2:2'
    width: number
    height: number
    viewport: 'mobile' | 'desktop'
  }
  environment: 'editor' | 'published'
}
```

- Size is **columns:rows** of the active layout: `sm → 1:1`, `md → 2:1`, `lg → 2:2`. The current grid has no `1:2` size. Mobile and desktop can have different saved layouts.
- Width/height are the iframe's content-area dimensions in CSS pixels, independent of transforms.
- Viewport is the **page layout mode**, including the editor's mobile preview. A narrow desktop block is still `desktop`.
- CSS media queries inside the block continue to respond to the **iframe's** width.
- Context snapshots are frozen. Subscriptions receive full snapshots, not patches.

### CSS contract

The runtime sets these attributes on `<html>`: `data-quillow-theme`, `data-quillow-size`, `data-quillow-viewport`, `data-quillow-corner-style`, `data-quillow-environment`.

The Quillow host provides resolved values for:

| Variable                      | Meaning                                 |
| ----------------------------- | --------------------------------------- |
| `--quillow-accent-color`      | Selected accent color                   |
| `--quillow-accent-text-color` | Contrasting text on the accent          |
| `--quillow-typography`        | Selected font family and fallback stack |
| `--quillow-text-color`        | Primary text color                      |
| `--quillow-surface-color`     | Primary surface color                   |
| `--quillow-radius`            | Actual block wrapper corner radius      |

The runtime manages one font stylesheet, replaces it on font changes, removes obsolete variables, and restores previously existing inline values/attributes on `destroy()`. It does not reset the author's CSS or force these tokens onto elements.

## Development and release

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
pnpm format:check
```

Use Node.js 24 and pnpm 10.33.0 for development. Build before testing the package in a consuming app: its exports point at `dist`.

The package contains ESM entry points, declarations, source maps and a standalone IIFE (`dist/runtime.js`). It has no runtime dependencies. `prepack` rebuilds the artifacts.

### Releases

Releases are managed by [release-please](https://github.com/googleapis/release-please) in `.github/workflows/publish.yml`:

1. Merge changes into `main` using Conventional Commits (`fix: ...`, `feat: ...`, `feat!: ...`). With squash merging, use a Conventional Commit PR title.
2. The **Release and publish** workflow opens or updates a release PR with the next `package.json` version, `CHANGELOG.md` entries and `.release-please-manifest.json`.
3. Review and merge that PR. The next workflow run creates the `vX.Y.Z` tag and GitHub Release.
4. In the same run, the publish job checks the tagged version, runs formatting, types and tests, builds the package, attaches its `.tgz` to the release and publishes to npm with provenance.

The initial version is `0.1.0`. Before `1.0.0`, fixes increment the patch version and features or breaking changes increment the minor version. Routine `chore`, `docs`, and `ci` commits alone do not require a release. Do not manually bump versions or create tags for normal releases.

The generated changelog is excluded from formatting checks.

If npm publication fails after a GitHub Release is created, fix the cause and manually run **Release and publish** with that existing tag (or `gh workflow run publish.yml -f tag=vX.Y.Z`). Existing release archives are preserved on retries. Already published npm versions cannot be republished.

The package's **Trusted Publisher** on npmjs.com is configured for organization `quillow-com`, repository `custom-block-sdk`, workflow `publish.yml`, with direct publishing allowed. Workflow releases authenticate using GitHub OIDC, without a stored npm token.

The repository must allow GitHub Actions to create pull requests (Settings → Actions → General → Workflow permissions). By default release-please uses `GITHUB_TOKEN`; publishing runs in the same workflow because events created by that token do not trigger other workflows. For automatic CI checks on bot-created release PRs, optionally configure `RELEASE_PLEASE_TOKEN` as a GitHub App installation token or a fine-grained PAT with repository Contents and Pull requests read/write permissions. Otherwise, run the **CI** workflow manually on the release PR branch before merging; the publish job also runs all checks before publishing.

Consumers should pin a released package version. Protocol changes must remain compatible with previously published blocks; a breaking protocol requires a new protocol version, not just a package version bump.
