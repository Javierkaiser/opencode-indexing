# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.6] - 2026-10-27

### Changed
- **Verified against OpenCode 2.2 and OpenTUI 0.7.** OpenTUI 0.7 moves custom
  renderables onto construction-time hooks and replaces
  `defineNativeIntegration()`; this plugin uses neither, and its only OpenTUI
  surface — the JSX runtime (`jsx`/`jsxs`/`Fragment`) and
  `createTextAttributes` — is unchanged. The virtual module scheme the TUI
  relies on is unchanged in 2.2 as well, so there is no runtime change here:
  the development dependencies move to `@opentui/* 0.7` and the 2.2 SDK so the
  typecheck matches the host, and the optional peer ranges stay at `>=0.5.17`
  because both 0.6 and 0.7 work. Because `@opentui/*` are optional peers rather
  than dependencies, the new install-time requirement — plugins that pin
  OpenTUI 0.6 fail to install — does not apply.

## [0.3.5] - 2026-10-20

### Changed
- **The TUI consumes the host's runtime instead of installing its own.** The
  terminal code imports the host singletons by virtual module id
  (`opentui:runtime-module:…`) and uses no JSX, and `solid-js`, `@opentui/core`
  and `@opentui/solid` are no longer installable dependencies (they remain dev
  dependencies and optional peers). A plugin installed from an npm spec used to
  load its own copies from `node_modules`, and the host never bridged the Solid
  runtime: the settings page and the footer indicator painted once and never
  updated — upstream
  [anomalyco/opencode#33884](https://github.com/anomalyco/opencode/issues/33884).

### Added
- The settings page and the dialog menu show the plugin version, so a report
  about either names the build it came from.

### Fixed
- **Escape from the settings page returns to the session it was opened from**,
  instead of navigating to the home screen and losing the user's place.

### Documentation
- The README's *Requirements* no longer says the plugin installs ~14 MB of
  SolidJS/OpenTUI runtime; it states that the host provides those modules and
  the TUI consumes them by virtual module id.
- `THIRD_PARTY_NOTICES.md` moves `solid-js`, `@opentui/core` and
  `@opentui/solid` out of the distributed runtime dependencies: installing the
  package no longer brings copies of them.

## [0.3.4] - 2026-10-19

### Changed
- `@opentui/core` and `@opentui/solid` move to 0.6.6, and `@opencode/plugin`
  to 2.0.31 alongside them. That bump had been stuck: 0.6 was uninstallable
  on Node 22 while the JSX runtime was optional, because npm skips an
  optional dependency whose engine does not match. Declaring it as a real
  dependency is what let the install through, and the group now passes on
  all three platforms.

## [0.3.3] - 2026-10-19

### Changed
- `@opentui/core`, `@opentui/solid` and `solid-js` move from
  `optionalDependencies` to `dependencies`. They declare
  `engines.node >= 26.4.0`, and npm **skips** an optional dependency whose engine
  does not match the running Node instead of warning about it. On Node 22 — which
  this package supports — that meant an install from the registry came out
  without the three of them, no error, and a TUI that rendered nothing:
  verified by installing the published 0.3.2 under the CI's exact Node
  (v22.23.3), which produced 115 packages and none of the three. As regular
  dependencies they warn about the engine and install anyway — 477 packages,
  all three present — so the failure is loud instead of invisible. A platform
  where they genuinely cannot install now fails the install rather than shipping
  a TUI that renders nothing.

## [0.3.2] - 2026-10-19

### Fixed
- **A Kilo index written before `fileHash` existed could not be read at all.** The
  LanceDB read asked for a fixed column list, and LanceDB fails the whole query
  when one of those columns is missing — so a single absent field made an entire
  database unreadable, even though every chunk in it was still usable. Discovery
  reported the index and the import died on the first page. Reads now select the
  intersection with the table's real schema, and a chunk without a hash imports
  like any other; it only costs the manifest seed, which falls back to re-reading
  the file on the next refresh.
- The bug surfaced while checking that the `@lancedb/lancedb` 0.26.2 → 0.40.0
  bump was safe for the Kilo compatibility the old pin existed for. It is: 26
  real Kilo databases and a store written by the previous version all read
  unchanged, vectors included. The same read fails identically on 0.26.2, so this
  was never a version problem.

### Changed
- `@lancedb/lancedb` 0.26.2 → 0.40.0. The old pin existed to match the copy
  Kilo Code uses, so it was checked against real data before moving: 26 Kilo
  databases on a working machine and a store written by the previous version
  all read unchanged, vectors included. The pin is no longer load-bearing.
- `@types/node` follows the oldest supported runtime (`^22`) instead of
  running ahead of it. Types newer than `engines.node` let an API that does
  not exist in Node 22 typecheck cleanly, which is a trap rather than a
  feature. TypeScript moves to 7 alongside it.

### CI
- Dependabot no longer proposes the `@opentui` major: 0.6 declares
  `engines.node >= 26.4.0`, npm marks it optional in the lock, and an
  optional dependency whose engine does not match is skipped rather than
  warned about — on the Node 22 the CI runs, the TUI deps vanish and the
  typecheck fails on missing modules. Verified with the CI's exact Node.

## [0.3.1] - 2026-10-16

### Documentation
- The README's code-graph section is no longer a roadmap. It said the plugin
  "deliberately stays on the semantic side" and offered `indexing_graph_*` tools
  as a future major version — both untrue once codegraph became a companion.
  Rewritten around the two indexes: what each costs to keep fresh, what the
  benchmark does and does not measure, how to move from one to the other, and an
  explicit note that the graph tools are withdrawn rather than pending. The
  install-time detail moved to *Install*, where `--with-codegraph` already
  lives, instead of being restated here.

### Fixed
- **The installer named the wrong package.** `install.mjs` and the skip message
  in `src/codegraph.ts` both said `codegraph`, which on npm is an unrelated 2024
  library by a different author with no binary at all. `npm install -g codegraph`
  exits 0, puts nothing on `PATH`, and the step then reports success — the worst
  shape of failure for an installer. The real package is
  `@colbymchenry/codegraph`, which is what the CLI already on this machine came
  from. Both call sites now use the scoped name, and a test reads `install.mjs`
  and asserts the unscoped install never appears.
- **The PowerShell wrapper could not pass `--with-codegraph`.** `install.mjs`
  implemented the flag and `install.sh` forwards every argument, but
  `install.ps1` declared only five switches, so on Windows the recommended
  install was impossible through the wrapper. The switch exists now, and both
  wrappers record the preferred `npx` form.
- The prompt-footer skill now tells the model that codegraph exists. It listed
  `Grep` as the answer for exact symbols and never mentioned the graph tools at
  all, so an assistant had no way to know the structural half was available —
  the same class of problem as an indicator that renders nothing: the capability
  was there and invisible. The guidance is conditional on the MCP server being
  present, because it is optional.
- `THIRD_PARTY_NOTICES.md` was missing four packages it distributes:
  `solid-js`, `@opentui/core`, `@opentui/solid` (shipped since 0.2.4) and
  `apache-arrow`, which had never been listed. Licenses read from the installed
  manifests, not from memory. CodeGraph gets its own section: not bundled, MIT
  per its manifest, and the license text is linked rather than reproduced
  because the package ships no `LICENSE` file and declares no author, so there
  is no copyright line this project can verify.
- *How it works* and *Where each index lives* now show codegraph. The diagram
  had one index and the table had two; there are three.
- `indexing_search` and `indexing_status` descriptions mention the companion.

### CI
- The release workflow now creates the GitHub Release itself, attaching the
  tarball that was actually published and taking its notes from this file. It
  also stopped hiding its own failures: the download ran under `--silent`
  inside a `pipefail` pipeline, so a registry hiccup failed the step with no
  output at all to explain it — which is how three versions shipped without a
  release page.
- Dependabot groups only what can move together. The old type-based groups
  paired dependencies that contradict each other (`apache-arrow` against
  `@lancedb/lancedb`'s peer ceiling, `@opencode/plugin` against the pinned
  `@opentui` packages), and `npm ci` failed with ERESOLVE before any test ran.

## [0.3.0] - 2026-10-16

### Added
- **`indexing_build` and `indexing_import` now also start codegraph** for the
  workspace, so the semantic index and the code graph are built by the same
  action instead of one silently going stale. `init` the first time a folder is
  seen, `sync` afterwards — the second is what covers the case where codegraph's
  daemon has already shut down, which it does after five minutes without
  clients.

  **codegraph is a companion, not a dependency.** Nothing about this plugin
  requires it: with the CLI absent, `available()` returns false, nothing is
  spawned, no build fails, and no line is added to the output. That path is
  covered by a test that hides codegraph from `PATH` and runs the real spawner,
  not a fake — an injected runner would have proved the logic while leaving the
  wiring unchecked.

- `codegraph` setting, on by default (`/indexing-config set codegraph=false` to
  turn it off). Read as `!== false`, because the key is in no config file anyone
  has and a default that required it to be present would never apply.

- One line in `indexing_status` saying whether codegraph is indexed for the
  folder. Read from the filesystem, so it costs no process — status runs on
  every search through the footer.

### Changed
- The build summary reports the codegraph command it started, and always in the
  past tense of a *launch*, never of a success: the process is detached, so at
  the moment the tool answers, codegraph has only begun. Anything that goes
  wrong afterwards lands in `.codegraph/daemon.log`, which is where the message
  points.

### Notes for review
- A dangerous workspace root — the home directory or a drive root — is refused
  rather than indexed. codegraph has `-f` for exactly that case, and passing it
  because a tool call said so would index the whole machine.
- Launches are rate-limited per workspace to one per 15 seconds, because
  codegraph runs its own daemon with a file watcher and two `sync` invocations
  seconds apart contend for the same SQLite database.
- `.codegraph/` was already excluded from the scanner (every dot-directory that
  is not explicitly allowed is skipped), and there is now a test pinning it:
  codegraph writes a multi-megabyte SQLite database plus a WAL there, and
  letting the scanner walk it would embed another indexer's storage into this
  one, for money, forever.

## [0.2.4] - 2026-10-16

### Fixed
- **The prompt-footer indicator stopped rendering after OpenCode 2.0.30.** The
  footer view imports `createSignal` from `solid-js` as a value, and `solid-js`,
  `@opentui/core` and `@opentui/solid` were declared as *optional
  peerDependencies* — which means npm never installs them, on the assumption that
  the host already provides them. 2.0.30 stopped providing them, the plugin's own
  `import()` of the footer view failed, the `catch` swallowed it, and the slot
  rendered nothing. Everything else kept working, because nothing else needs
  JSX: the command palette comes from `tui.ts` itself, which is what made it look
  like a cosmetic regression rather than a missing dependency.

  The three packages are now `optionalDependencies`. That still tolerates a
  failed install, but unlike an optional peer it actually puts them on disk, so
  the indicator no longer depends on what the host happens to supply.

- **A package listed in both `optionalDependencies` and `devDependencies` is not
  installed at all.** npm 12 lets the dev list win, so `--omit=dev` skips the
  package and the optionalDependency never reaches disk — and `package.json`
  still reads as though it is declared. This is why moving the three packages
  was not by itself enough; they had to leave `devDependencies` as well.

- `tsconfig.json` is published. `jsx: react-jsx` with
  `jsxImportSource: "@opentui/solid"` is what makes a `.tsx` file load at all, and
  it was not in `files`.

### Added
- `test/package-deps.test.ts` guards the manifest against all three of the
  above, and asserts that every value import in the published sources resolves
  to something the manifest installs — so the next third-party import fails a
  test instead of becoming another silent missing module at load time.

## [0.2.3] - 2026-10-16

### Added
- `install.mjs` accepts `--with-codegraph`. It is **off by default** and only
  has effect in `--package` mode, as consent comes from passing the flag. When
  active it detects an existing `codegraph` CLI, installs it globally (`npm install
  -g codegraph`) if it is missing, and registers its MCP with OpenCode via
  `codegraph install --target opencode`. A failure in either step is reported and
  does not cancel this plugin's own install.
- The README now names `npx` (not `opencode plugin add`) as the recommended
  install method, and shows the companion install in the recommended command:
  `npx @javierkaiser/opencode-indexing --with-codegraph`.

## [0.2.1] - 2026-10-15

### Added

- **`opencode plugin add @javierkaiser/opencode-indexing` is now the documented
  install.** It was already possible — the package was published and exported
  `./tui` — but the README told people to run `npm install` and edit
  `opencode.json` by hand, which puts the package in whatever directory they were
  standing in and never tells OpenCode about it. The CLI command installs into
  OpenCode's own cache, records the entry, and brings the update and removal path
  (`plugin check`, `plugin update`, `plugin remove`) with it.
- **The installer has a package mode**, and picks between the two from where it
  runs: a checkout installs the working tree, an installed copy installs the
  published package. `npx @javierkaiser/opencode-indexing` therefore does the
  right thing with no flags, including the permission rules and the restart that
  `plugin add` alone does not do.
- `bin` in `package.json`, so `npx` has something to run.
- The plugin options and `ignoreKiloConfig` are documented in the README. The
  option existed in the code and had tests, but appeared in no documentation.

### Fixed

- **"No Kilo index found" for a workspace that has one.** The server plugin is
  instantiated for the directory the service runs in, so every RPC that omitted a
  `directory` described *that* project. `kilo.discover` took no directory at all,
  which is why opening the palette in one project and importing reported nothing
  while the footer, using the same client and passing the directory, looked
  correct. `kilo.discover` and `settings.test` now accept a directory, and the
  palette, the settings page and the index actions all send the caller's. The
  directory is injected once by `bindWorkspace` rather than passed at each call
  site, so a new workspace-scoped RPC is correct by default instead of correct by
  remembering.
- **The tools read and indexed the service's directory.** All seven were pinned to
  the plugin instance's root, so `indexing_search` in a session answered from
  another codebase — results from the wrong project read as plausible — and
  `indexing_import` refused an index that was sitting right there. They now use
  `context.directory`, with the instance root as the fallback for hosts that do
  not report one.
- **`@lancedb/lancedb` could never load, so no Kilo index was ever importable
  from LanceDB.** `apache-arrow` is that package's *peerDependency*, and the
  installer runs `npm install --omit=peer`, which drops peers from the tree: the
  native binary loaded and then threw `Cannot find module 'apache-arrow'` on first
  use. It is now declared explicitly. This also broke `vectorStore: lancedb`
  outright.
- **An unreadable index was reported as a missing one.** Discovery swallowed
  backend failures, so "Kilo is not running here" and "Kilo is not installed here"
  both surfaced as *No Kilo index found*. It now names the path it found and the
  reason it could not be read, in `indexing_status`, `indexing_build`,
  `indexing_config`, `settings test kilo`, the import tool and the empty-state
  toast. `indexing_build` is the one that matters most: with nothing reported, a
  build in a workspace whose Kilo index could not be read re-embedded everything
  without saying why.
- **`apache-arrow` is declared in `package.json`, not only in the installer.**
  It is a *peer* of `@lancedb/lancedb`, and the two install paths disagreed about
  peers: `install.mjs` runs `npm install --omit=peer`, which drops them, while
  the npm-based install OpenCode performs keeps them. Declaring it makes the
  dependency true for both instead of true for whichever path happened to be
  tested.
- The installer no longer keeps its own copy of the dependency list; it derives
  the installed `package.json` from the published one. That duplication is how
  `apache-arrow` came to be declared for one install path and missing from the
  other.
- `--package` deletes a previously copied plugin. Both sources define
  `id: "opencode.indexing"` and the config directory is scanned automatically, so
  leaving both would load the plugin twice.

## [0.2.0] - 2026-10-14

### Added

- **`gemini`, `voyage` and `openrouter` are implemented.** They were selectable in
  the provider list, passed every validation gate, and then threw
  `Unsupported embedder provider` once indexing had already started and been billed
  for a probe. A test asserted that they were unimplemented, which pinned the gap in
  place.
- **The model catalog is visible.** The TUI model field is now a chooser built from
  the catalog, with a *Custom* entry for anything not listed and for providers with
  no catalog at all. `indexing_config` lists every model with its dimension and
  whether Kilo also knows it — which is the whole answer to whether a free import
  will work.
- **Per-model input ceilings and per-provider batch limits.** The ceilings differ by
  more than an order of magnitude (`mxbai-embed-large` takes 512 tokens,
  `voyage-code-4` takes 32,000), and one global constant truncated every chunk past
  the smallest model's limit. Batch limits are now per provider: OpenAI caps a
  request at 300,000 tokens whatever the item count, Gemini accepts a fixed number of
  items, Voyage has both.
- `voyage-code-4`, `voyage-4`, `voyage-4-large`, `voyage-4-lite`,
  `gemini-embedding-2` and Ollama's `bge-m3` in the catalog, each marked as not
  present in Kilo's registry so it is clear they cannot be imported.
- `indexing_status` warns before a model change re-embeds the workspace, with the
  point count, rather than after the embeddings have been paid for.

### Changed

- **A search that cannot read part of the corpus now fails instead of shrinking.**
  An embedding failure per profile was pushed onto a list rendered as "Warnings", and
  the results that came back looked exactly like a complete set whose missing half
  ranked lower. An index holding points whose profile cannot be embedded is now an
  error naming the profile. An index with no points is not an error, so the common
  case is unaffected.
- Changing provider clears the model, because model ids are namespaced per provider.
  The previous code claimed to do this and did not, so switching to Voyage produced
  `voyage` + `codestral-embed-2505`, which outranks the provider default.
- The stored dimension of a previous index is no longer inherited across a provider
  change. A 1536-wide Mistral index made any new model look 1536-dimensional, and the
  inherited number was then persisted as though it had been measured, making the
  mismatch self-consistent and invisible on every later run.
- The `apiKeys` merge is derived from the incoming keys instead of a hand-written list
  of provider names, which silently dropped any credential added to the shape but not
  to the list.
- The settings page reports which providers have credentials instead of deriving it
  from two booleans, which reported "none configured" for a Gemini, Voyage,
  OpenRouter, Ollama or OpenAI-compatible setup.
- `indexing_config` and `settings test kilo` pass a target profile to the Kilo source
  scan. Without it every source was reported as compatible, including ones that would
  be refused a moment later.
- Ollama and Voyage are sent `truncate` / `truncation: false`, so an over-long chunk
  fails instead of being silently shortened into a valid-looking wrong vector.
- Embedding results are placed by `data[].index` where the provider supplies it.
  OpenAI documents the field rather than promising response order, and its own samples
  fetch by it; a repeated or out-of-range index is now an error.
- The catalog's `openrouter` Gemini entry names `google/gemini-embedding-2-preview`,
  which is what Kilo writes. It said `google/gemini-embedding-001`, and since the
  profile comparison is exact string equality the drift was invisible and made every
  such index un-importable.

### Fixed

- The model field is cleared on a provider change in the TUI as well as the chat
  command; both paths had the same stale-model bug.
- `searchCode` and `getStatus` had no unit tests — only the e2e and cli scripts
  exercised them, and those assert nothing. Both have tests now.

### Documentation

- The README states how far each provider has actually been tested. `mistral` has
  touched its real API; `openrouter` reached the API and authenticated but was
  refused by the key's own spend limit; `openai`, `gemini`, `voyage`,
  `openai-compatible` and `ollama` have never contacted a real endpoint and are
  covered only by fixtures written alongside their adapters. The same fact is
  surfaced in the model chooser and in `indexing_config`, and a test pins the list so
  the claim cannot quietly widen.

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

[Unreleased]: https://github.com/Javierkaiser/opencode-indexing/compare/v0.3.6...HEAD
[0.3.6]: https://github.com/Javierkaiser/opencode-indexing/releases/tag/v0.3.6
[0.3.5]: https://github.com/Javierkaiser/opencode-indexing/releases/tag/v0.3.5
[0.3.4]: https://github.com/Javierkaiser/opencode-indexing/releases/tag/v0.3.4
[0.3.3]: https://github.com/Javierkaiser/opencode-indexing/releases/tag/v0.3.3
[0.3.2]: https://github.com/Javierkaiser/opencode-indexing/releases/tag/v0.3.2
[0.3.1]: https://github.com/Javierkaiser/opencode-indexing/releases/tag/v0.3.1
[0.3.0]: https://github.com/Javierkaiser/opencode-indexing/releases/tag/v0.3.0
[0.2.4]: https://github.com/Javierkaiser/opencode-indexing/releases/tag/v0.2.4
[0.2.3]: https://github.com/Javierkaiser/opencode-indexing/releases/tag/v0.2.3
[0.2.1]: https://github.com/Javierkaiser/opencode-indexing/releases/tag/v0.2.1
[0.2.0]: https://github.com/Javierkaiser/opencode-indexing/releases/tag/v0.2.0
[0.1.1]: https://github.com/Javierkaiser/opencode-indexing/releases/tag/v0.1.1
[0.1.0]: https://github.com/Javierkaiser/opencode-indexing/releases/tag/v0.1.0
