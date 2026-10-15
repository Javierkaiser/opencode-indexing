import * as assert from "node:assert/strict"
import { describe, test } from "node:test"

import { WORKSPACE_SCOPED_METHODS, bindWorkspace } from "../tui/workspace-rpc.ts"

/**
 * The proxy exists because the bug it prevents was invisible for so long.
 *
 * A TUI opened in one directory while the service ran in another asks the server
 * about the server's directory unless it says otherwise, and the server has no
 * way to tell that is not what was meant: it answers honestly about the wrong
 * workspace. The footer passed a directory and the palette did not, which is
 * precisely why one looked right and the other reported an empty index.
 */
describe("bindWorkspace", () => {
  /** Records every call's input and returns it, so the proxy's output is visible. */
  function client(): { calls: Array<{ method: string; input: unknown }>; rpc: Record<string, (input: unknown) => unknown> } {
    const calls: Array<{ method: string; input: unknown }> = []
    const rpc: Record<string, (input: unknown) => unknown> = {}
    for (const method of [
      ...WORKSPACE_SCOPED_METHODS,
      "settings.get",
      "settings.set",
      "workspaces.list",
      "workspace.forget",
    ]) {
      rpc[method] = (input: unknown) => {
        calls.push({ method, input })
        return { ok: true }
      }
    }
    return { calls, rpc }
  }

  test("injects the directory into every workspace-scoped method", async () => {
    const { calls, rpc } = client()
    const bound = bindWorkspace(rpc as never, () => "/home/dev/kine")

    for (const method of WORKSPACE_SCOPED_METHODS) {
      await (bound as Record<string, (input: unknown) => unknown>)[method]({})
    }

    assert.deepEqual(
      calls.map((call) => [call.method, (call.input as { directory?: string }).directory]),
      WORKSPACE_SCOPED_METHODS.map((method) => [method, "/home/dev/kine"]),
    )
  })

  test("keeps the caller's own arguments", () => {
    const { calls, rpc } = client()
    const bound = bindWorkspace(rpc as never, () => "/home/dev/kine") as Record<string, (input: unknown) => unknown>

    bound["index.import"]({ source: "ws-71b4" })
    bound["status.get"]({ checkFreshness: true })

    assert.deepEqual(calls[0].input, { source: "ws-71b4", directory: "/home/dev/kine" })
    assert.deepEqual(calls[1].input, { checkFreshness: true, directory: "/home/dev/kine" })
  })

  test("does not touch the workspace-agnostic methods", () => {
    const { calls, rpc } = client()
    const bound = bindWorkspace(rpc as never, () => "/home/dev/kine") as Record<string, (input: unknown) => unknown>

    bound["settings.get"]({})
    bound["settings.set"]({ patch: { enabled: true } })
    bound["workspaces.list"]({})
    bound["workspace.forget"]({ store: "oc-abc" })

    // Naming one workspace for these would misreport what they act on.
    assert.deepEqual(
      calls.map((call) => call.input),
      [{}, { patch: { enabled: true } }, {}, { store: "oc-abc" }],
    )
  })

  test("an explicit directory wins over the active one", () => {
    // The footer reads reactively and a caller may legitimately want to ask
    // about a workspace other than the one the user is sitting in.
    const { calls, rpc } = client()
    const bound = bindWorkspace(rpc as never, () => "/home/dev/kine") as Record<string, (input: unknown) => unknown>

    bound["status.get"]({ directory: "/home/dev/other" })

    assert.deepEqual(calls[0].input, { directory: "/home/dev/other" })
  })

  test("a blank explicit directory is treated as none", () => {
    const { calls, rpc } = client()
    const bound = bindWorkspace(rpc as never, () => "/home/dev/kine") as Record<string, (input: unknown) => unknown>

    bound["status.get"]({ directory: "   " })

    assert.deepEqual(calls[0].input, { directory: "/home/dev/kine" })
  })

  test("passes the call through untouched when no workspace resolves", () => {
    // A host with neither tabs nor sessions has nothing to name. The server
    // falls back to its own directory, which is the only thing it can do; the
    // important part is that this degrades instead of sending `directory: ""`.
    const { calls, rpc } = client()
    const bound = bindWorkspace(rpc as never, () => undefined) as Record<string, (input: unknown) => unknown>

    bound["status.get"]({ checkFreshness: true })

    assert.deepEqual(calls[0].input, { checkFreshness: true })
  })

  test("tolerates a call with no argument at all", () => {
    // `kilo.discover()` is a legal call shape; the proxy must not spread
    // `undefined` into an object.
    const { calls, rpc } = client()
    const bound = bindWorkspace(rpc as never, () => "/home/dev/kine") as Record<
      string,
      (input?: unknown) => unknown
    >

    bound["kilo.discover"]()

    assert.deepEqual(calls[0].input, { directory: "/home/dev/kine" })
  })

  test("resolves the workspace per call, not once at bind time", () => {
    // The footer re-reads it reactively as the active tab changes; binding the
    // value up front would freeze the first directory the user ever opened.
    const { calls, rpc } = client()
    let directory = "/home/dev/one"
    const bound = bindWorkspace(rpc as never, () => directory) as Record<string, (input: unknown) => unknown>

    bound["status.get"]({})
    directory = "/home/dev/two"
    bound["status.get"]({})

    assert.deepEqual(
      calls.map((call) => (call.input as { directory: string }).directory),
      ["/home/dev/one", "/home/dev/two"],
    )
  })

  test("forwards the options argument the host's client accepts", () => {
    // The real methods are `(input, options)` and `options` carries the
    // cancellation signal. A wrapper that models only `input` silently drops it.
    const seen: unknown[] = []
    const raw = {
      "status.get": (input: unknown, options?: unknown) => {
        seen.push([input, options])
        return { ok: true }
      },
    }
    const bound = bindWorkspace(raw as never, () => "/home/dev/kine") as Record<
      string,
      (input?: unknown, options?: unknown) => unknown
    >
    const signal = new AbortController().signal

    bound["status.get"]({ checkFreshness: true }, { signal })

    assert.deepEqual(seen, [[{ checkFreshness: true, directory: "/home/dev/kine" }, { signal }]])
  })

  test("does not resolve the workspace when the caller named one", () => {
    // An explicit directory must not depend on the accessors answering: the
    // footer passes one for a workspace it captured earlier, and the active tab
    // may have moved on — or the host may not expose tabs at all.
    let lookups = 0
    const { rpc } = client()
    const bound = bindWorkspace(rpc as never, () => {
      lookups++
      return "/home/dev/kine"
    }) as Record<string, (input: unknown) => unknown>

    bound["status.get"]({ directory: "/home/dev/other" })

    assert.equal(lookups, 0, "an explicit directory must short-circuit the lookup")
  })
})