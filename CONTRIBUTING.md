# Contributing to opencode-indexing

Thanks for taking the time to contribute. This project is a plugin for
[OpenCode](https://github.com/anomalyco/opencode) that adds semantic code
search. Bug reports, fixes, documentation and new providers are all welcome.

By participating you agree to follow our
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** — open an issue with the *Bug report* form.
- **Request a feature** — open an issue with the *Feature request* form.
- **Send a pull request** — see [Development](#development) and
  [Pull requests](#pull-requests).

Please search the existing issues before opening a new one.

## Development

### Requirements

- Node.js **>= 22.6** (Node 22 LTS or newer; the tests run TypeScript directly).
- A package manager (`npm` is what CI uses).
- Optional, for the full feature set: a Qdrant server and/or the optional
  native modules (`@lancedb/lancedb`, `web-tree-sitter`).

### Setup

```bash
git clone https://github.com/Javierkaiser/opencode-indexing.git
cd opencode-indexing
npm install
```

### Checks

Run these before opening a pull request; CI runs the same commands:

```bash
npm run typecheck   # tsc --noEmit
npm run test:unit   # node --test "test/*.test.ts"
npm test            # both, in order
```

Suites that need an optional dependency skip themselves when it is not
installed, so a green run with a few skips is expected on a bare checkout.

### CLI harness

`test/cli.ts` drives the plugin against a real workspace, which is the fastest
way to reproduce indexing or search issues:

```bash
node test/cli.ts status  --root .
node test/cli.ts search  "database connection pooling" --root .
node test/cli.ts build   --root .            # import from Kilo when possible
```

### Project layout

| Path | What lives there |
| --- | --- |
| `index.ts` | Server plugin entry point (tools, RPC, commands) |
| `tui.ts`, `tui/` | Terminal UI: settings page, footer, workspaces |
| `src/` | Indexer, chunker, embedders, vector stores, Kilo import |
| `src/treesitter/` | Tree-sitter parsing and language queries |
| `test/` | Unit tests and the CLI harness |

## Pull requests

1. Fork the repository and branch from `main`. Use a lowercase prefix:
   `feature/`, `bug/`, `hotfix/` or `docs/` (for example `bug/footer-crash`).
2. Keep the change focused; one concern per pull request.
3. Add or update tests. New behaviour without coverage will be asked for
   changes.
4. Use [Conventional Commits](https://www.conventionalcommits.org/) for the
   commit messages (`fix: …`, `feat: …`, `docs: …`).
5. Open the pull request against `main` and fill in the template.
6. CI must be green and at least one review is required before merging.

`main` is protected: pull requests are the normal path in. Maintainers may push
small fixes directly.

## Coding style

- TypeScript, ES modules, `strict` mode. `npm run typecheck` must pass.
- Prefer small, pure functions and keep the existing file structure.
- Match the surrounding code; do not reformat files you are not changing.
- No secrets, tokens or machine-specific paths in commits.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](./LICENSE) that covers the project.
