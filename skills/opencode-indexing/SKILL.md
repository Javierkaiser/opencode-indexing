The `indexing_search` tool finds code by meaning in the workspace's semantic
index. It returns chunks embedded with the configured model, merging Kilo Code's
index (when present and compatible) with this plugin's own index (Qdrant or
LanceDB). When the same chunk exists in both, the own index wins.

## When to use it

- You know the intent but not the identifiers: "user login and password
  hashing", "database connection pooling", "retry logic for failed webhooks".
- You want conceptually similar implementations across the workspace.
- You need to locate code whose name you do not know.

## When not to use it

- Exact symbol, string or error message: use Grep.
- File names or extensions: use Glob.
- A file you already know: use Read.
- Correctness that depends on the latest edit: the index can lag. Run
  `indexing_status` and `indexing_refresh`, or use Grep for certainty.

## How to call it

`indexing_search { query, path? }`

- `query` is natural language, not a symbol name. Describe what the code does.
- `path` is optional and limits results to a subdirectory, relative to the
  workspace root.
- The result limit comes from the `searchMaxResults` setting; there is no
  per-call limit.
- Each result is `file:startLine-endLine`, a similarity score and the chunk.
  Scores rank the hits of one query; they are not probabilities.
- Only files matching the configured extension allowlist are indexed. The
  default list covers common code and documentation formats; it does not
  include PowerShell `.ps1`.

## Empty or partial results

- Empty results are not proof that the code does not exist. Only indexed files
  are searchable, and a stale index can miss recent edits.
- `indexing_status` reports points, completion, freshness and the recommended
  next action. `indexing_refresh` updates incrementally; `indexing_build`
  rebuilds.
- Pausing indexing stops writes and refreshes, not reads: `indexing_search`
  still works while paused.
- With `searchKilo: false`, only the own index is searched. The tool says so
  when it finds nothing, instead of claiming Kilo has no index.

## When codegraph is also installed

The codegraph MCP server answers structure; this tool answers meaning. Use them
together:

- `indexing_search` finds the entry node by intent.
- `codegraph_explore` returns the verbatim source around it, the call paths and
  what depends on it.
- `codegraph_callers` / `codegraph_impact` answer "who calls this" and "what
  breaks if I change it", which a similarity search cannot.

If codegraph is not available, the guidance above still applies and Grep remains
the fallback for exact terms.

## Configuration

`indexing_config` reports the effective settings (backend, provider/model,
credentials masked, search and behaviour). `indexing_config_set { key, value }`
changes one and persists it. Credentials are refused by design: a tool call is
recorded in the conversation. Set a key from the terminal `/indexing` page, the
Desktop settings page, the environment or the plugin options.

## Setup

Only build or import when the user asks. `indexing_build` creates the index; if
a compatible Kilo index exists and "import from Kilo" is on, vectors are copied
without embedding costs and only the delta is embedded. `indexing_import` does
the copy alone. The `/indexing` command opens the terminal settings page; on
Desktop, use Settings → Indexing.
