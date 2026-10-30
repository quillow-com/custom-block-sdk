# Changelog

## [0.2.0](https://github.com/quillow-com/custom-block-sdk/compare/v0.1.1...v0.2.0) (2026-10-30)


### ⚠ BREAKING CHANGES

* **sdk:** remove host adapter and limit SDK to block authors

### Code Refactoring

* **sdk:** remove host adapter and limit SDK to block authors ([e0f0de1](https://github.com/quillow-com/custom-block-sdk/commit/e0f0de1648705ad78e36104eaf1d373da6221b01))

## [0.1.1](https://github.com/quillow-com/custom-block-sdk/compare/v0.1.0...v0.1.1) (2026-10-30)


### Bug Fixes

* isolate subscriber errors during context replay ([94ec278](https://github.com/quillow-com/custom-block-sdk/commit/94ec278286acf50ae84735a22aa5bf8f6e85dd5f))

## 0.1.0

- Initial standalone SDK release.
- Framework-independent `ready`, `subscribe`, `getContext`, `start` and `destroy` API.
- Theme variables, font stylesheet and layout data attributes.
- Versioned cross-origin host bridge with sender validation.
- ESM, TypeScript declarations and a standalone browser runtime.
