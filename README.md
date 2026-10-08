# opencode-indexing

OpenCode plugin that adds **semantic code search** by reusing the code index created by [Kilo Code](https://kilo.ai) and maintaining its **own independent index** (Qdrant or embedded LanceDB), so search keeps working even when Kilo isn't installed, is disabled, or its index is stale.

## How it works

```
OpenCode ──► indexing_search ──┬──► Kilo's index (read-only)      Qdrant ws-*  ·  Kilo LanceDB
                               └──► own index (read/write)        Qdrant oc-*  ·  own LanceDB
```

- **Read-only reuse**: the plugin computes the same collection name Kilo uses (`ws-` + sha256 of the workspace path, first 16 hex chars), validates the embedding profile stored in the metadata point, and queries with an embedding from the *same* model (e.g. Mistral `codestral-embed-2505`, 1536d).
- **Import without re-embedding**: `indexing_build` (or `indexing_import`) can copy vectors + chunks from an existing Kilo index — both its Qdrant collections and its local LanceDB database — at **zero embedding cost**, then incrementally index only the delta.
- **Own index**: manifest-based incremental indexer (per-file sha256) writing to `oc-*` collections or an embedded LanceDB database, using the same chunk payload shape as Kilo (`filePath`, `fileHash`, `codeChunk`, `startLine`, `endLine`, `segmentHash`, `pathSegments`).
- **Merge**: results from Kilo + own are merged; own (fresher) hits win on overlap; ghost hits (deleted files) are filtered out.

## Tools (namespace `indexing`)

| Tool | Purpose |
| --- | --- |
| `indexing_search` | Semantic search across Kilo's index + own index. `{ query, path? }` |
| `indexing_status` | Backends, Kilo sources available for import, both indexes, freshness, recommendation |
| `indexing_refresh` | Incremental update of the own index (new/changed/deleted files only) |
| `indexing_build` | Build the own index: imports from Kilo when compatible, otherwise embeds from scratch. `{ rebuild?, skipImport? }` |
| `indexing_import` | Import a specific Kilo source without re-embedding. `{ source?, rebuild? }` |

## Settings

Three surfaces, all writing the same file through the server plugin's RPC.

### `/indexing-config` — works in every client (terminal, Desktop, web)

A server command, so it is available anywhere, including clients without a JSX renderer.

| Subcommand | Purpose |
| --- | --- |
| `/indexing-config` or `show` | Print the effective configuration and any warnings |
| `/indexing-config set <key>=<value>` | Change one setting. `set <key>` alone prints its current value; `set <key>=reset` reverts it |
| `/indexing-config test [target]` | Test connectivity: `qdrant`, `lancedb`, `provider`, `kilo` |
| `/indexing-config import [source]` | Import vectors from a Kilo source without re-embedding |
| `/indexing-config help` | List keys and subcommands |

Settable keys (case-insensitive):

| Key | Meaning |
| --- | --- |
| `vectorstore` | `qdrant` or `lancedb` |
| `qdranturl` / `qdrantapikey` | Qdrant connection |
| `lancedbdirectory` | LanceDB directory for the own index |
| `provider` / `model` | Embedding provider and model |
| `mistralkey` / `openaikey` / `geminikey` / `voyagekey` / `openrouterkey` | API keys for those providers |
| `ollamaurl` | Ollama base URL |
| `openaicompatibleurl` / `openaicompatiblekey` | OpenAI-compatible endpoint |
| `importfromkilo` | `true` to import from Kilo when building, `false` to start from scratch |
| `autorefresh` | Refresh the own index automatically on search |
| `enabled` | Master switch. `false` pauses writing and refreshing; search keeps reading Kilo's index |
| `searchmaxresults` | Result cap per search |
| `embeddingbatchsize` | Embedding batch size |
| `searchminscore` | Minimum similarity score |
| `fileextensions` | Extensions to index |

### `/indexing` — settings page (terminal TUI)

Opens a full settings page: current configuration, detected Kilo sources, and the index actions. Keyboard-driven through the host keymap:

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move between actions |
| `enter` | Run the selected action |
| `e` | Edit settings (opens the dialog editor) |
| `r` | Reload status |
| `esc` | Close the page |

### Prompt-footer indicator

The terminal footer shows whether the current workspace is indexed, in one glyph:

| Indicator | Meaning |
| --- | --- |
| `● indexed` | Own index exists and is complete |
| `◐ index stale` | Own index exists but needs a refresh |
| `○ not indexed` | Nothing indexed yet, but Kilo's index is readable |
| `✕ no index` | Neither index is available for this workspace |
| `⏸ paused` | Indexing paused: nothing is written or refreshed |
| `!` / `◌` | The status could not be read / is still loading |

*Indexing: start, pause or resume indexing* in the command palette — or `/indexing-config set enabled=false` — controls it. The footer is a status line only: the host's `prompt.footer` slot exposes no interaction surface, so it is not clickable. Pausing leaves `indexing_search` working (it still reads Kilo's index), but `indexing_build`, `indexing_refresh`, `indexing_import` and auto-refresh refuse to write until you resume. The command has a stable id, so a key can be assigned in `cli.json`.

### Editing settings

Settings are edited in a dialog-based flow, reachable three ways:

- Press `e` from the `/indexing` page.
- The command **Indexing: settings (dialogs)** in the command palette (a manual escape hatch if the page ever fails to render).
- Automatically: if the host has no JSX runtime, `/indexing` opens this flow instead of the page.

`/indexing-config` covers the same ground as text subcommands and works in every client, including Desktop and web.

Configurable from all three:

- **Vector store** for the own index: Qdrant or LanceDB.
- **Qdrant URL + API key** (local or remote) with connection test.
- **LanceDB directory** with availability test.
- **Embedding provider/model** (mistral, openai, ollama, openai-compatible, gemini, voyage, openrouter) and **API key**.
- **Import from Kilo** toggle with live source detection ("Qdrant ws-… (31,261 pts) · LanceDB …").
- **Auto-refresh on search** toggle.
- Build / refresh / import actions and a status summary.

Settings are stored in `~/.config/opencode/indexing.json` (plugin options → `indexing.json` → environment → `~/.config/kilo/kilo.jsonc` → defaults). Plugin options in `opencode.json` still work and take precedence. API keys are never written to `indexing.json` in plain text; set them through the environment or plugin options.

## Install

### Global (recommended)

The installer is cross-platform; it only needs Node >= 22.6.

```bash
# Linux / macOS
sh install.sh

# Windows
powershell -ExecutionPolicy Bypass -File .\install.ps1

# Any platform (the wrappers just call this)
node install.mjs
```

It copies the plugin to the global config directory (`$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`, same path used on Windows), installs runtime deps (`ignore`, plus optional `@lancedb/lancedb@0.26.2` and the tree-sitter WASM packages), merges `permission` entries for the tools into `opencode.json`, and restarts the OpenCode service.

Options: `--skip-deps` (copy files only), `--no-restart`. PowerShell accepts `-SkipDeps` / `-NoRestart` too.

If no package manager is available the copy still happens and the plugin runs with reduced features (line chunker instead of tree-sitter, no LanceDB).

## Configuration (optional, `opencode.json`)

```jsonc
{
  "plugins": [
    { "package": "./plugins/opencode-indexing", "options": {
      "vectorStore": "qdrant",
      "qdrantUrl": "http://localhost:6333",
      "importFromKilo": true,
      "autoRefresh": false
    }}
  ]
}
```

| Variable | Meaning |
| --- | --- |
| `KILO_INDEX_VECTOR_STORE` | `qdrant` (default) or `lancedb` for the own index |
| `KILO_INDEX_QDRANT_URL` / `KILO_INDEX_QDRANT_API_KEY` | Qdrant connection |
| `KILO_INDEX_LANCEDB_DIR` | Base directory for the own LanceDB stores |
| `KILO_INDEX_KILO_LANCEDB_DIR` | Override Kilo's LanceDB directory (import source) |
| `KILO_INDEX_MISTRAL_KEY`, `KILO_INDEX_OPENAI_KEY`, `KILO_INDEX_OPENAI_COMPATIBLE_URL`, `KILO_INDEX_OPENAI_COMPATIBLE_KEY`, `KILO_INDEX_OLLAMA_URL`, ... | Embedding credentials |

Word about data safety: Kilo's indexes (`ws-*` collections and its LanceDB directory) are **never modified**. Imports are copies.

## Requirements

- OpenCode v2 (plugin API `@opencode/plugin@2.x`).
- For search/index: a Qdrant server (default `http://localhost:6333`) and/or the optional LanceDB module (`@lancedb/lancedb@0.26.2`).
- Embedding credentials compatible with the collection you search (the profile is read from the metadata point).

## Semantic search vs. code graphs (roadmap)

`opencode-indexing` implements **semantic (vector) search**. It is worth being
explicit about how it compares to **code-graph** tooling (call graphs, symbol
graphs, SCIP-style indexes), because they answer different questions and are
complementary:

| | Semantic index (this plugin) | Code graph |
| --- | --- | --- |
| Question it answers | "Where is the code that does something like X?" | "Who calls X? What breaks if I change it? Path from A to B?" |
| Signal | Meaning (embeddings over chunks) | Structure (symbols, `CALLS`, `DEFINES`, `IMPORTS` edges) |
| Strengths | Natural language, concepts without known identifiers, cross-language | Exact structural facts, multi-hop traversals, no similarity false positives |
| Weaknesses | "Similar" is not "relevant"; no notion of connections | Cannot find a concept with no known symbol; fragile on dynamic code |
| Cost profile | Embedding API + vector DB | Local parsing + small graph store |

The 2026 consensus is **hybrid**: use embeddings to find the entry node by
intent, then walk the graph for the exact relationships. Empirically, Cursor
reported ~12.5% retrieval-accuracy improvement when combining semantic search
with grep; Sourcegraph layers semantic search over a SCIP code graph; Aider uses
tree-sitter + PageRank with no embeddings at all for repo maps.

This plugin deliberately stays on the semantic side and coexists with grep/read
(see the tool descriptions and the bundled skill). A code-graph mode (tree-sitter
symbol/edge extraction into SQLite, exposed as `indexing_graph_*` tools that
chain after `indexing_search`) is a candidate for a future major version; the
tree-sitter infrastructure is already in place.

## Development

```powershell
npm install
node --test "test/*.test.ts"   # unit tests (Node 26 runs TS natively)

# CLI harness against the real environment:
node test/cli.ts status     --root D:\Proyectos
node test/cli.ts search "database connection pooling" --root D:\Proyectos
node test/cli.ts build      --root D:\Proyectos            # import from Kilo when possible
node test/cli.ts import     --root D:\Proyectos --source ws-43dfc9b3ee33fcfd
node test/cli.ts build      --vector-store lancedb --root D:\Proyectos\opencode-indexing
```

## Acknowledgements

This plugin interoperates with the open-source [Kilo Code](https://github.com/Kilo-Org/kilocode) indexing format (MIT License, Copyright (c) 2026 Kilo Code). The line-based chunker and the tree-sitter queries are ports of Kilo Code's implementation. It also builds on [opencode](https://github.com/anomalyco/opencode) (MIT), [LanceDB](https://github.com/lancedb/lancedb) (Apache-2.0), [web-tree-sitter](https://github.com/tree-sitter/tree-sitter) (MIT), [tree-sitter-wasms](https://github.com/Gregoor/tree-sitter-wasms) (Unlicense) and [ignore](https://github.com/kaelzhang/node-ignore) (MIT).

Kilo Code is a trademark of its owners; this project is **unofficial and not affiliated** with Kilo Code or the OpenCode project.

## License

MIT (see `LICENSE`). Portions derived from Kilo Code and other third parties are
documented in `THIRD_PARTY_NOTICES.md`. This project is unofficial and not
affiliated with Kilo Code or OpenCode.
