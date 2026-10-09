/**
 * Tests for the CLI/TUI plugin (`tui.ts`): the `/indexing` settings view.
 *
 * `setup(context)` is exercised with a fake context whose RPC client and
 * dialogs are scripted. Assertions check the RPC calls, toasts and dialogs
 * the plugin performs for each settings-view flow.
 */
import * as assert from "node:assert/strict"
import { describe, test } from "node:test"
import { isDeepStrictEqual } from "node:util"

import type { Plugin } from "@opencode/plugin/tui"

import plugin from "../tui.ts"
import type { WorkspaceSession, WorkspaceTab } from "../tui/footer.ts"
import { SETTINGS_PAGE_NAME } from "../tui/page-mount.ts"
import { PAGE_KEYMAP } from "../tui/page-store.ts"

// ---------------------------------------------------------------------------
// Fakes and harness
// ---------------------------------------------------------------------------

interface SettingsView {
  vectorStore: "qdrant" | "lancedb"
  qdrantUrl: string
  qdrantApiKey: string
  lancedbDirectory: string
  provider: string
  model: string
  dimension: number
  importFromKilo: boolean
  autoRefresh: boolean
  enabled: boolean
  searchMaxResults: number
  hasMistralKey: boolean
  hasOpenAiKey: boolean
  settingsFile: string
}

interface KiloSource {
  kind: string
  name: string
  pointsCount: number | null
  compatible: boolean
  profile: string | null
}

type RpcCall = { method: string; input: unknown }

type ToastRecord = {
  title?: string
  message: string
  variant?: "info" | "success" | "warning" | "error"
  duration?: number
}

type DialogCall = {
  method: "select" | "prompt" | "confirm"
  options: Record<string, unknown>
}

type Command = {
  id?: string
  title?: string
  palette?: boolean
  slash?: { name: string }
  bind?: false | string
  enabled?: boolean | (() => boolean)
  run?: () => void | false | Promise<void>
}

type CommandLayer = {
  mode?: string
  priority?: number
  commands: Command[]
  bindings?: readonly string[]
}

interface HarnessOptions {
  /** Scripted `dialog.select` results, consumed in call order. */
  selects?: Array<string | undefined>
  /** Scripted `dialog.prompt` results, consumed in call order. */
  prompts?: Array<string | undefined>
  /** Scripted `dialog.confirm` results, consumed in call order. */
  confirms?: boolean[]
  /** Overrides merged over the default `settings.get` fixture. */
  settings?: Partial<SettingsView>
  /** Result of `kilo.discover`. */
  sources?: KiloSource[]
  /** Result of `settings.test`. */
  testResult?: (target: string) => { ok: boolean; message: string }
  /** Result of `status.get`. */
  status?: {
    summary: string
    recommendation: string
    ownKind: string
    ownStore: string
    ownPoints?: number | null
    ownComplete?: boolean | null
    kiloCollection?: string | null
  }
  /** Overrides for the `index.*` summaries. */
  summaries?: Partial<Record<"build" | "refresh" | "import", string>>
  /** Tabs the fake host reports open. The one with `active` is the focused tab. */
  tabs?: WorkspaceTab[]
  /** Sessions the fake client knows about, each with the directory it lives in. */
  sessions?: WorkspaceSession[]
  /** Whether the fake host reports session tabs as enabled. Defaults to enabled. */
  tabsEnabled?: boolean
  /** Publishes no slot tree at all, the way a host without a JSX runtime does. */
  noSlotApi?: boolean
  /** Keep `dialog.select` pending until `releaseDialog()` is called. */
  holdDialogs?: boolean
}

const DEFAULT_SETTINGS: SettingsView = {
  vectorStore: "qdrant",
  qdrantUrl: "http://localhost:6333",
  qdrantApiKey: "",
  lancedbDirectory: "D:\\data\\indexing",
  provider: "mistral",
  model: "codestral-embed-2505",
  dimension: 1536,
  importFromKilo: false,
  autoRefresh: true,
  enabled: true,
  searchMaxResults: 10,
  hasMistralKey: false,
  hasOpenAiKey: false,
  settingsFile: "C:\\Users\\test\\.config\\opencode\\indexing.json",
}

/**
 * Builds a fully fake `Plugin.Context`. Every RPC method is implemented so no
 * flow can crash; dialogs read from mutable queues and fall back to
 * `undefined` (select/prompt) or `false` (confirm) when a queue is exhausted.
 *
 * Tabs and sessions start empty, which is a host where tabs are enabled but
 * none is focused: the workspace then falls back to `context.location`, so the
 * fixtures that predate tabs keep asserting `D:\Proyectos`.
 */
function makeHarness(options: HarnessOptions = {}) {
  const calls: RpcCall[] = []
  const toasts: ToastRecord[] = []
  const dialogs: DialogCall[] = []

  const selects = [...(options.selects ?? [])]
  const prompts = [...(options.prompts ?? [])]
  const confirms = [...(options.confirms ?? [])]
  const settings: SettingsView = { ...DEFAULT_SETTINGS, ...options.settings }
  const tabs: Array<{ sessionID: string; active: boolean }> = (options.tabs ?? []).map((tab) => ({
    sessionID: tab.sessionID,
    active: tab.active,
  }))
  const sessions = [...(options.sessions ?? [])]
  let tabsEnabled = options.tabsEnabled ?? true

  const summary = (key: "build" | "refresh" | "import", fallback: string): string =>
    options.summaries?.[key] ?? fallback

  const rpcMethods = {
    "settings.get": async (input: Record<string, never>) => {
      calls.push({ method: "settings.get", input })
      return { settings }
    },
    "settings.set": async (input: { patch: Record<string, unknown> }) => {
      calls.push({ method: "settings.set", input })
      return { settings }
    },
    "settings.test": async (input: { target: string }) => {
      calls.push({ method: "settings.test", input })
      return options.testResult ? options.testResult(input.target) : { ok: true, message: `${input.target} ok` }
    },
    "kilo.discover": async () => {
      calls.push({ method: "kilo.discover", input: undefined })
      return { sources: options.sources ?? [] }
    },
    "status.get": async (input: { checkFreshness?: boolean }) => {
      calls.push({ method: "status.get", input })
      return (
        options.status ?? {
          summary: "Index status: unknown",
          recommendation: "",
          ownKind: "lancedb",
          ownStore: "own",
        }
      )
    },
    "index.build": async (input: { rebuild?: boolean; skipImport?: boolean }) => {
      calls.push({ method: "index.build", input })
      return { summary: summary("build", "build summary") }
    },
    "index.refresh": async (input: { maxFiles?: number }) => {
      calls.push({ method: "index.refresh", input })
      return { summary: summary("refresh", "refresh summary") }
    },
    "index.import": async (input: { source?: string; rebuild?: boolean }) => {
      calls.push({ method: "index.import", input })
      return { summary: summary("import", "import summary") }
    },
  }

  const capturedLayers: CommandLayer[] = []
  const control: { rpcFail?: Set<string> } = {}
  const slots: Array<{ path: string; placement: string; render: (input: { showDetails: boolean }) => unknown }> = []
  let route: { type: string; id?: string; name?: string } = { type: "home" }
  let releaseDialog: (() => void) | undefined
  const navigated: Array<{ type: string; name?: string }> = []

  const claimSlot = (claim: {
    append?: string
    prepend?: string
    before?: string
    after?: string
    replace?: string
    render: (input: { showDetails: boolean }) => unknown
  }): (() => void) => {
    const placement = (["append", "prepend", "before", "after", "replace"] as const).find((key) => claim[key])
    slots.push({ path: claim[placement ?? "append"] ?? "", placement: placement ?? "", render: claim.render })
    return () => {}
  }

  const ctx = {
    options: {},
    location: { directory: "D:\\Proyectos" },
    app: { version: "2.0.24", channel: "stable" },
    client: {
      rpc: (_definition: unknown) =>
        new Proxy(rpcMethods, {
          get: (target: Record<string, unknown>, property: string) => {
            const method = target[property]
            if (typeof method !== "function") return method
            return (...args: unknown[]) => {
              if (control.rpcFail?.has(property)) return Promise.reject(new Error(`${property} unavailable`))
              return (method as (...a: unknown[]) => unknown)(...args)
            }
          },
        }),
    },
    data: {
      on: () => () => {},
      listen: () => () => {},
      session: {
        list: () => sessions,
      },
    },
    theme: {},
    storage: {
      store: () => [{}, async () => {}] as const,
      memory: () => [{}, () => {}] as const,
    },
    ui: {
      toast: {
        show: (record: ToastRecord) => {
          toasts.push(record)
        },
      },
      tabs: {
        enabled: () => tabsEnabled,
        list: () => tabs.map((tab) => ({ ...tab })),
      },
      // A host without a JSX runtime publishes no slot tree at all.
      ...(options.noSlotApi ? {} : { slot: claimSlot }),
      router: {
        register: () => () => {},
        navigate: (destination: { type: string; name?: string }) => {
          navigated.push(destination)
          route = destination
        },
        current: () => route,
      },
      dialog: {
        select: async (dialogOptions: Record<string, unknown>) => {
          dialogs.push({ method: "select", options: dialogOptions })
          if (options.holdDialogs) {
            return new Promise((resolve) => {
              releaseDialog = () => resolve(selects.length > 0 ? selects.shift() : undefined)
            }) as never
          }
          return selects.length > 0 ? selects.shift() : undefined
        },
        prompt: async (dialogOptions: Record<string, unknown>) => {
          dialogs.push({ method: "prompt", options: dialogOptions })
          return prompts.length > 0 ? prompts.shift() : undefined
        },
        confirm: async (dialogOptions: Record<string, unknown>) => {
          dialogs.push({ method: "confirm", options: dialogOptions })
          return confirms.length > 0 ? (confirms.shift() ?? false) : false
        },
      },
    },
    keymap: {
      layer: (factory: () => CommandLayer) => {
        capturedLayers.push(factory())
        return () => {}
      },
    },
  }

  return {
    ctx,
    calls,
    toasts,
    dialogs,
    selects,
    prompts,
    confirms,
    navigated,
    slots,
    /** Method names that should reject, to exercise error paths. */
    get rpcFail(): Set<string> | undefined {
      return control.rpcFail
    },
    set rpcFail(value: Set<string> | undefined) {
      control.rpcFail = value
    },
    /** Every layer the plugin registered, in registration order. */
    layers(): CommandLayer[] {
      return [...capturedLayers]
    },
    /**
     * The layer that owns a given command.
     *
     * Looked up by id rather than by position: adding a layer must not silently
     * change which layer these tests inspect.
     */
    layerFor(commandId: string): CommandLayer {
      const found = capturedLayers.find((layer) => layer.commands.some((command) => command.id === commandId))
      if (!found) throw new Error(`no keymap layer owns ${commandId}`)
      return found
    },
    /** Discovery layer: the slash commands and palette entries. */
    getLayer(): CommandLayer {
      return this.layerFor("opencode.indexing.settings")
    },
    /** Navigation layer for the settings page (up/down/run/edit/reload/close). */
    getNavigationLayer(): CommandLayer {
      return this.layerFor("opencode.indexing.page.close")
    },
    /** Makes the fake host report a different current route. */
    setRoute(next: { type: string; id?: string; name?: string }): void {
      route = next
    },
    /** Focuses one of the open tabs, the way the host does when the user picks it. */
    setActiveTab(sessionID: string): void {
      for (const tab of tabs) tab.active = tab.sessionID === sessionID
    },
    /** Reports session tabs as enabled or disabled, the way a host config does. */
    setTabsEnabled(value: boolean): void {
      tabsEnabled = value
    },
    /**
     * Re-runs the live slot render, the way the host does when a signal that
     * render read has changed. Only the last registration is live: `setFooter`
     * disposes the previous one when it re-registers.
     */
    rerenderFooter(): void {
      const slot = slots[slots.length - 1]
      if (!slot) throw new Error("no footer slot was claimed")
      slot.render({ showDetails: false })
    },
    /**
     * Closes the held dialog and lets the awaiting menu continue. Waits for the
     * dialog to actually open first: commands are fire-and-forget, so the menu
     * may still be loading settings when this is called.
     */
    async releaseDialog(): Promise<void> {
      for (let tick = 0; tick < 50 && !releaseDialog; tick++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      const release = releaseDialog
      releaseDialog = undefined
      if (!release) throw new Error("no dialog was pending")
      release()
      // Let the awaiting mainMenu() unwind before the caller asserts.
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
}

type Harness = ReturnType<typeof makeHarness>

async function setupPlugin(options: HarnessOptions = {}): Promise<Harness> {
  const harness = makeHarness(options)
  await plugin.setup(harness.ctx as unknown as Plugin.Context)
  return harness
}

/** Runs the plugin's single registered command, letting rejections fail the test. */
async function runCommand(harness: Harness): Promise<void> {
  const command = harness.getLayer().commands[0]
  assert.ok(command, "layer must expose a command")
  assert.equal(typeof command.run, "function", "command must have a run function")
  await command.run?.()
}

function assertCalledWith(harness: Harness, method: string, input: unknown): void {
  assert.ok(
    harness.calls.some((call) => call.method === method && isDeepStrictEqual(call.input, input)),
    `expected ${method} to be called with ${JSON.stringify(input)}; recorded calls: ${JSON.stringify(harness.calls)}`,
  )
}

function callIndex(harness: Harness, method: string, input: unknown): number {
  return harness.calls.findIndex((call) => call.method === method && isDeepStrictEqual(call.input, input))
}

function countCalls(harness: Harness, method: string): number {
  return harness.calls.filter((call) => call.method === method).length
}

/** Workspace of every `status.get`, in call order. */
function statusDirectories(harness: Harness): Array<string | undefined> {
  return harness.calls
    .filter((call) => call.method === "status.get")
    .map((call) => (call as { input: { directory?: string } }).input.directory)
}

/** Waits for the footer's deferred repaint and its RPC round trip to land. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tui plugin", () => {
  test("setup registers /indexing plus a palette-only dialogs fallback", async () => {
    const harness = await setupPlugin()
    const layer = harness.getLayer()

    assert.equal(layer.mode, "global")
    assert.equal(layer.priority, 10)

    const page = layer.commands.find((command) => command.id === "opencode.indexing.settings")
    assert.ok(page, "the page command must be registered")
    assert.equal(page.slash?.name, "indexing")
    assert.equal(page.palette, true)
    assert.equal(typeof page.run, "function")

    const dialogs = layer.commands.find((command) => command.id === "opencode.indexing.dialogs")
    assert.ok(dialogs, "the dialogs escape hatch must be registered")
    assert.equal(dialogs.slash, undefined, "the dialogs menu must not add a slash name")
    assert.equal(dialogs.palette, true)

    // Discovery only: no key bindings, so the layer never shadows a host binding.
    assert.deepEqual(layer.bindings, undefined)
  })

  test("page navigation commands are bound but inert while the page is closed", async () => {
    const harness = await setupPlugin()
    const layer = harness.getNavigationLayer()

    const navigation = PAGE_KEYMAP.map((entry) => {
      const command = layer.commands.find((candidate) => candidate.id === entry.id)
      assert.ok(command, `missing navigation command ${entry.id}`)
      assert.equal(command.bind, entry.bind, `${entry.id} must bind ${entry.bind}`)
      return command
    })

    for (const command of navigation) {
      assert.equal(typeof command.enabled === "function" ? command.enabled() : command.enabled, false)
    }
  })

  test("the escape command navigates home once the page route is current", async () => {
    const harness = await setupPlugin()
    const layer = harness.getNavigationLayer()

    harness.setRoute({ type: "plugin", id: "opencode.indexing", name: SETTINGS_PAGE_NAME })
    const close = layer.commands.find((command) => command.id === "opencode.indexing.page.close")
    assert.ok(close)
    assert.equal(typeof close.enabled === "function" ? close.enabled() : close.enabled, true)

    await close.run?.()

    assert.equal(harness.navigated.length, 1)
    assert.deepEqual(harness.navigated[0], { type: "home" })
  })

  test("page keys go to the dialog while the editor is stacked on the page", async () => {
    const harness = await setupPlugin({ holdDialogs: true })
    const layer = harness.getNavigationLayer()
    harness.setRoute({ type: "plugin", id: "opencode.indexing", name: SETTINGS_PAGE_NAME })

    const isEnabled = (id: string): boolean => {
      const command = layer.commands.find((candidate) => candidate.id === id)
      assert.ok(command, `missing ${id}`)
      const state = typeof command.enabled === "function" ? command.enabled() : command.enabled
      return state === true
    }
    const edit = layer.commands.find((command) => command.id === "opencode.indexing.page.edit")
    assert.ok(edit)

    assert.equal(isEnabled("opencode.indexing.page.down"), true)
    assert.equal(isEnabled("opencode.indexing.page.run"), true)
    assert.equal(isEnabled("opencode.indexing.page.close"), true)

    // `e` opens the dialog editor and holds it open.
    edit.run?.()

    for (const entry of PAGE_KEYMAP) {
      assert.equal(isEnabled(entry.id), false, `${entry.id} must be inert while a dialog is open`)
    }

    // Escape must not tear the route down underneath the dialog either.
    const close = layer.commands.find((command) => command.id === "opencode.indexing.page.close")
    await close?.run?.()
    assert.deepEqual(harness.navigated, [], "escape must not navigate while the dialog is open")

    // Dismissing the dialog hands the keys back to the page.
    await harness.releaseDialog()
    assert.equal(isEnabled("opencode.indexing.page.close"), true)
    assert.equal(isEnabled("opencode.indexing.page.down"), true)
  })

  test("the palette dialogs command also holds the page keys off", async () => {
    const harness = await setupPlugin({ holdDialogs: true })
    const navigation = harness.getNavigationLayer()
    harness.setRoute({ type: "plugin", id: "opencode.indexing", name: SETTINGS_PAGE_NAME })

    const isEnabled = (id: string): boolean => {
      const command = navigation.commands.find((candidate) => candidate.id === id)
      assert.ok(command, `missing ${id}`)
      const state = typeof command.enabled === "function" ? command.enabled() : command.enabled
      return state === true
    }

    const paletteDialogs = harness
      .getLayer()
      .commands.find((command) => command.id === "opencode.indexing.dialogs")
    assert.ok(paletteDialogs)

    assert.equal(isEnabled("opencode.indexing.page.close"), true)
    paletteDialogs.run?.()

    // Opening the dialogs from the palette must gate the page keys exactly like
    // pressing `e` does, otherwise arrows and escape leak to the page behind it.
    for (const entry of PAGE_KEYMAP) {
      assert.equal(isEnabled(entry.id), false, `${entry.id} must be inert while the dialog is open`)
    }

    await harness.releaseDialog()
    assert.equal(isEnabled("opencode.indexing.page.close"), true)
  })

  test("a second /indexing while the first is in flight is ignored", async () => {
    const harness = await setupPlugin({ holdDialogs: true })
    const page = harness.getLayer().commands.find((command) => command.id === "opencode.indexing.settings")
    assert.ok(page)

    // The first open falls back to the dialogs here (no JSX runtime under
    // node --test) and stays pending because the harness holds the select.
    page.run?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(harness.dialogs.length, 1)

    // A second open while the first is unresolved must not stack another dialog:
    // interleaved registrations leave `disposePage` holding only one disposer.
    page.run?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(harness.dialogs.length, 1, "the reentrancy guard must swallow the second open")

    await harness.releaseDialog()
  })

  test("the footer is claimed exactly once, however many state changes happen", async () => {
    const harness = await setupPlugin({
      status: {
        summary: "ready",
        recommendation: "",
        ownKind: "qdrant",
        ownStore: "oc-demo",
        ownPoints: 100,
        ownComplete: true,
        kiloCollection: null,
      },
    })
    // Registering a fresh claim per state change made the host render the
    // indicator twice, so the count is the assertion that matters here.
    assert.equal(harness.slots.length, 1, "the slot must be claimed once at setup")

    const toggle = harness.layerFor("opencode.indexing.toggle").commands.find((c) => c.id === "opencode.indexing.toggle")
    assert.ok(toggle)
    await toggle.run?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await toggle.run?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(harness.slots.length, 1, "state changes must repaint the claim, not add another")
  })

  test("setup survives a host without a JSX runtime and renders no footer content", async () => {
    const harness = await setupPlugin()
    // node --test cannot load .tsx, so the footer module rejects and no element
    // is ever built. The plugin must keep working: what it still claims is the
    // reactive workspace watch the indicator needs (see the tab-switch test
    // below), and its render yields nothing. The indicator's own logic is
    // covered by test/footer.test.ts.
    const live = harness.slots[harness.slots.length - 1]
    assert.ok(live, "the workspace watch must still be claimed")
    assert.equal(live.render({ showDetails: false }), null, "no indicator without the JSX runtime")
    assert.equal(harness.toasts.filter((toast) => toast.variant === "error").length, 0)
  })

  test("setup survives a host with no slot tree at all", async () => {
    const harness = await setupPlugin({ noSlotApi: true })

    // Nothing to claim, so no indicator and no watch — but the status must still
    // be read: the palette command runs the same action as a click, and it must
    // work wherever the footer cannot be rendered.
    assert.deepEqual(harness.slots, [])
    assertCalledWith(harness, "status.get", { checkFreshness: false, directory: "D:\\Proyectos" })
  })

  test("the footer names the ACTIVE tab's workspace, not the plugin instance directory", async () => {
    const harness = await setupPlugin({
      tabs: [
        { sessionID: "ses-home", active: false },
        { sessionID: "ses-work", active: true },
      ],
      sessions: [
        // Same shape as the live host: the instance directory is the home the
        // service was started in, and the tabs are where the work happens.
        { id: "ses-home", location: { directory: "C:\\Users\\clust" } },
        { id: "ses-work", location: { directory: "D:\\Proyectos\\opencode-indexing" } },
      ],
    })

    assertCalledWith(harness, "status.get", {
      checkFreshness: false,
      directory: "D:\\Proyectos\\opencode-indexing",
    })
  })

  test("the footer falls back to the instance directory when tabs are disabled", async () => {
    const harness = await setupPlugin({
      tabsEnabled: false,
      tabs: [{ sessionID: "ses-work", active: true }],
      sessions: [{ id: "ses-work", location: { directory: "D:\\Proyectos\\opencode-indexing" } }],
    })

    // Tabs switched off means the host never told us where the user is, so the
    // instance directory stays the only directory there is to name.
    assertCalledWith(harness, "status.get", { checkFreshness: false, directory: "D:\\Proyectos" })
  })

  test("switching to a tab in another directory re-reads that workspace", async () => {
    const harness = await setupPlugin({
      tabs: [
        { sessionID: "ses-here", active: true },
        { sessionID: "ses-there", active: false },
      ],
      sessions: [
        { id: "ses-here", location: { directory: "D:\\Proyectos" } },
        { id: "ses-there", location: { directory: "D:\\Proyectos\\other" } },
      ],
    })
    assert.deepEqual(statusDirectories(harness), ["D:\\Proyectos"])

    harness.setActiveTab("ses-there")
    // The host re-runs the slot render when a signal it read has changed.
    harness.rerenderFooter()
    await settle()

    // One fetch for the new workspace, and none for the old one again: the
    // comparison against the last fetched directory is what keeps the footer
    // from polling the server on every repaint.
    assert.deepEqual(statusDirectories(harness), [
      "D:\\Proyectos",
      "D:\\Proyectos\\other",
    ])
  })

  test("repainting without a workspace change does not re-read the status", async () => {
    const harness = await setupPlugin({
      tabs: [{ sessionID: "ses-here", active: true }],
      sessions: [{ id: "ses-here", location: { directory: "D:\\Proyectos\\opencode-indexing" } }],
    })

    harness.rerenderFooter()
    await settle()

    assert.deepEqual(statusDirectories(harness), ["D:\\Proyectos\\opencode-indexing"])
  })

  test("the footer action pauses a healthy index", async () => {
    const harness = await setupPlugin({
      status: {
        summary: "81.4k points, complete",
        recommendation: "",
        ownKind: "qdrant",
        ownStore: "oc-demo",
        ownPoints: 81_400,
        ownComplete: true,
        kiloCollection: null,
      },
    })
    const toggle = harness.layerFor("opencode.indexing.toggle").commands.find((c) => c.id === "opencode.indexing.toggle")
    assert.ok(toggle)
    assert.equal(toggle.bind, false, "the toggle must not claim a key by default")
    assert.equal(toggle.palette, true)

    await toggle.run?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assertCalledWith(harness, "settings.set", { patch: { enabled: false } })
    assert.ok(
      harness.toasts.some((toast) => toast.message === "Indexing paused"),
      "the user must be told which state it landed in",
    )
  })

  test("the footer action resumes a paused index without rebuilding", async () => {
    const harness = await setupPlugin({
      settings: { enabled: false },
      status: {
        summary: "paused",
        recommendation: "",
        ownKind: "qdrant",
        ownStore: "oc-demo",
        ownPoints: 81_400,
        ownComplete: true,
        kiloCollection: null,
      },
    })
    const toggle = harness.layerFor("opencode.indexing.toggle").commands.find((c) => c.id === "opencode.indexing.toggle")
    assert.ok(toggle)

    await toggle.run?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assertCalledWith(harness, "settings.set", { patch: { enabled: true } })
    assert.ok(harness.toasts.some((toast) => toast.message === "Indexing resumed"))
    assert.equal(countCalls(harness, "index.build"), 0, "resuming must not kick off a build")
  })

  test("index actions name the workspace, so they never default to the service directory", async () => {
    const harness = await setupPlugin({
      status: {
        summary: "incomplete",
        recommendation: "",
        ownKind: "qdrant",
        ownStore: "oc-demo",
        ownPoints: 571,
        ownComplete: false,
        kiloCollection: null,
      },
    })
    const toggle = harness.layerFor("opencode.indexing.toggle").commands.find((c) => c.id === "opencode.indexing.toggle")
    assert.ok(toggle)

    await toggle.run?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Without the directory the server would resolve its own instance root, so the
    // footer could report one workspace and the action would write another.
    const refresh = harness.calls.find((call) => call.method === "index.refresh") as
      | { input: { directory?: string } }
      | undefined
    assert.ok(refresh, "an incomplete index must trigger a refresh")
    assert.equal(refresh.input.directory, "D:\\Proyectos", "the caller's workspace must be sent")

    const status = harness.calls
      .filter((call) => call.method === "status.get")
      .map((call) => call as { input: { directory?: string } })
    assert.ok(status.length > 0, "the footer must also read status for that workspace")
    assert.equal(status[status.length - 1].input.directory, "D:\\Proyectos")
  })

  test("the footer action refreshes a stale index instead of pausing it", async () => {
    const harness = await setupPlugin({
      status: {
        summary: "81.4k points, incomplete",
        recommendation: "",
        ownKind: "qdrant",
        ownStore: "oc-demo",
        ownPoints: 81_400,
        ownComplete: false,
        kiloCollection: null,
      },
    })
    const toggle = harness.layerFor("opencode.indexing.toggle").commands.find((c) => c.id === "opencode.indexing.toggle")
    assert.ok(toggle)

    await toggle.run?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assertCalledWith(harness, "index.refresh", { directory: "D:\\Proyectos" })
    assert.equal(countCalls(harness, "settings.set"), 0, "a stale index needs a refresh, not a pause")
    assert.equal(countCalls(harness, "index.build"), 0, "a stale index must never trigger a full rebuild")
  })

  test("the footer action builds when there is no index at all", async () => {
    const harness = await setupPlugin({
      status: {
        summary: "not built",
        recommendation: "",
        ownKind: "qdrant",
        ownStore: "oc-demo",
        ownPoints: null,
        ownComplete: null,
        kiloCollection: "ws-demo",
      },
    })
    const toggle = harness.layerFor("opencode.indexing.toggle").commands.find((c) => c.id === "opencode.indexing.toggle")
    assert.ok(toggle)

    await toggle.run?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assertCalledWith(harness, "index.build", { skipImport: false, directory: "D:\\Proyectos" })
  })

  test("the footer action reports a failure instead of silently doing nothing", async () => {
    const harness = await setupPlugin({
      status: {
        summary: "81.4k points, complete",
        recommendation: "",
        ownKind: "qdrant",
        ownStore: "oc-demo",
        ownPoints: 81_400,
        ownComplete: true,
        kiloCollection: null,
      },
    })
    harness.rpcFail = new Set(["settings.set"])
    const toggle = harness.layerFor("opencode.indexing.toggle").commands.find((c) => c.id === "opencode.indexing.toggle")
    assert.ok(toggle)

    await toggle.run?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.ok(
      harness.toasts.some((toast) => toast.variant === "error"),
      "a failed action must surface an error toast",
    )
  })

  test("the discovery commands are reachable but never bind a key", async () => {
    const harness = await setupPlugin()
    const layer = harness.getLayer()
    for (const id of ["opencode.indexing.settings", "opencode.indexing.dialogs"]) {
      const command = layer.commands.find((candidate) => candidate.id === id)
      assert.ok(command, `missing ${id}`)
      assert.equal(command.bind, false, `${id} must not bind a key`)
    }
  })

  test("menu renders and dismisses cleanly when the user escapes", async () => {
    const harness = await setupPlugin({ selects: [undefined] })
    await runCommand(harness)

    assert.ok(countCalls(harness, "settings.get") >= 1, "settings.get must be consulted to render the menu")
    assert.equal(harness.toasts.filter((toast) => toast.variant === "error").length, 0)

    const select = harness.dialogs.find((dialog) => dialog.method === "select")
    assert.ok(select, "the menu must be rendered with dialog.select")
    assert.equal(select.options.title, "Indexing settings")
  })

  test("import toggle flips via settings.set", async () => {
    const harness = await setupPlugin({ selects: ["importToggle"] })
    await runCommand(harness)

    assertCalledWith(harness, "settings.set", { patch: { importFromKilo: true } })
    assert.equal(countCalls(harness, "settings.set"), 1)
    assert.ok(
      harness.toasts.some((toast) => toast.variant === "success" && toast.message === "Import from Kilo: ON"),
      "a success toast must announce the toggle",
    )
  })

  test("qdrant flow prompts URL, persists it and tests the connection", async () => {
    const harness = await setupPlugin({
      selects: ["qdrant"],
      prompts: ["http://192.168.1.50:6333", ""],
    })
    await runCommand(harness)

    assertCalledWith(harness, "settings.set", { patch: { qdrant: { url: "http://192.168.1.50:6333" } } })
    assertCalledWith(harness, "settings.test", { target: "qdrant" })
    // Empty API key prompt means "keep current": no second settings.set.
    assert.equal(countCalls(harness, "settings.set"), 1)
  })

  test("lancedb choice prompts for the directory", async () => {
    const harness = await setupPlugin({
      selects: ["vectorStore", "lancedb"],
      prompts: ["D:\\data\\lancedb"],
    })
    await runCommand(harness)

    assert.equal(
      harness.dialogs.filter((dialog) => dialog.method === "select").length,
      2,
      "main menu select followed by the store chooser select",
    )
    assertCalledWith(harness, "settings.set", { patch: { vectorStore: "lancedb" } })
    assertCalledWith(harness, "settings.set", { patch: { lancedb: { directory: "D:\\data\\lancedb" } } })
    assert.ok(
      callIndex(harness, "settings.set", { patch: { vectorStore: "lancedb" } }) <
        callIndex(harness, "settings.set", { patch: { lancedb: { directory: "D:\\data\\lancedb" } } }),
      "the store is persisted before the directory",
    )
  })

  test("kilo menu imports a chosen source after confirm", async () => {
    const source: KiloSource = {
      kind: "lancedb",
      name: "test-db",
      pointsCount: 100,
      compatible: true,
      profile: "mistral:codestral-embed-2505:1536",
    }
    const harness = await setupPlugin({
      selects: ["kilo", "test-db"],
      confirms: [true],
      sources: [source],
      summaries: { import: "Imported 100 points from test-db" },
    })
    await runCommand(harness)

    assert.ok(harness.calls.some((call) => call.method === "kilo.discover"), "sources must be discovered first")
    assertCalledWith(harness, "index.import", { source: "test-db" })
    assert.ok(
      harness.toasts.some((toast) => toast.variant === "success" && toast.message === "Imported 100 points from test-db"),
      "the import summary must be toasted on success",
    )
  })

  test("status toasts summary and recommendation", async () => {
    const status = {
      summary: "Own index: 42 points (lancedb)",
      recommendation: "Rebuild after changing the embedding model",
      ownKind: "lancedb",
      ownStore: "own-lancedb",
    }
    const harness = await setupPlugin({ selects: ["status"], status })
    await runCommand(harness)

    assertCalledWith(harness, "status.get", { checkFreshness: true })
    assert.ok(
      harness.toasts.some((toast) => toast.message === status.summary),
      "the summary must be toasted",
    )
    assert.ok(
      harness.toasts.some((toast) => toast.message === status.recommendation),
      "the recommendation must be toasted",
    )
  })

  test("provider flow persists provider and mistral key", async () => {
    const harness = await setupPlugin({
      selects: ["provider", "mistral"],
      prompts: ["", "abc123"],
    })
    await runCommand(harness)

    assertCalledWith(harness, "settings.set", { patch: { provider: "mistral" } })
    assertCalledWith(harness, "settings.set", { patch: { apiKeys: { mistral: "abc123" } } })
    assert.ok(
      callIndex(harness, "settings.set", { patch: { provider: "mistral" } }) <
        callIndex(harness, "settings.set", { patch: { apiKeys: { mistral: "abc123" } } }),
      "the provider is persisted before the API key",
    )
    assertCalledWith(harness, "settings.test", { target: "provider" })
  })
})
