# M7 — Publication plan

Working plan to publish this plugin as FOSS on npm. Meant to be followed top to
bottom: each phase says who does it and with which command.

`docs/` is deliberately outside the `files` list in `package.json`, so this plan
ships in the repository but not in the published package.

## Verified state (2026-10-09)

| Item | Result |
| --- | --- |
| Tests on Windows | 302 (300 pass / 2 skipped / 0 fail), `tsc` clean |
| Tests on Linux | 0 fail, run inside a `node:22-alpine` container |
| Installer | actually executed on Windows and Linux |
| `npm pack` | 49 files, 113.8 kB, no secrets, no stray files |
| npm name | `opencode-indexing` **free** (`npm view` → 404) |
| git remote | **none** |
| repository metadata | `repository` / `author` / `homepage` / `bugs` are `null` |
| local version | `1.0.0` |

Relevant commits: `e8bd1b2` (platform neutrality), `b7e910a` (manifest),
`f62e2ed` (installers), `4fe3b49` (selected row), `0a4b419` (completion).

## Open decisions

- **D1 — Where the repository lives.** GitHub / GitLab / other, and under which
  account. Without this there is no destination for the Kilo attribution and no
  link on the npm page.
- **D2 — Release version.** `0.1.0` is recommended: `1.0` promises stability and
  compatibility that are not backed yet (see "Not verified" below).
- **D3 — npm scope.** Unscoped `opencode-indexing` (free, simpler) or
  `@user/opencode-indexing`. Unscoped does not need `--access public`.

---

## Phase 1 — Public repository (you)

```bash
git remote add origin <repo-url>
git push -u origin main
```

Then, in the repo: short description, topics (`opencode`, `opencode-plugin`,
`semantic-search`, `qdrant`, `lancedb`), public visibility.

> The MIT licence and `THIRD_PARTY_NOTICES.md` are already in the first commit,
> with the Kilo Code attribution. The repository is where that attribution has to
> live.

**Deliverable:** repository URL, and `git remote -v` showing `origin`.

## Phase 2 — Metadata and version (me)

In `package.json`:

- `version`: `0.1.0` (per D2).
- `repository`: `{ "type": "git", "url": "<repo-url>.git" }`.
- `homepage`: `<repo-url>#readme` · `bugs`: `<repo-url>/issues`.
- `author`: whichever name/email you want published.
- `peerDependencies`: add `@opencode/plugin` as an **optional** peer (today it is
  only a devDependency, so the host contract is undeclared).
- `publishConfig.access`: `"public"` only if the package is scoped (D3).

In `README.md`: an install-from-npm section (`npm install opencode-indexing`)
alongside the install-from-repo one.

**Deliverable:** `npm pack --dry-run` showing complete metadata and version `0.1.0`.

## Phase 3 — CI (me)

`.github/workflows/ci.yml` with an **ubuntu + macos + windows** matrix, Node 22:

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
```

Two things it solves:

- **macOS.** There is no Mac available here; the GitHub Actions runner is. It is
  the only way to cover that platform without hardware.
- **LanceDB in CI.** The native-module suites skip when the optional dependency is
  missing. CI should install it (`npm ci` does, from the lockfile) so they really
  run instead of quietly skipping.

**Deliverable:** the workflow green on all three platforms before publishing.

## Phase 4 — Pre-publish verification (together)

1. **A successful import from Kilo**, the feature this plugin leads with and the
   only large one never exercised (so far only the "no Kilo source" path ran).
   Needs a small project that has a Kilo index, not the real workspace.
2. **Tarball in isolation**: `npm pack`, install the `.tgz` into a temporary
   directory and run the plugin from there, with no repository alongside.
3. **Installer on all three platforms**: Windows and Linux are done; macOS is
   covered by CI.

**Deliverable:** all three green, recorded here.

## Phase 5 — Publication (you)

```bash
npm login
npm pack --dry-run          # final look at the 49 files
npm publish                 # add --access public only when scoped (D3)
```

Then:

```bash
npm view opencode-indexing  # confirm metadata and that the repo is linked
git tag v0.1.0 && git push --tags
```

Plus a release in the repository with the notes (I can draft them).

**Deliverable:** published package + tag + release.

## Phase 6 — After publishing

- Install from npm in a clean environment and run `/indexing` in the TUI.
- Confirm on npmjs.com that the README, the licence and the repo link look right.
- **If something goes wrong:** `npm unpublish` only works within 72 hours and
  leaves the name quarantined. Publishing a patch (`0.1.1`) is preferable.

---

## Not verified even if we publish

- **A successful import from Kilo** — until phase 4.
- **Host versions outside 2.0.x** — the peers declare a wide range and only one
  version was tested. CI does not cover this: it is the host, not the plugin.
- **Native macOS** — CI runs it, but nobody will have used it by hand.
- **`/indexing-config` from the TUI** — a host limitation, already documented. It
  is the first thing a new user will try, so the README should say so near the top.

## Suggested order

```
D1 (repo) ──► Phase 2 (metadata) ──► Phase 3 (CI) ──► Phase 4 (verify) ──► Phase 5 (publish)
```

Phases 2 and 3 can run in parallel as soon as the repository URL exists. Phase 4
needs your input: which project with a Kilo index to use.
