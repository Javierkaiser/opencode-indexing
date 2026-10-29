# Third-party notices

`opencode-indexing` is MIT-licensed (see [LICENSE](./LICENSE)). It interoperates
with — and contains code derived from — the projects listed below. The full
license text of each project is included with its notice.

## Kilo Code (github.com/Kilo-Org/kilocode)

Portions of this project are derived from Kilo Code, including:

- the line-based chunking algorithm (`src/chunker.ts` and the fallback path in
  `src/treesitter/parser.ts`), ported from
  `packages/kilo-indexing/src/indexing/processors/parser.ts`;
- the tree-sitter S-expression queries (`src/treesitter/queries.ts`), ported
  from `packages/kilo-indexing/src/tree-sitter/queries/*`;
- the markdown section parser (`src/treesitter/markdown.ts`), ported from
  `packages/kilo-indexing/src/tree-sitter/markdownParser.ts`;
- the LanceDB two-table layout and metadata conventions, mirrored from
  `packages/kilo-indexing/src/indexing/vector-store/lancedb-vector-store.ts`;
- the Qdrant collection naming, payload schema, payload-index and search
  conventions, mirrored from
  `packages/kilo-indexing/src/indexing/vector-store/qdrant-client.ts`.

License: MIT

```
MIT License

Copyright (c) 2026 Kilo Code
Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

"Kilo Code" is used here in a nominative sense only. This project is
**unofficial and not affiliated with or endorsed by Kilo Code**.

## Runtime dependencies

| Package | License | Copyright |
| --- | --- | --- |
| [`@lancedb/lancedb`](https://github.com/lancedb/lancedb) | Apache-2.0 | LanceDB, Inc. |
| [`apache-arrow`](https://github.com/apache/arrow) | Apache-2.0 | The Apache Software Foundation |
| [`web-tree-sitter`](https://github.com/tree-sitter/tree-sitter) | MIT | Tree-sitter contributors |
| [`tree-sitter-wasms`](https://github.com/Gregoor/tree-sitter-wasms) | Unlicense | Gregor (packaging); grammars by their respective authors |
| [`ignore`](https://github.com/kaelzhang/node-ignore) | MIT | Kael Zhang and contributors |
| [`mini-semantic-search`](https://github.com/ShakirasHips/model2vec-js) | MIT | ShakirasHips contributors |
| [`@huggingface/tokenizers`](https://github.com/huggingface/tokenizers) | Apache-2.0 | Hugging Face |
| [`potion-base-8M`](https://huggingface.co/minishlab/potion-base-8M) (bundled model) | MIT | Minish Lab |
| [`potion-multilingual-128M`](https://huggingface.co/minishlab/potion-multilingual-128M) (downloaded model) | MIT | Minish Lab |

Tree-sitter grammar `.wasm` files bundled by `tree-sitter-wasms` are distributed
under their upstream licenses (mostly MIT or Apache-2.0); see the
`tree-sitter-wasms` package for details.

## Provided by the host

| Package | License | Copyright |
| --- | --- | --- |
| [`solid-js`](https://github.com/solidjs/solid) | MIT | Ryan Carniato and contributors |
| [`@opentui/core`](https://github.com/sst/opentui) | MIT | SST and OpenTUI contributors |
| [`@opentui/solid`](https://github.com/sst/opentui) | MIT | SST and OpenTUI contributors |

These are what the terminal UI is rendered with. They are **not distributed**
with this package: the host provides them at runtime and the TUI imports the
host's own instances by virtual module id (`opentui:runtime-module:…`) instead
of installing copies. Without them the prompt-footer indicator and the settings
page are absent, and everything else works.

## CodeGraph (github.com/colbymchenry/codegraph)

Not bundled and not required. CodeGraph is a separate program that this plugin
can install, register as an MCP server and keep in step; it is listed here
because the plugin drives it and points at it by name.

License: **MIT**, as declared in the package manifest
(`@colbymchenry/codegraph@1.6.2`).

The published package carries no `LICENSE` file of its own and declares no
author, so the authoritative license text is the one in the upstream repository:
<https://github.com/colbymchenry/codegraph>. It is not reproduced here rather
than reproduced with a copyright holder this project cannot verify.

The npm package is `@colbymchenry/codegraph`. The unscoped `codegraph` on npm is
an unrelated project and is not what this plugin installs.
