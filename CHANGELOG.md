# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-10-14

### Added

- `src/lancedb-support.ts` reports up front that LanceDB ships one native binary per
  platform and that there is no `lancedb-darwin-x64` build (there is no WASM
  fallback), so the embedded store is unavailable on macOS on Intel — instead of
  failing later with a module-not-found error.

### Changed

- **The own index now defaults to embedded LanceDB** instead of inheriting Kilo's
  `vectorStore`. Kilo's setting is read as `kiloVectorStore`: it still decides where
  an *import* reads from, and it is still reported, but it no longer decides where
  the own index writes to. Dropping that inheritance is reported as a warning rather
  than applied silently, so an existing Qdrant own index is not discovered to be
  empty.
- npm releases are now automated: pushing a `v*` tag triggers a GitHub Actions
  workflow that publishes through npm trusted publishing (OIDC), with no
  long-lived token.

## [0.1.0] - 2026-10-09

First public release.

### Added

- `indexing_search`, `indexing_status`, `indexing_refresh`, `indexing_build` and
  `indexing_import` tools.
- Read-only reuse of Kilo Code indexes (Qdrant `ws-*` collections and Kilo's
  local LanceDB database).
- Import of Kilo vectors and chunks at zero embedding cost, with an incremental
  delta after the import.
- Own index (Qdrant `oc-*` collections or embedded LanceDB) with a
  manifest-based incremental indexer keyed on per-file SHA-256.
- Results from Kilo and the own index merged, with fresher own hits winning on
  overlap and ghost hits filtered out.
- `/indexing-config` server command (works in terminal, Desktop and web) and the
  `/indexing` terminal settings page.
- Prompt-footer index status indicator.
- Cross-platform installer (`install.mjs`, plus `install.sh` / `install.ps1`
  wrappers).

[Unreleased]: https://github.com/Javierkaiser/opencode-indexing/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Javierkaiser/opencode-indexing/releases/tag/v0.1.1
[0.1.0]: https://github.com/Javierkaiser/opencode-indexing/releases/tag/v0.1.0
