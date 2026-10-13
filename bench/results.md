k=10 · embedding profile recorded in bench/README.md · the model matters for these numbers.

# Benchmark results — multi-repository

Anonymised by design: no path, file name or query text appears below.

## P1

| files | lines | own index | symbol graph |
| --- | --- | --- | --- |
| 103 | 27.6k | 2233 pts | indexed |

### P1 · query set: labelled (n=25)

| Condition | n | Hit@10 | Recall@10 | MRR | nDCG@10 |
| --- | --- | --- | --- | --- | --- |
| keyword | 25 | 76.0% | 76.0% | 0.249 | 0.371 |
| graph | 25 | 64.0% | 64.0% | 0.304 | 0.381 |
| semantic | 25 | 100.0% | 100.0% | 0.513 | 0.641 |
| fusion | 25 | 100.0% | 100.0% | 0.576 | 0.679 |

### P1 · query set: commits (n=4)

| Condition | n | Hit@10 | Recall@10 | MRR | nDCG@10 |
| --- | --- | --- | --- | --- | --- |
| keyword | 4 | 75.0% | 75.0% | 0.625 | 0.658 |
| graph | 4 | 0.0% | 0.0% | 0.000 | 0.000 |
| semantic | 4 | 75.0% | 75.0% | 0.750 | 0.750 |
| fusion | 4 | 75.0% | 75.0% | 0.375 | 0.473 |

_n=4 is too small to conclude from: treat these numbers as indicative only._

## P2

| files | lines | own index | symbol graph |
| --- | --- | --- | --- |
| 443 | 214.2k | 8573 pts | indexed |

### P2 · query set: commits (n=40)

| Condition | n | Hit@10 | Recall@10 | MRR | nDCG@10 |
| --- | --- | --- | --- | --- | --- |
| keyword | 40 | 55.0% | 55.0% | 0.415 | 0.448 |
| graph | 40 | 37.5% | 37.5% | 0.201 | 0.241 |
| semantic | 40 | 60.0% | 60.0% | 0.415 | 0.460 |
| fusion | 40 | 67.5% | 67.5% | 0.442 | 0.497 |

## P3

| files | lines | own index | symbol graph |
| --- | --- | --- | --- |
| 44 | 4.7k | 143 pts | indexed |

_Not measured: no single-file commit in the scanned history touches a file type the index covers, so no query could be generated._

## By query type

| Project | Query set | Condition | Type | n | Hit@10 | MRR |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | labelled | keyword | concept | 23 | 78.3% | 0.257 |
| P1 | labelled | keyword | identifier | 2 | 50.0% | 0.167 |
| P1 | labelled | graph | concept | 23 | 60.9% | 0.276 |
| P1 | labelled | graph | identifier | 2 | 100.0% | 0.625 |
| P1 | labelled | semantic | concept | 23 | 100.0% | 0.493 |
| P1 | labelled | semantic | identifier | 2 | 100.0% | 0.750 |
| P1 | labelled | fusion | concept | 23 | 100.0% | 0.540 |
| P1 | labelled | fusion | identifier | 2 | 100.0% | 1.000 |
| P1 | commits | keyword | concept | 3 | 100.0% | 0.833 |
| P1 | commits | keyword | identifier | 1 | 0.0% | 0.000 |
| P1 | commits | graph | concept | 3 | 0.0% | 0.000 |
| P1 | commits | graph | identifier | 1 | 0.0% | 0.000 |
| P1 | commits | semantic | concept | 3 | 100.0% | 1.000 |
| P1 | commits | semantic | identifier | 1 | 0.0% | 0.000 |
| P1 | commits | fusion | concept | 3 | 100.0% | 0.500 |
| P1 | commits | fusion | identifier | 1 | 0.0% | 0.000 |
| P2 | commits | keyword | concept | 25 | 56.0% | 0.364 |
| P2 | commits | keyword | identifier | 15 | 53.3% | 0.500 |
| P2 | commits | graph | concept | 25 | 28.0% | 0.118 |
| P2 | commits | graph | identifier | 15 | 53.3% | 0.338 |
| P2 | commits | semantic | concept | 25 | 36.0% | 0.215 |
| P2 | commits | semantic | identifier | 15 | 100.0% | 0.748 |
| P2 | commits | fusion | concept | 25 | 48.0% | 0.224 |
| P2 | commits | fusion | identifier | 15 | 100.0% | 0.806 |
