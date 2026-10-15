/**
 * Binds the caller's workspace directory to every workspace-scoped RPC.
 *
 * The server plugin is instantiated for the directory the service runs in, not
 * the one the user has open, so a call that omits `directory` silently acts on
 * the wrong workspace. Every method below takes one for that reason — and every
 * one that takes one has to be passed it, which is a per-call-site obligation
 * that was already forgotten once (the palette and the settings page read and
 * wrote the service's index while the footer, using the same client, correctly
 * reported the user's).
 *
 * Injecting the directory here rather than at each call site makes that class
 * of bug impossible to reintroduce: there is one place that knows which methods
 * are workspace-scoped, and adding a method to that list is the only edit a new
 * workspace-scoped RPC needs.
 */

/** RPC methods that act on one workspace and therefore need a directory. */
export const WORKSPACE_SCOPED_METHODS = [
  "settings.test",
  "kilo.discover",
  "status.get",
  "index.build",
  "index.refresh",
  "index.import",
] as const

/**
 * The workspace-agnostic methods are deliberately absent: they span every
 * workspace, so naming one would misreport what they act on. In this client
 * that is `settings.get` and `settings.set`; the wider client adds
 * `workspaces.list` and `workspace.forget`, which are global for the same
 * reason.
 */
function isWorkspaceScoped(method: string): boolean {
  return (WORKSPACE_SCOPED_METHODS as readonly string[]).includes(method)
}

/**
 * Wrap `client` so the listed methods carry `directory` unless the caller set
 * one explicitly.
 *
 * An explicit `directory` always wins: the footer reads reactively and a test
 * (or a future caller) may legitimately want to ask about a different workspace
 * than the one the user is sitting in.
 *
 * The real client methods take a second `options` argument (cancellation
 * signals and headers), so the wrapper forwards everything it is given rather
 * than modelling one signature and silently dropping the rest.
 *
 * Reads `Object.keys` on the client, which is what the host produces: its RPC
 * client is built with `Object.fromEntries`, so every method is an own
 * enumerable key. A client whose methods were reachable only through a proxy
 * would yield an empty wrapper, and every call would fail loudly rather than
 * quietly acting on the wrong workspace.
 */
export function bindWorkspace<T extends Record<string, unknown>>(client: T, workspace: () => string | undefined): T {
  const bound: Record<string, unknown> = {}

  for (const key of Object.keys(client)) {
    const method = client[key]
    if (typeof method !== "function" || !isWorkspaceScoped(key)) {
      bound[key] = method
      continue
    }

    bound[key] = (...args: unknown[]) => {
      const input = args[0]
      // An explicit directory wins, so it is checked before the workspace is
      // resolved: a caller that already knows which workspace it means must not
      // depend on the accessors answering, or on them answering at all.
      const explicit =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as { directory?: unknown }).directory
          : undefined
      if (typeof explicit === "string" && explicit.trim() !== "") {
        return (method as (...args: unknown[]) => unknown)(...args)
      }

      const directory = workspace()
      if (typeof directory !== "string" || directory.trim() === "") {
        // No workspace to name: the server falls back to its own directory,
        // which is the only thing it can do.
        return (method as (...args: unknown[]) => unknown)(...args)
      }

      return (method as (...args: unknown[]) => unknown)(
        {
          ...(input && typeof input === "object" && !Array.isArray(input) ? input : {}),
          directory,
        },
        ...args.slice(1),
      )
    }
  }

  return bound as T
}