# Benchmark

Retrieval benchmark for `opencode-indexing`. It answers one question: **when a
query is a description of behaviour instead of an identifier, does semantic
search find the right file where keyword search does not?**

## What it measures

Each query in `queries.json` is a natural-language question plus the file(s) that
answer it (`expected`). A strategy returns a ranked list of files; the harness
scores it with:

| Metric | Meaning |
| --- | --- |
| **Hit@k** | any expected file within the top k |
| **Recall@k** | fraction of expected files within the top k |
| **MRR** | reciprocal rank of the first expected file |
| **nDCG@k** | rank-weighted quality (binary relevance) |

Queries are tagged `concept` (no identifier from the code appears — the case
semantic search should win) or `identifier` (a symbol name is present — where
grep is expected to win). Reporting both is the point: the two are complementary.

## Strategies

- **`grep`** — keyword baseline. Tokenizes the query, drops stop words, and ranks
  files by how many distinct terms they contain, then by raw hit count. Runs
  offline with no setup.
- **`plugin`** — the plugin's own semantic search, invoked through `test/cli.ts`.
  Requires a configured embedding provider and a built index (see the README's
  Install/Configuration sections).

## Run

```bash
# Baseline only (no provider needed):
npm run bench

# Baseline + the plugin's semantic search:
node test/cli.ts build --root .            # once, to build the index
node bench/run.mjs --strategy grep,plugin --k 10

# Point at another repository or another query set:
node bench/run.mjs --repo /path/to/repo --queries bench/queries.json
```

The command prints a summary and writes `bench/results.md` with the per-query
detail (rank of the first hit for each query).

## Honesty notes

- **The query set is hand-labeled.** Labels are best-effort; a retrieval counts
  as correct only if it lands on a file that genuinely answers the question.
  Corrections and new queries are welcome via PR.
- **The model matters.** Semantic results depend on the embedding provider and
  model; always record which one was used next to the numbers.
- **The baseline is included on purpose.** If grep wins on a query, that is
  reported, not hidden — the honest claim is that the two are complementary, not
  that one replaces the other.
- **Cost is a separate axis.** This harness measures retrieval quality; it does
  not measure the embedding cost saved by importing Kilo's index or by
  incremental refresh.

## Multi-repository comparison

`multi.mjs` runs the same queries across several codebases and writes an
**anonymised** report: projects appear as `P1..Pn` with their size, and no path,
file name or query text appears anywhere in the output.

```bash
node bench/multi.mjs --k 10 --commit-queries 40
```

The label-to-path mapping lives in `projects.local.json`, which is gitignored —
a report that could identify the repository it describes is not safe to publish.

### Conditions

An ablation: each condition is a single ranker standing alone.

| Condition | What it is |
| --- | --- |
| `keyword` | Term coverage over the working tree. Baseline every deployment already has. |
| `graph` | `codegraph query` — **symbol-name matching, not meaning.** |
| `semantic` | The plugin's own index. |
| `fusion` | Reciprocal rank fusion of `semantic` + `graph`. |

Rankings are memoised per query: beyond halving the embedding calls, it means
`fusion` fuses the same runs the other two were scored on.

### Ground truth

Two sets, reported **separately** — they are different distributions and
averaging them would hide what each shows.

1. **`queries.json`** — hand-labelled, for this repository only.
2. **Commit-derived** — a commit subject is a natural-language description of an
   intent and the files it touched are an objective answer. Neither the semantic
   index nor the symbol graph supplies either, so this avoids the circularity of
   labelling from the tool being measured. Restricted to commits touching a
   single file, whose file type the index actually covers.

That last restriction matters: without it a commit touching a PowerShell script
counts against the semantic condition when the real answer is "that file type was
never indexed".

### What this harness will not do

- **It will not measure `explore` or `context`.** `codegraph query` is the only
  graph subcommand with a machine-readable output.
- **It will not compare embeddings.** One model, one dimension, fixed across runs.
- **It will not hide a thin sample.** Any cell with `n < 10` carries a caveat
  saying the numbers are indicative only.
