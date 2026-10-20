/**
 * opencode-indexing — CLI/TUI plugin.
 *
 * Two settings surfaces, both driven by the server plugin's RPC so
 * configuration stays in one place (`~/.config/opencode/indexing.json`):
 *
 *  1. `/indexing` → the settings page (`tui/settings-page.ts`), loaded
 *     lazily. It is JSX-free and takes its runtime from the host (see
 *     `tui/host-runtime.ts`); if the host cannot provide those modules it
 *     degrades to:
 *  2. the same options as modal dialogs, dialogs-only and dependency-free, so
 *     the plugin still works on any host build. Reached with `e` from the page,
 *     automatically as the fallback, and from the palette ("Indexing: settings
 *     (dialogs)") as a manual escape hatch.
 *
 * Only TYPE imports from @opencode/plugin are used at build time; the runtime
 * resolves the real package (documented layout: `tui.ts` beside `index.ts`).
 */
import type { Plugin } from "@opencode/plugin/tui"
import type { Route } from "@opencode/plugin/tui/context"
import type { JSX } from "@opentui/solid"

import { IndexingRpc } from "./src/rpc.ts"
import { SETTINGS_PAGE_NAME, mountSettingsPage, type RouterLike } from "./tui/page-mount.ts"
import { PAGE_KEYMAP, SettingsPageStore } from "./tui/page-store.ts"
import type { ThemeLike } from "./tui/page-style.ts"
import { PAGE_ACTIONS, PAGE_ROWS, type SettingsPageRpc } from "./tui/settings-page-data.ts"
import { footerAction, footerState, type IndexingState } from "./tui/footer.ts"
import { activeWorkspace, type WorkspaceSources } from "./tui/footer.ts"
import { bindWorkspace } from "./tui/workspace-rpc.ts"
import { describeRow, forgetWorkspaceFlow, type WorkspacesRpc } from "./tui/workspaces.ts"
import { pagePalette } from "./tui/page-style.ts"
import type { FooterHandle, FooterState } from "./tui/footer-view.ts"
import { describeError } from "./src/errors.ts"
import { getDefaultModelId, isLiveTested, listModelIds } from "./src/registry.ts"
import type { EmbedderProvider } from "./src/types.ts"

/**
 * Navigable rows on the page.
 *
 * Derived from `PAGE_ROWS`, the same list the view renders: recomputing
 * `actions + 2` here would silently drift the store size from the rendered rows
 * and make the last row unreachable.
 */
const PAGE_ROW_COUNT = PAGE_ROWS.length

const ID = "opencode.indexing"

/** Sentinel for the "type it yourself" entry in the model chooser. */
const CUSTOM_MODEL = "\u0000custom-model"

type RpcClient = {
  "settings.get": (input: Record<string, never>) => Promise<{ settings: SettingsView; version?: string }>
  "settings.set": (input: { patch: Record<string, unknown> }) => Promise<{ settings: SettingsView }>
  "settings.test": (input: {
    target: "qdrant" | "lancedb" | "provider" | "kilo"
    directory?: string
  }) => Promise<{ ok: boolean; message: string }>
  "kilo.discover": (input?: { directory?: string }) => Promise<{
    sources: Array<{ kind: string; name: string; pointsCount: number | null; compatible: boolean; profile: string | null }>
    /** Sources that exist but could not be read. */
    problems?: string[]
  }>
  "status.get": (input: { checkFreshness?: boolean; directory?: string }) => Promise<{ summary: string; recommendation: string; ownKind: string; ownStore: string; ownPoints?: number | null; ownComplete?: boolean | null; kiloCollection?: string | null; directory?: string; ownStoreReachable?: boolean }>
  "index.build": (input: { rebuild?: boolean; skipImport?: boolean; directory?: string }) => Promise<{ summary: string; error?: string }>
  "index.refresh": (input: { maxFiles?: number; directory?: string }) => Promise<{ summary: string; error?: string }>
  "index.import": (input: { source?: string; rebuild?: boolean; directory?: string }) => Promise<{ summary: string; error?: string }>
}

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
  /** Master switch for writing the own index. */
  enabled: boolean
  searchMaxResults: number
  /** Providers that have a usable credential or base URL configured. */
  configuredProviders: string[]
  settingsFile: string
}

const plugin = {
  id: ID,
  async setup(context: Plugin.Context): Promise<void> {
    /**
     * The workspace the caller is working in.
     *
     * The server plugin serves its own instance directory, so every RPC that
     * reads or writes an index must be told which workspace it is about. Without
     * this the footer would report — and the palette command would index — the
     * service's directory instead of the user's: the ACTIVE tab is what follows
     * the user, and the instance directory is the fallback for a host with tabs
     * switched off.
     *
     * Every accessor is optional: a host may expose neither `ui.tabs` nor
     * `data.session`, and resolving the workspace must degrade rather than
     * throw. Read from a reactive context (the footer slot render) the lookups
     * re-run when the host's tab or session state changes.
     *
     * Declared before `rpc` because `rpc` binds the directory into every
     * workspace-scoped call: a call made before this binding exists would be
     * answered against the service's own directory.
     */
    const workspaceSources: WorkspaceSources = {
      tabsEnabled: () => context.ui.tabs?.enabled?.() === true,
      tabs: () => context.ui.tabs?.list?.() ?? [],
      sessions: () => context.data?.session?.list?.() ?? [],
      instanceDirectory: () => context.location?.directory,
    }

    const workspace = (): string | undefined => activeWorkspace(workspaceSources)

    // Resolve the RPC subclient lazily: the TUI may start before the server
    // plugin is ready, and calls are retried on first use.
    //
    // Every call goes through `bindWorkspace`, so a workspace-scoped method
    // always names the caller's directory. Passing it per call site is what
    // failed before: the footer did it and the palette did not, and the palette
    // silently read and wrote the service's index instead of the user's.
    const rpc = (): RpcClient =>
      bindWorkspace(
        (context.client as unknown as { rpc: (def: unknown, options?: unknown) => RpcClient }).rpc(IndexingRpc),
        workspace,
      )

    const toast = (message: string, variant: "success" | "error" | "info" = "info"): void => {
      context.ui.toast.show({ title: "Indexing", message, variant, duration: 5000 })
    }

    const fail = (error: unknown): void => {
      toast(describeError(error), "error")
    }

    /**
     * Toasts the outcome of an index run. A failed run arrives as data, not as a
     * rejection: the host turns a thrown error into an RPC 500 with no body, and
     * the one thing worth reading is exactly what got dropped on the way.
     */
    const reportRun = (result: { summary: string; error?: string }): void => {
      if (result.error) toast(`${result.summary}: ${result.error}`, "error")
      else toast(result.summary, "success")
    }

    async function loadSettings(): Promise<SettingsView> {
      const response = await rpc()["settings.get"]({})
      return response.settings
    }

    async function patchSettings(patch: Record<string, unknown>): Promise<SettingsView> {
      const response = await rpc()["settings.set"]({ patch })
      return response.settings
    }

    /**
     * Lists indexed workspaces and forgets the chosen one.
     *
     * Confirms first: dropping a collection loses the index and re-indexing costs
     * embedding credits. The directory name is shown in both prompts, never the
     * raw collection hash alone.
     */
    async function manageWorkspaces(): Promise<void> {
      try {
        const summary = await forgetWorkspaceFlow(
          rpc() as unknown as WorkspacesRpc,
          async (rows) => {
            const choice = await context.ui.dialog.select({
              title: "Forget an indexed workspace",
              options: rows.map((row) => ({
                title: row.root ?? `unknown (${row.store})`,
                value: row.store,
                description: describeRow(row),
              })),
            })
            return rows.find((row) => row.store === choice)
          },
          async (row) =>
            (await context.ui.dialog.confirm({
              title: "Forget this index?",
              message: `${row.root ?? row.store} — the collection is deleted and re-indexing it later costs embedding credits.`,
              label: { confirm: "Forget", cancel: "Keep" },
            })) === true,
        )
        toast(summary, "info")
      } catch (error) {
        fail(error)
      }
    }

    async function mainMenu(): Promise<void> {
      let settings: SettingsView
      let version: string | undefined
      try {
        // Read the whole response rather than `loadSettings()`: the version is
        // only needed here, and it rides along with the settings, so naming the
        // release in the dialog costs no extra round trip.
        const response = await rpc()["settings.get"]({})
        settings = response.settings
        version = response.version
      } catch (error) {
        fail(error)
        return
      }

      const choice = await context.ui.dialog.select({
        // Named in the title so a report about this dialog can quote the build
        // it came from. Omitted when the server could not read its manifest.
        title: version ? `Indexing settings · v${version}` : "Indexing settings",
        current: settings.vectorStore,
        options: [
          {
            title: `Vector store: ${settings.vectorStore}`,
            value: "vectorStore",
            description: settings.vectorStore === "qdrant" ? `Qdrant · ${settings.qdrantUrl}` : `LanceDB · ${settings.lancedbDirectory}`,
            category: "Configuration",
          },
          {
            title: `Qdrant URL: ${settings.qdrantUrl}`,
            value: "qdrant",
            description: "Local or remote Qdrant server (http://host:6333)",
            category: "Configuration",
          },
          {
            title: `Embeddings: ${settings.provider}/${settings.model}${settings.dimension ? ` (${settings.dimension}d)` : ""}`,
            value: "provider",
            description: "Embedding provider, model and API key",
            category: "Configuration",
          },
          {
            title: `Import from Kilo: ${settings.importFromKilo ? "ON (zero-cost import)" : "OFF (index from scratch)"}`,
            value: "importToggle",
            description: "When ON, build imports Kilo's existing index without embedding calls",
            category: "Configuration",
          },
          {
            title: `Auto-refresh on search: ${settings.autoRefresh ? "ON" : "OFF"}`,
            value: "autoRefresh",
            description: "Refresh the index inline when few files changed",
            category: "Configuration",
          },
          {
            title: "Test connections",
            value: "test",
            description: "Qdrant, LanceDB, embedding provider and Kilo sources",
            category: "Diagnostics",
          },
          {
            title: "Kilo sources (detect / import)",
            value: "kilo",
            description: "List Kilo indexes and import one without re-embedding",
            category: "Diagnostics",
          },
          {
            title: "Build / Refresh index",
            value: "index",
            description: "Create or incrementally update the own index",
            category: "Actions",
          },
          {
            title: "Status",
            value: "status",
            description: "Points, profile, freshness and recommendation",
            category: "Diagnostics",
          },
          {
            title: `Settings file: ${settings.settingsFile}`,
            value: "file",
            description: "Edit JSON directly for advanced options",
            category: "Info",
          },
          {
            title: "Indexed workspaces…",
            value: "workspaces",
            description: "List the directories with an index, and forget one",
            category: "Info",
          },
        ],
      })

      switch (choice) {
        case "vectorStore":
          await chooseVectorStore(settings)
          break
        case "qdrant":
          await configureQdrant(settings)
          break
        case "provider":
          await configureProvider(settings)
          break
        case "importToggle":
          await patchSettings({ importFromKilo: !settings.importFromKilo })
          toast(`Import from Kilo: ${!settings.importFromKilo ? "ON" : "OFF"}`, "success")
          break
        case "autoRefresh":
          await patchSettings({ autoRefresh: !settings.autoRefresh })
          toast(`Auto-refresh: ${!settings.autoRefresh ? "ON" : "OFF"}`, "success")
          break
        case "test":
          await runTests()
          break
        case "kilo":
          await kiloMenu()
          break
        case "index":
          await indexMenu(settings)
          break
        case "status":
          await showStatus()
          break
        case "file":
          toast(`Edit: ${settings.settingsFile}`, "info")
          break
        case "workspaces":
          await manageWorkspaces()
          break
        default:
          break
      }
    }

    async function chooseVectorStore(settings: SettingsView): Promise<void> {
      const store = await context.ui.dialog.select({
        title: "Vector store for the own index",
        current: settings.vectorStore,
        options: [
          {
            title: "Qdrant",
            value: "qdrant",
            description: "HTTP server, collections `oc-<hash>`. Also used to read Kilo's index for import",
          },
          {
            title: "LanceDB",
            value: "lancedb",
            description: "Embedded native database (no server). Requires @lancedb/lancedb@0.26.2",
          },
        ],
      })
      if (store !== "qdrant" && store !== "lancedb") return
      await patchSettings({ vectorStore: store })
      toast(`Vector store set to ${store}`, "success")

      if (store === "lancedb") {
        const directory = await context.ui.dialog.prompt({
          title: "LanceDB directory",
          placeholder: settings.lancedbDirectory,
        })
        if (directory && directory.trim()) {
          await patchSettings({ lancedb: { directory: directory.trim() } })
          toast(`LanceDB directory: ${directory.trim()}`, "success")
        }
      }
    }

    async function configureQdrant(settings: SettingsView): Promise<void> {
      const url = await context.ui.dialog.prompt({
        title: "Qdrant URL (local or remote)",
        placeholder: settings.qdrantUrl,
      })
      if (!url || !url.trim()) return
      await patchSettings({ qdrant: { url: url.trim() } })
      toast(`Qdrant URL: ${url.trim()}`, "success")

      const key = await context.ui.dialog.prompt({
        title: "Qdrant API key (leave empty to keep current)",
        placeholder: settings.qdrantApiKey ? "•••••• (set)" : "empty",
      })
      if (key !== undefined && key !== null && key.trim() !== "") {
        await patchSettings({ qdrant: { apiKey: key.trim() } })
        toast("Qdrant API key updated", "success")
      }

      const test = await rpc()["settings.test"]({ target: "qdrant" })
      toast(test.message, test.ok ? "success" : "error")
    }

    async function configureProvider(settings: SettingsView): Promise<void> {
      const provider = await context.ui.dialog.select({
        title: "Embedding provider",
        current: settings.provider,
        options: [
          { title: "mistral (codestral-embed)", value: "mistral", description: "Default. Requires a Mistral API key" },
          { title: "openai", value: "openai", description: "text-embedding-3-small/large" },
          { title: "ollama (local)", value: "ollama", description: "Local models, no API key" },
          { title: "openai-compatible", value: "openai-compatible", description: "Any OpenAI-compatible endpoint (base URL required)" },
          { title: "gemini", value: "gemini", description: "Google embeddings" },
          { title: "voyage", value: "voyage", description: "voyage-code-3 (code-tuned)" },
          { title: "openrouter", value: "openrouter", description: "Routes through OpenRouter" },
        ],
      })
      if (typeof provider !== "string") return

      // Offer the catalog instead of a blank text field. The model list existed
      // all along and was never shown, so the only way to discover a valid model
      // id was to already know it.
      const catalog = listModelIds(provider as EmbedderProvider)
      const defaultModel = getDefaultModelId(provider as EmbedderProvider)
      const tested = isLiveTested(provider as EmbedderProvider)
      const choice = await context.ui.dialog.select({
        title: `Model for ${provider}`,
        options: [
          {
            title: defaultModel ? `${defaultModel} (default)` : "(provider default)",
            value: "",
            description: tested
              ? "Leave the model unset so the provider default applies"
              : "Not yet exercised against the real API; see the README",
          },
          ...catalog
            .filter((modelId) => modelId !== defaultModel)
            .map((modelId) => ({ title: modelId, value: modelId, description: `${provider} model` })),
          {
            title: "Custom…",
            value: CUSTOM_MODEL,
            description: catalog.length > 0 ? "Type a model id that is not in the list" : "This provider has no catalog; type the model id",
          },
        ],
      })
      if (typeof choice !== "string") return

      let model = choice
      if (choice === CUSTOM_MODEL) {
        const typed = await context.ui.dialog.prompt({
          title: `Model id for ${provider}`,
          placeholder: defaultModel || "e.g. bge-m3",
        })
        if (typed === undefined) return
        model = typed.trim()
      }

      // `model` is always written, empty when the user accepted the default.
      // Omitting it left the previous provider's model in the file, where it
      // outranks the new provider's default: switching to voyage produced
      // `voyage` + `codestral-embed-2505`.
      await patchSettings({ provider, model })

      // API key for the provider (masked prompt).
      const keyLabel =
        provider === "mistral"
          ? "Mistral API key"
          : provider === "openai"
            ? "OpenAI API key"
            : provider === "gemini"
              ? "Gemini API key"
              : provider === "voyage"
                ? "Voyage API key"
                : provider === "openrouter"
                  ? "OpenRouter API key"
                  : null

      if (keyLabel) {
        const current = settings.configuredProviders.includes(provider)
        const key = await context.ui.dialog.prompt({
          title: `${keyLabel} (leave empty to keep current)`,
          placeholder: current ? "•••••• (set)" : "not set",
        })
        if (key && key.trim()) {
          const apiKeys: Record<string, unknown> = {}
          if (provider === "mistral") apiKeys.mistral = key.trim()
          if (provider === "openai") apiKeys.openai = key.trim()
          if (provider === "gemini") apiKeys.gemini = key.trim()
          if (provider === "voyage") apiKeys.voyage = key.trim()
          if (provider === "openrouter") apiKeys.openrouter = key.trim()
          await patchSettings({ apiKeys })
          toast(`${keyLabel} saved`, "success")
        }
      } else if (provider === "openai-compatible") {
        const baseUrl = await context.ui.dialog.prompt({ title: "Base URL", placeholder: "http://localhost:8080/v1" })
        if (baseUrl && baseUrl.trim()) {
          await patchSettings({ apiKeys: { "openai-compatible": { baseUrl: baseUrl.trim() } } })
        }
        const key = await context.ui.dialog.prompt({ title: "API key (optional)" })
        if (key && key.trim()) {
          await patchSettings({ apiKeys: { "openai-compatible": { apiKey: key.trim() } } })
        }
      } else if (provider === "ollama") {
        const baseUrl = await context.ui.dialog.prompt({ title: "Ollama base URL", placeholder: "http://localhost:11434" })
        if (baseUrl && baseUrl.trim()) {
          await patchSettings({ apiKeys: { ollama: { baseUrl: baseUrl.trim() } } })
        }
      }

      const test = await rpc()["settings.test"]({ target: "provider" })
      toast(test.message, test.ok ? "success" : "error")
    }

    async function runTests(): Promise<void> {
      for (const target of ["qdrant", "lancedb", "provider", "kilo"] as const) {
        try {
          const result = await rpc()["settings.test"]({ target })
          toast(`${target}: ${result.message}`, result.ok ? "success" : "error")
        } catch (error) {
          fail(error)
        }
      }
    }

    async function kiloMenu(): Promise<void> {
      let sources: Array<{ kind: string; name: string; pointsCount: number | null; compatible: boolean; profile: string | null }> = []
      let problems: string[] = []
      try {
        const found = await rpc()["kilo.discover"]({})
        sources = found.sources
        problems = found.problems ?? []
      } catch (error) {
        fail(error)
        return
      }
      if (sources.length === 0) {
        // "Found but unreadable" and "never indexed" look identical from here,
        // and only one of them is fixed by indexing. Say which one it is.
        toast(
          problems.length > 0
            ? `No importable Kilo index: ${problems.join(" · ")}`
            : "No Kilo index found for this workspace",
          problems.length > 0 ? "error" : "info",
        )
        return
      }
      const choice = await context.ui.dialog.select({
        title: "Kilo sources found (select to import)",
        options: [
          ...sources.map((source) => ({
            title: `${source.kind === "qdrant" ? "Qdrant" : "LanceDB"}: ${source.name}`,
            value: source.name,
            description: `${source.pointsCount ?? "?"} points · ${source.profile ?? "unknown profile"} · ${source.compatible ? "compatible" : "INCOMPATIBLE"}`,
          })),
          { title: "Back", value: "__back", description: "Return to settings" },
        ],
      })
      if (typeof choice !== "string" || choice === "__back") return

      const confirmed = await context.ui.dialog.confirm({
        title: "Import index",
        message: `Import "${choice}" into the own index? Vectors are copied without embedding cost.`,
        label: { confirm: "Import", cancel: "Cancel" },
      })
      if (!confirmed) return
      toast("Importing…", "info")
      try {
        const result = await rpc()["index.import"]({ source: choice })
        reportRun(result)
      } catch (error) {
        fail(error)
      }
    }

    async function indexMenu(settings: SettingsView): Promise<void> {
      const action = await context.ui.dialog.select({
        title: "Index actions",
        options: [
          {
            title: "Build (import from Kilo when available)",
            value: "build",
            description: settings.importFromKilo ? "Uses Kilo's index when compatible (no API cost)" : "Import toggle is OFF: embeds from scratch",
          },
          { title: "Build from scratch (skip import)", value: "build-scratch", description: "Embeds every file with the configured model" },
          { title: "Rebuild (drop + build)", value: "rebuild", description: "Deletes the own index first" },
          { title: "Refresh (incremental)", value: "refresh", description: "Only changed/new/deleted files" },
        ],
      })
      if (typeof action !== "string") return
      toast("Running…", "info")
      try {
        if (action === "refresh") {
          reportRun(await rpc()["index.refresh"]({}))
        } else if (action === "build") {
          reportRun(await rpc()["index.build"]({}))
        } else if (action === "build-scratch") {
          reportRun(await rpc()["index.build"]({ skipImport: true }))
        } else if (action === "rebuild") {
          const confirmed = await context.ui.dialog.confirm({
            title: "Rebuild index",
            message: "This deletes the own index and rebuilds it. Continue?",
            label: { confirm: "Rebuild", cancel: "Cancel" },
          })
          if (!confirmed) return
          reportRun(await rpc()["index.build"]({ rebuild: true }))
        }
      } catch (error) {
        fail(error)
      }
    }

    async function showStatus(): Promise<void> {
      try {
        const status = await rpc()["status.get"]({ checkFreshness: true })
        toast(status.summary, "info")
        if (status.recommendation) toast(status.recommendation, "info")
      } catch (error) {
        fail(error)
      }
    }

    /**
     * Selection state of the currently open settings page, or undefined when the
     * page is closed. The keymap layer below reads it to route keys.
     */
    let pageStore: SettingsPageStore | undefined

    /**
     * Where the user was when the page was opened, so escape hands them back
     * there instead of always dropping them on home.
     *
     * Captured before the page takes the route, and only while the page is not
     * already current: re-opening the page while it is up must not record the
     * page itself as the origin, or the session the user came from is lost.
     */
    let returnRoute: Route | undefined

    /**
     * Set while `openSettingsPage` is in flight.
     *
     * Two concurrent opens would interleave their `router.register` calls, and
     * `disposePage` could end up holding only the second disposer — leaving the
     * first registration live, which is exactly what makes later opens fall back
     * to the dialogs.
     */
    let opening = false

    /**
     * Unregisters the page from the host router.
     *
     * Held and called explicitly: a registration left live makes the next
     * `router.register` of the same name fail, so every later `/indexing` would
     * silently degrade to the dialog menu. Released on close and defensively
     * before re-registering.
     */
    let disposePage: (() => void) | undefined

    const releasePage = (): void => {
      const dispose = disposePage
      disposePage = undefined
      try {
        dispose?.()
      } catch (error) {
        console.warn(`[${ID}] could not unregister the settings page: ${describeError(error)}`)
      }
    }

    /**
     * True while the dialog editor is stacked on top of the page.
     *
     * The page navigation keys must go to the dialog while it is open: otherwise
     * the arrows move the selection *behind* the popup and escape tears down the
     * whole route. `mainMenu()` resolves when the dialog closes, so this is an
     * exact signal that does not depend on the host's input-mode naming.
     */
    let dialogOpen = false

    const onSettingsPage = (): boolean => {
      const route = context.ui.router?.current?.()
      return route?.type === "plugin" && route.name === SETTINGS_PAGE_NAME
    }

    /** Opens the dialog editor, holding the page keys off for its duration. */
    async function openEditor(): Promise<void> {
      dialogOpen = true
      try {
        await mainMenu()
      } finally {
        dialogOpen = false
      }
    }

    /**
     * Opens the rich JSX settings page, falling back to the dialog menu when
     * the page cannot be mounted (no router, or no JSX runtime on the host).
     */
    async function openSettingsPage(): Promise<void> {
      if (opening) return
      opening = true
      try {
        // Remember where the user was before the page takes the route: by the
        // time `mountSettingsPage` returns, the page is already current and the
        // origin would be gone. A re-open while the page is up must keep the
        // capture it already has.
        //
        // Snapshotted into a plain object on purpose: the host hands back a live
        // reference whose fields change with the route, so keeping it would let
        // the page overwrite the session under us — escape then read the page as
        // its own origin and fell back to home.
        if (!onSettingsPage()) {
          const current = context.ui.router?.current?.()
          returnRoute = current ? { ...current } : undefined
        }

        // Clear any registration left over from a previous open before asking the
        // host for another one with the same page name.
        releasePage()

        const store = new SettingsPageStore(PAGE_ROW_COUNT)
        pageStore = store
        const result = await mountSettingsPage({
          router: context.ui.router as unknown as RouterLike,
          load: async () => await import("./tui/settings-page.ts"),
          props: {
            rpc: () => rpc() as unknown as SettingsPageRpc,
            toast,
            store,
            onEdit: () => void openEditor(),
            theme: context.theme as unknown as ThemeLike,
          },
          fallback: mainMenu,
          onRegistered: (dispose) => {
            disposePage = dispose
          },
          onError: (error) =>
            console.warn(
              `[${ID}] settings page unavailable, using dialogs: ${describeError(error)}`,
            ),
        })
        if (result === "fallback") pageStore = undefined
      } finally {
        opening = false
      }
    }

    // Discovery layer: the slash commands and palette entries. `bind: false` keeps
    // them out of the keyboard entirely so they never shadow a host binding.
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "opencode.indexing.settings",
          title: "Indexing: settings",
          description: "Full settings page (vector store, embeddings, Kilo import)",
          group: "Indexing",
          palette: true,
          slash: { name: "indexing" },
          bind: false,
          enabled: () => true,
          run: () => openSettingsPage(),
        },
        {
          id: "opencode.indexing.dialogs",
          title: "Indexing: settings (dialogs)",
          description: "Same settings as modal dialogs, without the JSX page",
          group: "Indexing",
          palette: true,
          // No slash name: `/indexing` reaches the dialogs with `e`, and falls
          // back to them on its own. This stays in the palette as a manual escape
          // hatch if the page ever fails to render. It goes through `openEditor`
          // so the page keys are held off while the dialog is up — running
          // `mainMenu` directly would leave them live behind the popup.
          bind: false,
          enabled: () => true,
          run: () => void openEditor(),
        },
      ],
    }))

    /** True when the page owns the keyboard: it is the route and no dialog is stacked. */
    const pageKeysLive = (): boolean => onSettingsPage() && !dialogOpen
    // Navigation layer for the page itself. Deliberately NOT `mode: "global"`: the
    // host scopes this layer to the base input mode, so a stacked dialog takes the
    // keys away from it. `dialogOpen` is the explicit second gate for the same case.
    context.keymap.layer(() => ({
      priority: 20,
      commands: PAGE_KEYMAP.map((entry) => ({
        id: entry.id,
        title: entry.title,
        group: "Indexing",
        bind: entry.bind,
        enabled: () => pageKeysLive(),
        run: () => {
          // Re-checked here as well as in `enabled`: the dispatcher consults
          // `enabled`, but a programmatic dispatch would otherwise drive the page
          // from behind an open dialog.
          if (!pageKeysLive()) return
          if (entry.command === "edit") {
            void openEditor()
            return
          }
          if (entry.command === "close") {
            pageStore = undefined
            // Consume the origin: the next open captures its own, and a stale one
            // would send a later close somewhere the user never came from.
            const origin = returnRoute
            returnRoute = undefined
            // The session can be gone by now — closed while the page was open —
            // and navigating to it would land on a route with nothing behind it,
            // so a dead session falls back to home like every other origin.
            const back =
              origin?.type === "session" && context.data?.session?.get?.(origin.sessionID)
                ? { type: "session" as const, sessionID: origin.sessionID }
                : { type: "home" as const }
            // Navigate first, unregister after: unregistering the page while it is
            // still the current route risks the host rendering a route that has no
            // page behind it.
            context.ui.router.navigate(back)
            releasePage()
            return
          }
          pageStore?.dispatch(entry.command)
        },
      })),
    }))

    // -------------------------------------------------------------------------
    // Prompt-footer indicator
    // -------------------------------------------------------------------------

    /**
     * Source of truth for the footer state.
     *
     * A plain variable, not the handle: the palette command runs the same action
     * as the indicator and must work on hosts where the JSX footer never loaded.
     * The handle below is only the view, and mirrors this value.
     */
    let current: FooterState = { state: "loading", points: null }
    /** Directory `current` describes: the slot render fetches again only on change. */
    let requested: string | undefined
    let footerHandle: FooterHandle | undefined

    const currentFooter = (): FooterState => current

    const setFooter = (next: FooterState): void => {
      current = next
      footerHandle?.update(next)
    }

    const refreshFooter = async (): Promise<void> => {
      const directory = workspace()
      // Recorded before awaiting, so an answer that arrives after the user moved
      // on is discarded instead of clobbering the newer workspace.
      requested = directory
      try {
        // Repaint before the round trip: a workspace switch must not leave the
        // previous directory's state on screen while the new one is read.
        setFooter({ state: "loading", points: null })
        const next = await readFooterState(directory)
        if (requested === directory) setFooter(next)
      } catch {
        if (requested === directory) setFooter({ state: "error", points: null })
      }
    }

    const readFooterState = async (directory: string | undefined): Promise<FooterState> => {
      const [status, settings] = await Promise.all([
        rpc()["status.get"]({ checkFreshness: false, directory }),
        rpc()["settings.get"]({}),
      ])
      return {
        state: footerState({
          enabled: settings.settings.enabled !== false,
          ownPoints: status.ownPoints ?? null,
          ownComplete: status.ownComplete ?? null,
          hasKilo: status.kiloCollection !== null,
          ownStoreReachable: status.ownStoreReachable,
        }),
        points: status.ownPoints ?? null,
      }
    }

    /**
     * What a click on the indicator does: start indexing, pause it, resume it, or
     * just re-read the status. Long operations are not awaited before repainting:
     * the footer flips to the in-progress state immediately and settles later.
     */
    const activateFooter = async (): Promise<void> => {
      // While a run is in flight the state is "working", whose action is
      // "restatus", so a second selection cannot start a concurrent run.
      // Snapshot it: `setFooter` below reassigns `current`, and the branch that
      // decides between refresh and build must see the state we started from.
      const from = currentFooter()
      const action = footerAction(from.state)
      try {
        if (action === "restatus") {
          await refreshFooter()
          return
        }
        if (action === "pause") {
          await patchSettings({ enabled: false })
          setFooter({ state: "paused", points: from.points })
          toast("Indexing paused", "success")
          return
        }
        if (action === "resume") {
          await patchSettings({ enabled: true })
          setFooter({ state: "stale", points: from.points })
          toast("Indexing resumed", "success")
          return
        }
        // start: make sure nothing is blocking writes, then index.
        const settings = await loadSettings()
        if (settings.enabled === false) await patchSettings({ enabled: true })
        // Say something before awaiting: a build or refresh takes minutes, and
        // without this the command looks like it did nothing at all.
        setFooter({ state: "working", points: from.points })
        toast("Indexing started…", "info")
        const summary =
          from.state === "stale"
            ? await rpc()["index.refresh"]({})
            : await rpc()["index.build"]({ skipImport: false })
        // A failed run comes back as data, not as a rejection: the reason is far
        // more useful than "something went wrong", and it is already readable.
        reportRun(summary)
      } catch (error) {
        fail(error)
      } finally {
        await refreshFooter()
      }
    }

    // The footer content is JSX, so the module is awaited before the slot is
    // registered. A host without a JSX runtime simply gets no indicator; the rest
    // of the plugin, including the page and the dialogs, is unaffected.
    const footerModule = await import("./tui/footer-view.ts").catch((error: unknown) => {
      console.warn(`[${ID}] footer indicator unavailable: ${describeError(error)}`)
      return undefined
    })

    if (footerModule) {
      footerHandle = footerModule.createFooterIndicator(
        { state: "loading", points: null },
        pagePalette(context.theme as unknown as ThemeLike),
      )
    }

    if (typeof context.ui.slot === "function") {
      // Registered exactly once, for the life of the plugin. Re-registering per
      // state change added a second claim to the host and the indicator rendered
      // twice. The render reads the signal (repaints on state change) and the
      // active tab (repaints on tab change); the fetch is deferred because
      // re-entering the slot from inside its own running computation is not safe.
      context.ui.slot({
        append: "prompt.footer",
        render: () => {
          if (workspace() !== requested) queueMicrotask(() => void refreshFooter())
          return footerHandle?.render() ?? null
        },
      })
    }

    // Read the status even when there is no indicator to show: the palette command
    // runs the same action as a click, and it must work on hosts without JSX.
    await refreshFooter()

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "opencode.indexing.toggle",
          title: "Indexing: start, pause or resume indexing",
          description: "Start, pause or resume indexing; search keeps working while paused",
          group: "Indexing",
          palette: true,
          // No default binding: the id is stable, so a key can be assigned in cli.json
          // if the user wants one that works outside the settings page.
          bind: false,
          enabled: () => true,
          run: () => void activateFooter(),
        },
      ],
    }))
  },
} satisfies Plugin.Definition

export default plugin
