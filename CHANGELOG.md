# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Javierkaiser/opencode-indexing/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Javierkaiser/opencode-indexing/releases/tag/v0.1.0
