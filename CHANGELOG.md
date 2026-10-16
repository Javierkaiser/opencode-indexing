# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[Unreleased]: https://github.com/Javierkaiser/opencode-indexing/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Javierkaiser/opencode-indexing/releases/tag/v0.2.0
[0.1.1]: https://github.com/Javierkaiser/opencode-indexing/releases/tag/v0.1.1
[0.1.0]: https://github.com/Javierkaiser/opencode-indexing/releases/tag/v0.1.0
