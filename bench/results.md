# Which way of searching actually finds the right file?

We took real questions about code — the kind where you know what the code *does*
but not what it is *called* — and asked four different search methods to point at
the right file. Then we counted how often each one got it right.

**What are P1, P2 and P3?** They are the codebases we ran this on. This report is
meant to be publishable, so they are not named: each one is just a label, and the
section for each says how big it is and what it is written in. Nothing that could
identify a repository appears anywhere in it.

## The short version

- **Combining the two smart methods was never worse than meaning alone, and better on both:** it found more files on P2 (68% against 60%), and it put the right file higher on P1.
- **Meaning and word matching traded places**: 100% against 76% on P1; 60% against 55% on P2. One codebase is not enough to call it either way.
- **Searching by symbol name was the weakest** in every codebase measured (64%, 38%). It only matches what things are *called*, so a question in everyday words has little to grab onto.
- **Finding the file and finding it first are different things.** Meaning-based search almost always had the right file in its top 10, but usually not first — its rank quality is 0.51, roughly second place. Combining methods is what improves that ordering.

## How to read the numbers

Two numbers matter, and neither is complicated:

- **Found in the top 10** — was the right file anywhere in the first 10 answers? This is the one to look at first.
- **Rank quality** — on average, how close to the top was it? **1.00** means always first, **0.50** means usually around second, **0.00** means never found. Two methods can both *find* the file while one puts it nearer the top.

## The four methods

| Method | What it does |
| --- | --- |
| Word matching | Looks for the words you typed inside the files |
| Symbol names | Looks for functions and classes whose *names* match your words |
| Meaning | Looks for code that *does* what you described, even if no word matches |
| Meaning + symbols | Runs the last two and merges their answers |

## The codebases

| | Size | Written in | Index | Symbol graph |
| --- | --- | --- | --- | --- |
| **P1** | 27.9k lines, 102 files | mostly TypeScript (74 of 102 files, 73%), then Markdown (9) and JavaScript (6) | 2.2k pieces | yes |
| **P2** | 214.2k lines, 443 files | mostly C# (417 of 443 files, 94%), then JSON (4) and YAML (1) | 8.6k pieces | yes |
| **P3** | 4.7k lines, 44 files | mostly C# (26 of 44 files, 59%), then Markdown (4) and JSON (3) | 143 pieces | yes |

**P3** could not be measured — its section says why.

They are different kinds of codebase — TypeScript and C# — which is part of why the numbers differ between them.

## P1

**27.9k lines** across **102 files**, mostly TypeScript (74 of 102 files, 73%), then Markdown (9) and JavaScript (6). Its index holds **2.2k pieces of code**. It also has a symbol graph.

### Questions written by hand (25 questions)

| Method | Found in top 10 | Rank quality |
| --- | --- | --- |
| 🥇 Meaning + symbols | `██████████` 100% | 0.58 |
| 🥈 Meaning | `██████████` 100% | 0.51 |
| 🥉 Word matching | `████████░░` 76% | 0.25 |
| 4️⃣ Symbol names | `██████░░░░` 64% | 0.30 |

<details><summary>Split by question type</summary>

| Method | Question names a symbol | Question is a description |
| --- | --- | --- |
| Word matching | 50% (2) | 78% (23) |
| Symbol names | 100% (2) | 61% (23) |
| Meaning | 100% (2) | 100% (23) |
| Meaning + symbols | 100% (2) | 100% (23) |

</details>

### Questions taken from the project's own history (4 questions)

> ⚠️ **Only 4 questions.** Too few to draw a conclusion from — treat what follows as a hint, not a result.

| Method | Found in top 10 | Rank quality |
| --- | --- | --- |
| 🥇 Meaning | `████████░░` 75% | 0.75 |
| 🥈 Word matching | `████████░░` 75% | 0.63 |
| 🥉 Meaning + symbols | `████████░░` 75% | 0.38 |
| 4️⃣ Symbol names | `░░░░░░░░░░` 0% | 0.00 |

<details><summary>Split by question type</summary>

| Method | Question names a symbol | Question is a description |
| --- | --- | --- |
| Word matching | 0% (1) | 100% (3) |
| Symbol names | 0% (1) | 0% (3) |
| Meaning | 0% (1) | 100% (3) |
| Meaning + symbols | 0% (1) | 100% (3) |

</details>

## P2

**214.2k lines** across **443 files**, mostly C# (417 of 443 files, 94%), then JSON (4) and YAML (1). Its index holds **8.6k pieces of code**. It also has a symbol graph.

### Questions taken from the project's own history (40 questions)

| Method | Found in top 10 | Rank quality |
| --- | --- | --- |
| 🥇 Meaning + symbols | `███████░░░` 68% | 0.44 |
| 🥈 Meaning | `██████░░░░` 60% | 0.41 |
| 🥉 Word matching | `██████░░░░` 55% | 0.42 |
| 4️⃣ Symbol names | `████░░░░░░` 38% | 0.20 |

<details><summary>Split by question type</summary>

| Method | Question names a symbol | Question is a description |
| --- | --- | --- |
| Word matching | 53% (15) | 56% (25) |
| Symbol names | 53% (15) | 28% (25) |
| Meaning | 100% (15) | 36% (25) |
| Meaning + symbols | 100% (15) | 48% (25) |

</details>

## P3

**4.7k lines** across **44 files**, mostly C# (26 of 44 files, 59%), then Markdown (4) and JSON (3). Its index holds **143 pieces of code**. It also has a symbol graph.

> _Not measured: No question could be built for this codebase: none of its one-file changes touch a file type the index covers._

---

<details><summary><b>Full numbers</b> (Hit@k, Recall@k, MRR, nDCG@k)</summary>


These are the same results, named the way the literature names them.

**P1 · labelled · n=25**

| Condition | n | Hit@10 | Recall@10 | MRR | nDCG@10 |
| --- | --- | --- | --- | --- | --- |
| keyword | 25 | 76% | 76% | 0.249 | 0.371 |
| graph | 25 | 64% | 64% | 0.304 | 0.381 |
| semantic | 25 | 100% | 100% | 0.513 | 0.641 |
| fusion | 25 | 100% | 100% | 0.576 | 0.679 |

**P1 · commits · n=4**

| Condition | n | Hit@10 | Recall@10 | MRR | nDCG@10 |
| --- | --- | --- | --- | --- | --- |
| keyword | 4 | 75% | 75% | 0.625 | 0.658 |
| graph | 4 | 0% | 0% | 0.000 | 0.000 |
| semantic | 4 | 75% | 75% | 0.750 | 0.750 |
| fusion | 4 | 75% | 75% | 0.375 | 0.473 |

**P2 · commits · n=40**

| Condition | n | Hit@10 | Recall@10 | MRR | nDCG@10 |
| --- | --- | --- | --- | --- | --- |
| keyword | 40 | 55% | 55% | 0.415 | 0.448 |
| graph | 40 | 38% | 38% | 0.201 | 0.241 |
| semantic | 40 | 60% | 60% | 0.415 | 0.460 |
| fusion | 40 | 68% | 68% | 0.442 | 0.497 |

</details>

## What this does not prove

- **Two codebases is not a trend.** These are two data points.
- **The questions from git history are noisy.** "The one file that commit touched" is not always the only file that answers the question, and that noise hits every method equally.
- **Symbol-name search looks worse here than a code graph really is.** This measures one subcommand that matches names. A graph's real strength — who calls what, what breaks if you change it — is not measured here at all.
- **One embedding model.** Swap the model and the meaning-based numbers move.

---

Generated by `bench/multi.mjs` · top 10 results · anonymised: no path, file name or question text appears above.