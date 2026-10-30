# @quillow/custom-block-sdk

Framework-independent SDK for authors of Custom Blocks embedded in Quillow. Provides live theme and layout updates without reloading the iframe. Requires a modern browser with `postMessage`.

## Install

```sh
npm install @quillow/custom-block-sdk
```

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

Use `createCustomBlockSDK({ parentOrigin: 'https://your-page.example', applyStyles: false })` for a separately managed instance or JS-only integration. Use one active SDK instance per document when applying styles.

## Plain HTML / ZIP blocks

Copy `dist/runtime.js` from this package into the ZIP next to `index.html`:

```html
<script src="./runtime.js"></script>
<style>
  body {
    margin: 0;
    color: var(--quillow-text-color-v2, #222);
    background: var(--quillow-surface-color-v2, white);
    font-family: var(--quillow-typography, sans-serif);
  }
  button {
    background: var(--quillow-accent-color, purple);
    color: var(--quillow-accent-text-color, white);
    border-radius: var(--quillow-radius-v2, 16px);
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
| `--quillow-text-color-v2`     | Primary text color                      |
| `--quillow-surface-color-v2`  | Primary surface color                   |
| `--quillow-radius-v2`         | Actual block wrapper corner radius      |

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
