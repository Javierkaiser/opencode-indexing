/**
 * OpenCode Desktop GUI for this plugin: the `./gui-experimental` bundle.
 *
 * It contributes a Settings page, two palette commands and a composer pill, and
 * only reads and triggers the server part through the RPC contract in
 * `src/rpc.ts`. The index itself is never touched from this process.
 *
 * The page is built from the host's own components (`ctx.ui`): its buttons,
 * switches, loader and icons. A settings page that draws its own controls reads
 * as a different app; the SDK does not expose theme tokens, so the layout is
 * ours but every interactive piece is the host's.
 */

import {
  Command,
  ComposerPill,
  createKeyed,
  Plugin,
  SettingsPage,
  type Context,
  type IconName,
} from "@opencode/plugin/gui"
import { Show, createResource, createSignal, type JSX } from "solid-js"

import { describeError } from "./errors.ts"
import { formatPoints, indexState, type IndexingState } from "./index-state.ts"
import { IndexingRpc } from "./rpc.ts"

/** The `settings.get` fields this GUI reads. */
interface SettingsView {
  readonly vectorStore: string
  readonly qdrantUrl: string
  readonly lancedbDirectory: string
  readonly provider: string
  readonly model: string
  readonly dimension: number
  readonly importFromKilo: boolean
  readonly autoRefresh: boolean
  readonly enabled: boolean
  readonly searchMaxResults: number
  readonly configuredProviders: string[]
  readonly settingsFile: string
}

/** The `status.get` fields this GUI reads. */
interface StatusView {
  readonly recommendation: string
  readonly ownPoints?: number | null
  readonly ownComplete?: boolean | null
  readonly kiloCollection?: string | null
  readonly workspace?: string
  readonly ownStoreReachable?: boolean
}

interface IndexResult {
  readonly summary: string
  readonly error?: string
}

/** The booleans this page can change. Everything else stays read-only. */
type ToggleKey = "enabled" | "autoRefresh" | "importFromKilo"

/** The RPC methods this GUI calls, typed as the server answers them. */
interface IndexingClient {
  readonly "settings.get": (input: Record<string, never>) => Promise<{ settings: SettingsView; version?: string }>
  readonly "settings.set": (input: { patch: Record<string, unknown> }) => Promise<{ settings: SettingsView }>
  readonly "status.get": (input: { checkFreshness?: boolean; directory?: string }) => Promise<StatusView>
  readonly "index.build": (input: { rebuild?: boolean; skipImport?: boolean; directory?: string }) => Promise<IndexResult>
  readonly "index.refresh": (input: { maxFiles?: number; directory?: string }) => Promise<IndexResult>
}

/**
 * The RPC client with the server's field names.
 *
 * `IndexingRpc` declares portable JSON schemas, so the SDK types every payload
 * as `unknown`. This is the one place the GUI names what it reads, like the TUI
 * does with its own client slice.
 */
const client = (ctx: Context): IndexingClient => ctx.client.rpc(IndexingRpc) as unknown as IndexingClient

const NO_VALUE = "—"

const text = (value: string | number | null | undefined): string =>
  value === null || value === undefined || value === "" ? NO_VALUE : String(value)

const pointsText = (points: number | null | undefined): string =>
  points === null || points === undefined ? NO_VALUE : formatPoints(points)

/** Maps the two RPC payloads to the state vocabulary shared with the TUI. */
const stateOf = (settings: SettingsView, status: StatusView): IndexingState =>
  indexState({
    enabled: settings.enabled !== false,
    ownPoints: status.ownPoints ?? null,
    ownComplete: status.ownComplete ?? null,
    hasKilo: status.kiloCollection != null,
    ownStoreReachable: status.ownStoreReachable,
  })

/** The host icon that names a state, so the vocabulary is not text-only. */
const stateIcon = (state: IndexingState): IconName => {
  switch (state) {
    case "ready":
      return "circle-check"
    case "stale":
    case "working":
    case "loading":
      return "refresh"
    case "paused":
      return "dash"
    case "empty":
      return "circle-exclamation"
    case "unavailable":
    case "error":
      return "circle-x"
  }
}

/*
 * Layout.
 *
 * The border colour is mixed from `currentColor` rather than hardcoded: the GUI
 * SDK exposes no theme tokens, and a fixed grey is wrong in one of the two
 * themes. `color-mix` follows whatever text colour the host sets.
 */
const BORDER = "1px solid color-mix(in srgb, currentColor 14%, transparent)"
const ROW_BORDER = `1px solid color-mix(in srgb, currentColor 10%, transparent)`

const PAGE_STYLE: JSX.CSSProperties = { display: "grid", gap: "20px", "max-width": "760px", width: "100%" }
const HEADER_STYLE: JSX.CSSProperties = { display: "grid", gap: "4px" }
const TITLE_STYLE: JSX.CSSProperties = { margin: "0", "font-size": "18px", "font-weight": "600" }
const SUBTITLE_STYLE: JSX.CSSProperties = { margin: "0", "font-size": "13px", opacity: 0.6 }
const CARD_STYLE: JSX.CSSProperties = {
  border: BORDER,
  "border-radius": "8px",
  overflow: "hidden",
}
const CARD_TITLE_STYLE: JSX.CSSProperties = {
  margin: "0",
  padding: "13px 16px",
  "font-size": "13px",
  "font-weight": "600",
  "border-bottom": BORDER,
}
const ROW_STYLE: JSX.CSSProperties = {
  display: "flex",
  gap: "16px",
  "align-items": "center",
  "justify-content": "space-between",
  padding: "11px 16px",
}
const LABEL_STYLE: JSX.CSSProperties = { "font-size": "13px", opacity: 0.7 }
const VALUE_STYLE: JSX.CSSProperties = { "font-size": "13px", "text-align": "right", "overflow-wrap": "anywhere" }
const BUTTONS_STYLE: JSX.CSSProperties = { display: "flex", gap: "8px", "align-items": "center" }

/** One row of a card: label on the left, value or control on the right. */
function Row(props: {
  readonly label: string
  readonly value?: string
  readonly first?: boolean
  readonly children?: JSX.Element
}) {
  return (
    <div style={props.first ? ROW_STYLE : { ...ROW_STYLE, "border-top": ROW_BORDER }}>
      <span style={LABEL_STYLE}>{props.label}</span>
      {props.children ?? <span style={VALUE_STYLE}>{props.value}</span>}
    </div>
  )
}

/** A card with the host's section header and separated rows. */
function Card(props: { readonly title: string; readonly children: JSX.Element }) {
  return (
    <section style={CARD_STYLE}>
      <h2 style={CARD_TITLE_STYLE}>{props.title}</h2>
      {props.children}
    </section>
  )
}

/** What the page renders once the two reads settle: data, or a reason. */
type SettingsPageResult =
  | {
      config: { settings: SettingsView; version?: string }
      index: StatusView
    }
  | { error: string }

/**
 * Runs an index action and reports the outcome in a toast.
 *
 * Shared by the palette commands and the page buttons so the two cannot
 * disagree about what a build says. It does not refresh the pill: the caller
 * owns that because only `setup` knows the current session.
 */
async function runIndexAction(ctx: Context, method: "index.build" | "index.refresh"): Promise<void> {
  const pending = ctx.toast.show({
    variant: "loading",
    title: ctx.t(method === "index.build" ? "toast.building" : "toast.refreshing"),
    persistent: true,
  })

  try {
    const result = await client(ctx)[method]({})
    pending.dismiss()
    if (result.error) {
      ctx.toast.show({ variant: "error", title: result.summary, description: result.error })
    } else {
      ctx.toast.show({ variant: "success", title: ctx.t("toast.done"), description: result.summary })
    }
  } catch (error) {
    pending.dismiss()
    ctx.toast.show({ variant: "error", title: ctx.t("toast.failed"), description: describeError(error) })
  }
}

/** The Settings > Indexing page: effective configuration and index state. */
function IndexingSettings(props: { readonly ctx: Context }) {
  const ctx = props.ctx
  const [saving, setSaving] = createSignal<ToggleKey>()
  const [running, setRunning] = createSignal<"build" | "refresh">()

  const [data, { refetch, mutate }] = createResource<SettingsPageResult>(async () => {
    const api = client(ctx)
    // Settings has no session of its own, so this is usually undefined and the
    // server falls back to its own directory. That is only safe because the
    // read is cheap: asking for a freshness scan walks the workspace, and a
    // service running from a home directory would walk the whole machine until
    // the RPC transport timed out - which is exactly what left this page blank.
    const directory = ctx.sessions.current()?.directory
    try {
      const [config, index] = await Promise.all([
        api["settings.get"]({}),
        api["status.get"]({ checkFreshness: false, directory }),
      ])
      return { config, index }
    } catch (error) {
      // Resolve with the reason instead of rejecting. A rejected resource
      // leaves the page with nothing to render, and a blank page hid this bug
      // once already.
      return { error: describeError(error) }
    }
  })

  /** Persists one boolean and adopts the server's answer, never the request. */
  const saveToggle = async (key: ToggleKey, checked: boolean): Promise<void> => {
    setSaving(key)
    try {
      const response = await client(ctx)["settings.set"]({ patch: { [key]: checked } })
      mutate((current) => {
        if (!current || "error" in current) return current
        return { ...current, config: { ...current.config, settings: response.settings } }
      })
    } catch (error) {
      ctx.toast.show({ variant: "error", title: ctx.t("settings.saveFailed"), description: describeError(error) })
    } finally {
      setSaving(undefined)
    }
  }

  const runFromPage = async (method: "index.build" | "index.refresh", key: "build" | "refresh"): Promise<void> => {
    setRunning(key)
    try {
      await runIndexAction(ctx, method)
      await refetch()
    } finally {
      setRunning(undefined)
    }
  }

  return (
    <div style={PAGE_STYLE}>
      <header style={HEADER_STYLE}>
        <h1 style={TITLE_STYLE}>{ctx.t("settings.title")}</h1>
        <p style={SUBTITLE_STYLE}>{ctx.t("settings.subtitle")}</p>
      </header>

      <Show
        when={data()}
        fallback={
          <div style={{ display: "flex", gap: "8px", "align-items": "center", "font-size": "13px", opacity: 0.7 }}>
            <ctx.ui.Loader size="small" />
            <span>{ctx.t("settings.loading")}</span>
          </div>
        }
      >
        {(loaded) => {
          const result = loaded()
          if ("error" in result) {
            return (
              <Card title={ctx.t("settings.status")}>
                <div style={{ display: "grid", gap: "10px", padding: "14px 16px", "justify-items": "start" }}>
                  <p style={{ margin: "0", "font-size": "13px" }}>{ctx.t("settings.failed")}</p>
                  <p style={{ margin: "0", "font-size": "13px", opacity: 0.7 }}>{result.error}</p>
                  <ctx.ui.Button
                    variant="neutral"
                    size="small"
                    icon="outline-rotate-clockwise"
                    onClick={() => void refetch()}
                  >
                    {ctx.t("settings.reload")}
                  </ctx.ui.Button>
                </div>
              </Card>
            )
          }

          const settings = () => result.config.settings
          const index = () => result.index
          const state = () => stateOf(settings(), index())

          return (
            <>
              <Card title={ctx.t("settings.status")}>
                <Row label={ctx.t("settings.state")} first>
                  <span style={{ display: "inline-flex", gap: "6px", "align-items": "center", "font-size": "13px" }}>
                    <ctx.ui.Icon name={stateIcon(state())} size="small" />
                    {ctx.t(`state.${state()}`)}
                  </span>
                </Row>
                <Row label={ctx.t("settings.points")} value={pointsText(index().ownPoints)} />
                <Row label={ctx.t("settings.workspace")} value={text(index().workspace)} />
                <Row label={ctx.t("settings.recommendation")} value={index().recommendation} />
              </Card>

              <Card title={ctx.t("settings.configuration")}>
                <Row label={ctx.t("settings.store")} value={settings().vectorStore} first />
                <Row
                  label={ctx.t("settings.location")}
                  value={settings().vectorStore === "qdrant" ? settings().qdrantUrl : settings().lancedbDirectory}
                />
                <Row label={ctx.t("settings.provider")} value={settings().provider} />
                <Row label={ctx.t("settings.model")} value={settings().model} />
                <Row label={ctx.t("settings.dimension")} value={String(settings().dimension)} />

                <Row label={ctx.t("settings.enabled")}>
                  <ctx.ui.Switch
                    label={ctx.t("settings.enabled")}
                    hideLabel
                    checked={settings().enabled !== false}
                    disabled={saving() === "enabled"}
                    onChange={(checked) => void saveToggle("enabled", checked)}
                  />
                </Row>
                <Row label={ctx.t("settings.importFromKilo")}>
                  <ctx.ui.Switch
                    label={ctx.t("settings.importFromKilo")}
                    hideLabel
                    checked={settings().importFromKilo}
                    disabled={saving() === "importFromKilo"}
                    onChange={(checked) => void saveToggle("importFromKilo", checked)}
                  />
                </Row>
                <Row label={ctx.t("settings.autoRefresh")}>
                  <ctx.ui.Switch
                    label={ctx.t("settings.autoRefresh")}
                    hideLabel
                    checked={settings().autoRefresh}
                    disabled={saving() === "autoRefresh"}
                    onChange={(checked) => void saveToggle("autoRefresh", checked)}
                  />
                </Row>

                <Row label={ctx.t("settings.searchMaxResults")} value={String(settings().searchMaxResults)} />
                <Row
                  label={ctx.t("settings.providers")}
                  value={settings().configuredProviders.join(", ") || ctx.t("settings.none")}
                />
                <Row label={ctx.t("settings.file")} value={settings().settingsFile} />
                <Row label={ctx.t("settings.version")} value={text(result.config.version)} />
              </Card>

              <div style={BUTTONS_STYLE}>
                <ctx.ui.Button
                  variant="contrast"
                  icon="check"
                  busy={running() === "build"}
                  onClick={() => void runFromPage("index.build", "build")}
                >
                  {ctx.t("settings.build")}
                </ctx.ui.Button>
                <ctx.ui.Button
                  variant="neutral"
                  icon="refresh"
                  busy={running() === "refresh"}
                  onClick={() => void runFromPage("index.refresh", "refresh")}
                >
                  {ctx.t("settings.refresh")}
                </ctx.ui.Button>
                <ctx.ui.Tooltip value={ctx.t("settings.reload")}>
                  <ctx.ui.IconButton
                    icon="outline-rotate-clockwise"
                    label={ctx.t("settings.reload")}
                    onClick={() => void refetch()}
                  />
                </ctx.ui.Tooltip>
              </div>
            </>
          )
        }}
      </Show>
    </div>
  )
}

/** The composer pill for one state, or `undefined` to show nothing. */
const pillView = (ctx: Context, state: IndexingState, points: number | null | undefined) => {
  const title = ctx.t("pill.title")
  const count = `${pointsText(points)} ${ctx.t("unit.points")}`

  switch (state) {
    case "ready":
      return { icon: "circle-check", tone: "success", label: count, title } as const
    case "stale":
      return { icon: "refresh", tone: "warning", label: `${count} · ${ctx.t("pill.stale")}`, title } as const
    case "paused":
      return { icon: "dash", label: ctx.t("state.paused"), title } as const
    case "empty":
      return { icon: "circle-exclamation", tone: "warning", label: ctx.t("state.empty"), title } as const
    case "working":
      return { icon: "refresh", label: ctx.t("state.working"), title } as const
    case "loading":
      return { icon: "refresh", label: ctx.t("state.loading"), title } as const
    case "unavailable":
      return { icon: "circle-x", tone: "danger", label: ctx.t("state.unavailable"), title } as const
    case "error":
      return { icon: "circle-x", tone: "danger", label: ctx.t("state.error"), title } as const
  }
}

export default Plugin.define({
  i18n: {
    en: {
      "command.group": "Indexing",
      "command.build": "Build the search index",
      "command.refresh": "Refresh the search index",
      "settings.title": "Indexing",
      "settings.subtitle": "Semantic code search for this workspace.",
      "settings.status": "Index status",
      "settings.state": "State",
      "settings.points": "Points",
      "settings.workspace": "Workspace",
      "settings.recommendation": "Next step",
      "settings.configuration": "Configuration",
      "settings.store": "Vector store",
      "settings.location": "Location",
      "settings.provider": "Embedding provider",
      "settings.model": "Embedding model",
      "settings.dimension": "Dimensions",
      "settings.enabled": "Indexing enabled",
      "settings.importFromKilo": "Import from Kilo",
      "settings.autoRefresh": "Auto refresh",
      "settings.searchMaxResults": "Search results",
      "settings.providers": "Configured providers",
      "settings.file": "Settings file",
      "settings.version": "Plugin version",
      "settings.loading": "Reading index status…",
      "settings.failed": "Could not read the index status.",
      "settings.saveFailed": "Could not save the setting",
      "settings.build": "Build",
      "settings.refresh": "Refresh",
      "settings.reload": "Reload",
      "settings.none": "none",
      "state.loading": "reading…",
      "state.working": "indexing…",
      "state.paused": "paused",
      "state.ready": "indexed",
      "state.stale": "index stale",
      "state.empty": "not built",
      "state.unavailable": "no index",
      "state.error": "index error",
      "pill.title": "Index status",
      "pill.stale": "stale",
      "unit.points": "points",
      "toast.building": "Building the index…",
      "toast.refreshing": "Refreshing the index…",
      "toast.done": "Index updated",
      "toast.failed": "Indexing failed",
    },
  },
  setup(ctx) {
    const [loaded, setLoaded] = createSignal<{ directory: string; settings: SettingsView; status: StatusView }>()

    const refresh = async (directory: string): Promise<void> => {
      try {
        const api = client(ctx)
        const [status, config] = await Promise.all([
          api["status.get"]({ checkFreshness: false, directory }),
          api["settings.get"]({}),
        ])
        setLoaded({ directory, settings: config.settings, status })
      } catch {
        // An unreachable server is not "no index": hide the pill instead.
        setLoaded(undefined)
      }
    }

    createKeyed(
      () => ctx.sessions.current()?.directory,
      (directory) => void refresh(directory),
    )

    const refreshPill = (): void => {
      const directory = ctx.sessions.current()?.directory
      if (directory) void refresh(directory)
    }

    ctx.add(
      Command,
      (): Command => ({
        id: "build",
        title: ctx.t("command.build"),
        group: ctx.t("command.group"),
        keywords: "index embedding build rebuild",
        run: () => runIndexAction(ctx, "index.build").then(refreshPill),
      }),
    )

    ctx.add(
      Command,
      (): Command => ({
        id: "refresh",
        title: ctx.t("command.refresh"),
        group: ctx.t("command.group"),
        keywords: "index embedding refresh update",
        run: () => runIndexAction(ctx, "index.refresh").then(refreshPill),
      }),
    )

    ctx.add(SettingsPage, {
      id: "indexing",
      icon: "cube",
      get title() {
        return ctx.t("settings.title")
      },
      render: () => <IndexingSettings ctx={ctx} />,
    })

    ctx.add(
      ComposerPill,
      (): ComposerPill => ({
        id: "status",
        show: (input) => {
          const current = loaded()
          // Only the routed session is fetched; a stale snapshot for another
          // directory would report that workspace's points here.
          if (!current || current.directory !== input.session.directory) return undefined
          return pillView(ctx, stateOf(current.settings, current.status), current.status.ownPoints)
        },
      }),
    )
  },
})
