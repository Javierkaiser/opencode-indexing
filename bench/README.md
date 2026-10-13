# Benchmark

Does searching by **meaning** actually find code better than searching by
**words**? And does adding a **symbol graph** help?

This folder answers that with numbers instead of opinions. The results are in
[`results.md`](./results.md) — it opens with a plain-language summary, so start
there.

## The short version

- **Combining meaning-based search with symbol lookup was never worse than
  meaning alone, and better on both codebases measured.**
- **Meaning and plain word matching traded places.** On one codebase meaning won
  clearly; on the other they were almost tied. Neither replaces the other.
- **Searching by symbol name was the weakest everywhere.** It only matches what
  things are *called*, so a question in everyday words has little to grab onto.
- **Finding the file and finding it first are different things.** Meaning-based
  search almost always had the right file in its top 10, but usually not first.

That is four bullets from two codebases. It is a hint, not a law — see
[What this does not prove](./results.md) at the end of the report.

## How it works, in one paragraph

We take questions about code — the kind where you know what the code *does* but
not what it is *called* — where we already know which file holds the answer. We
ask each search method for its ranked list of files, then count how often the
right file appears near the top.

Two numbers matter:

| Number | Plain meaning |
| --- | --- |
| **Found in the top 10** | Was the right file anywhere in the first 10 answers? |
| **Rank quality** | How close to the top? `1.00` = always first, `0.50` ≈ usually second, `0.00` = never found. |

A method can *find* the file every time and still score a low rank quality — that
means it works but sorts badly. Both numbers are reported for that reason.

## The four methods

| Method | What it does |
| --- | --- |
| **Word matching** | Looks for the words you typed inside the files |
| **Symbol names** | Looks for functions and classes whose *names* match your words |
| **Meaning** | Looks for code that *does* what you described, even if no word matches |
| **Meaning + symbols** | Runs the last two and merges their answers |

Each is measured **on its own** (an "ablation"), so the numbers say what each
signal contributes rather than how much stacking helps.

## Run it

```bash
# One codebase, keyword baseline only — no setup needed:
npm run bench

# Add the meaning-based search (needs a built index and an embedding provider):
node test/cli.ts build --root .
node bench/run.mjs --strategy grep,plugin --k 10

# Several codebases at once, anonymised report:
node bench/multi.mjs --k 10 --commit-queries 40
```

The multi-codebase runner reads `projects.local.json` — which is **gitignored**,
because it maps the anonymous labels to real paths. Create it as:

```json
[
  { "label": "P1", "root": "/absolute/path/to/repo", "queries": "bench/queries.json" },
  { "label": "P2", "root": "/absolute/path/to/another/repo" }
]
```

`queries` is optional: without it, questions are derived from the project's own
git history instead.

## Where the questions come from

Two sources, reported **separately** because they are different distributions
and averaging them would hide what each one shows.

1. **Written by hand** (`queries.json`) — natural-language questions with the
   answering file chosen by a person. Best-effort labels; corrections welcome.
2. **Taken from git history** — a commit subject is a natural-language
   description of an intent, and the files it touched are an objective answer.
   Neither the index nor the symbol graph supplies either, so this avoids the
   circularity of labelling ground truth from the tool being measured. Only
   commits touching a single file, whose file type the index actually covers.

That last restriction matters: without it, a commit touching a PowerShell script
counts against the meaning-based method when the real answer is "that file type
was never indexed".

## What this will not do

- **It will not measure `explore` or `context`.** `codegraph query` is the only
  graph subcommand with machine-readable output. A graph's real strength — who
  calls what, what breaks if you change it — is not measured here.
- **It will not compare embedding models.** One model, one dimension, fixed.
- **It will not hide a thin sample.** Any set with fewer than 10 questions is
  marked as a hint rather than a result, and a method that could not run at all
  reports *could not run* rather than a score of zero.
- **It will not report a repository it can identify.** The report is anonymised
  by construction.
- **Cost is a separate axis.** This measures retrieval quality, not the
  embedding cost saved by importing Kilo's index or by incremental refresh.

## For the technically curious

The friendly tables and the raw metrics come from the same run: the report ends
with a collapsed **Full numbers** section using the usual names (`Hit@k`,
`Recall@k`, `MRR`, `nDCG@k`). The friendly layer is generated from the results,
never hand-written, so it cannot drift from the data.

`multi.mjs` also reports each cell's sample size and splits every result by
question type — whether the question names a symbol, or describes behaviour.
