/**
 * opencode-indexing — CLI/TUI plugin.
 *
 * Two settings surfaces, both driven by the server plugin's RPC so
 * configuration stays in one place (`~/.config/opencode/indexing.json`):
 *
 *  1. `/indexing` → the JSX settings page (`tui/settings-page.tsx`), loaded
 *     lazily. If the host cannot resolve the JSX runtime, it degrades to:
 *  2. the same options as modal dialogs, dialogs-only and dependency-free, so
 *     the plugin still works on any host build. Reached with `e` from the page,
 *     automatically as the fallback, and from the palette ("Indexing: settings
 *     (dialogs)") as a manual escape hatch.
 *
 * Only TYPE imports from @opencode/plugin are used at build time; the runtime
 * resolves the real package (documented layout: `tui.ts` beside `index.ts`).
 */
import type { Plugin } from "@opencode/plugin/tui"

import { IndexingRpc } from "./src/rpc.ts"
import { SETTINGS_PAGE_NAME, mountSettingsPage, type RouterLike } from "./tui/page-mount.ts"
import { PAGE_KEYMAP, SettingsPageStore } from "./tui/page-store.ts"
import type { ThemeLike } from "./tui/page-style.ts"
import { PAGE_ACTIONS, PAGE_ROWS, type SettingsPageRpc } from "./tui/settings-page-data.ts"
import { footerAction, footerState } from "./tui/footer.ts"
import { pagePalette } from "./tui/page-style.ts"
import type { FooterHandle, FooterState } from "./tui/footer-view.tsx"

/**
 * Navigable rows on the page.
 *
 * Derived from `PAGE_ROWS`, the same list the view renders: recomputing
 * `actions + 2` here would silently drift the store size from the rendered rows
 * and make the last row unreachable.
 */
const PAGE_ROW_COUNT = PAGE_ROWS.length

const ID = "opencode.indexing"

type RpcClient = {
  "settings.get": (input: Record<string, never>) => Promise<{ settings: SettingsView }>
  "settings.set": (input: { patch: Record<string, unknown> }) => Promise<{ settings: SettingsView }>
  "settings.test": (input: { target: "qdrant" | "lancedb" | "provider" | "kilo" }) => Promise<{ ok: boolean; message: string }>
  "kilo.discover": () => Promise<{ sources: Array<{ kind: string; name: string; pointsCount: number | null; compatible: boolean; profile: string | null }> }>
  "status.get": (input: { checkFreshness?: boolean }) => Promise<{ summary: string; recommendation: string; ownKind: string; ownStore: string; ownPoints?: number | null; ownComplete?: boolean | null; kiloCollection?: string | null }>
  "index.build": (input: { rebuild?: boolean; skipImport?: boolean }) => Promise<{ summary: string }>
  "index.refresh": (input: { maxFiles?: number }) => Promise<{ summary: string }>
  "index.import": (input: { source?: string; rebuild?: boolean }) => Promise<{ summary: string }>
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
  hasMistralKey: boolean
  hasOpenAiKey: boolean
  settingsFile: string
}

const plugin = {
  id: ID,
  async setup(context: Plugin.Context): Promise<void> {
    // Resolve the RPC subclient lazily: the TUI may start before the server
    // plugin is ready, and calls are retried on first use.
    const rpc = (): RpcClient =>
      (context.client as unknown as { rpc: (def: unknown, options?: unknown) => RpcClient }).rpc(IndexingRpc)

    const toast = (message: string, variant: "success" | "error" | "info" = "info"): void => {
      context.ui.toast.show({ title: "Indexing", message, variant, duration: 5000 })
    }

    const fail = (error: unknown): void => {
      toast(error instanceof Error ? error.message : String(error), "error")
    }

    async function loadSettings(): Promise<SettingsView> {
      const response = await rpc()["settings.get"]({})
      return response.settings
    }

    async function patchSettings(patch: Record<string, unknown>): Promise<SettingsView> {
      const response = await rpc()["settings.set"]({ patch })
      return response.settings
    }

    async function mainMenu(): Promise<void> {
      let settings: SettingsView
      try {
        settings = await loadSettings()
      } catch (error) {
        fail(error)
        return
      }

      const choice = await context.ui.dialog.select({
        title: "Indexing settings",
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

      const model = await context.ui.dialog.prompt({
        title: `Model for ${provider} (leave empty for default)`,
        placeholder: provider === "mistral" ? "codestral-embed-2505" : "",
      })
      const patch: Record<string, unknown> = { provider }
      if (model && model.trim()) patch.model = model.trim()
      await patchSettings(patch)

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
        const current = provider === "mistral" && settings.hasMistralKey
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
      try {
        sources = (await rpc()["kilo.discover"]()).sources
      } catch (error) {
        fail(error)
        return
      }
      if (sources.length === 0) {
        toast("No Kilo index found for this workspace", "info")
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
        toast(result.summary, "success")
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
          const result = await rpc()["index.refresh"]({})
          toast(result.summary, "success")
        } else if (action === "build") {
          const result = await rpc()["index.build"]({})
          toast(result.summary, "success")
        } else if (action === "build-scratch") {
          const result = await rpc()["index.build"]({ skipImport: true })
          toast(result.summary, "success")
        } else if (action === "rebuild") {
          const confirmed = await context.ui.dialog.confirm({
            title: "Rebuild index",
            message: "This deletes the own index and rebuilds it. Continue?",
            label: { confirm: "Rebuild", cancel: "Cancel" },
          })
          if (!confirmed) return
          const result = await rpc()["index.build"]({ rebuild: true })
          toast(result.summary, "success")
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
        console.warn(`[${ID}] could not unregister the settings page: ${error instanceof Error ? error.message : String(error)}`)
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
        // Clear any registration left over from a previous open before asking the
        // host for another one with the same page name.
        releasePage()

        const store = new SettingsPageStore(PAGE_ROW_COUNT)
        pageStore = store
        const result = await mountSettingsPage({
          router: context.ui.router as unknown as RouterLike,
          load: async () => await import("./tui/settings-page.tsx"),
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
              `[${ID}] settings page unavailable, using dialogs: ${error instanceof Error ? error.message : String(error)}`,
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
            // Navigate first, unregister after: unregistering the page while it is
            // still the current route risks the host rendering a route that has no
            // page behind it.
            context.ui.router.navigate({ type: "home" })
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
     * Reads the index status the footer shows.
     *
     * Fetched on demand — on activation, after every action, and on demand from
     * a click — never per render: the footer repaints on every keystroke.
     */
    /**
     * Reads the index status the footer shows.
     *
     * Fetched on demand — on activation, after every action, and on demand from
     * a click — never per render: the footer repaints on every keystroke.
     */
    const palette = pagePalette(context.theme as unknown as ThemeLike)

    /**
     * Source of truth for the footer state.
     *
     * Deliberately a plain variable, not the reactive handle: the palette command
     * runs the same action as a click, and it must work on hosts where the JSX
     * footer never loaded. The handle is only the view.
     */
    let current: FooterState = { state: "loading", points: null }
    let footerHandle: FooterHandle | undefined

    const setFooter = (next: FooterState): void => {
      current = next
      footerHandle?.update(next)
    }

    const refreshFooter = async (): Promise<void> => {
      try {
        setFooter(await readFooterState())
      } catch {
        setFooter({ state: "error", points: null })
      }
    }

    const readFooterState = async (): Promise<FooterState> => {
      const [status, settings] = await Promise.all([
        rpc()["status.get"]({ checkFreshness: false }),
        rpc()["settings.get"]({}),
      ])
      return {
        state: footerState({
          enabled: settings.settings.enabled !== false,
          ownPoints: status.ownPoints ?? null,
          ownComplete: status.ownComplete ?? null,
          hasKilo: status.kiloCollection !== null,
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
      const action = footerAction(current.state)
      try {
        if (action === "restatus") {
          await refreshFooter()
          return
        }
        if (action === "pause") {
          await patchSettings({ enabled: false })
          setFooter({ state: "paused", points: current.points })
          toast("Indexing paused", "success")
          return
        }
        if (action === "resume") {
          await patchSettings({ enabled: true })
          setFooter({ state: "stale", points: current.points })
          toast("Indexing resumed", "success")
          return
        }
        // start: make sure nothing is blocking writes, then index.
        const settings = await loadSettings()
        if (settings.enabled === false) await patchSettings({ enabled: true })
        const summary =
          current.state === "stale"
            ? await rpc()["index.refresh"]({})
            : await rpc()["index.build"]({ skipImport: false })
        toast(summary.summary, "success")
      } catch (error) {
        fail(error)
      } finally {
        await refreshFooter()
      }
    }

    // The footer content is JSX, so the module is awaited before the slot is
    // registered. A host without a JSX runtime simply gets no indicator; the rest
    // of the plugin, including the page and the dialogs, is unaffected.
    const footerModule = await import("./tui/footer-view.tsx").catch((error: unknown) => {
      console.warn(`[${ID}] footer indicator unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    })

    if (footerModule) {
      const handle = footerModule.createFooterIndicator({ state: "loading", points: null }, palette, () =>
        void activateFooter(),
      )
      footerHandle = handle
      context.ui.slot({
        append: "prompt.footer",
        render: () => handle.render(),
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
          description: "Same action as clicking the footer indicator; search keeps working while paused",
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
