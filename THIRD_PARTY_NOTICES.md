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
| [`web-tree-sitter`](https://github.com/tree-sitter/tree-sitter) | MIT | Tree-sitter contributors |
| [`tree-sitter-wasms`](https://github.com/Gregoor/tree-sitter-wasms) | Unlicense | Gregor (packaging); grammars by their respective authors |
| [`ignore`](https://github.com/kaelzhang/node-ignore) | MIT | Kael Zhang and contributors |

Tree-sitter grammar `.wasm` files bundled by `tree-sitter-wasms` are distributed
under their upstream licenses (mostly MIT or Apache-2.0); see the
`tree-sitter-wasms` package for details.
