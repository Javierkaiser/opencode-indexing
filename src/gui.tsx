/**
 * OpenCode Desktop GUI for this plugin: the `./gui-experimental` bundle.
 *
 * It contributes a Settings page, two palette commands and a composer pill, and
 * only reads and triggers the server part through the RPC contract in
 * `src/rpc.ts`. The index itself is never touched from this process.
 */

import {
  Command,
  ComposerPill,
  createKeyed,
  Plugin,
  SettingsPage,
  type Context,
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

/** The RPC methods this GUI calls, typed as the server answers them. */
interface IndexingClient {
  readonly "settings.get": (input: Record<string, never>) => Promise<{ settings: SettingsView; version?: string }>
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

const PAGE_STYLE: JSX.CSSProperties = { display: "grid", gap: "16px", "max-width": "720px" }
const SECTION_STYLE: JSX.CSSProperties = {
  display: "grid",
  gap: "6px",
  padding: "14px 16px",
  border: "1px solid rgba(127, 127, 127, 0.25)",
  "border-radius": "10px",
}
const ROW_STYLE: JSX.CSSProperties = { display: "flex", gap: "16px", "justify-content": "space-between" }
const BUTTON_STYLE: JSX.CSSProperties = {
  padding: "6px 12px",
  border: "1px solid rgba(127, 127, 127, 0.35)",
  "border-radius": "6px",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
}

function Row(props: { readonly label: string; readonly value: string }) {
  return (
    <div style={ROW_STYLE}>
      <span style={{ opacity: 0.65 }}>{props.label}</span>
      <span style={{ "text-align": "right", "overflow-wrap": "anywhere" }}>{props.value}</span>
    </div>
  )
}

function Section(props: { readonly title: string; readonly children: JSX.Element }) {
  return (
    <section style={SECTION_STYLE}>
      <h3 style={{ margin: "0 0 4px", "font-size": "13px", "font-weight": "600" }}>{props.title}</h3>
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

/** The Settings > Indexing page: effective configuration and index state. */
function IndexingSettings(props: { readonly ctx: Context }) {
  const ctx = props.ctx

  const [data, { refetch }] = createResource<SettingsPageResult>(async () => {
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

  return (
    <div style={PAGE_STYLE}>
      <Show
        when={data()}
        fallback={<p style={{ margin: "0", opacity: 0.7 }}>{ctx.t("settings.loading")}</p>}
      >
        {(loaded) => {
          const result = loaded()
          if ("error" in result) {
            return (
              <div style={{ display: "grid", gap: "8px", "justify-items": "start" }}>
                <p style={{ margin: "0" }}>{ctx.t("settings.failed")}</p>
                <p style={{ margin: "0", opacity: 0.7 }}>{result.error}</p>
                <button type="button" style={BUTTON_STYLE} onClick={() => void refetch()}>
                  {ctx.t("settings.reload")}
                </button>
              </div>
            )
          }

          const settings = () => result.config.settings
          const index = () => result.index
          const state = () => stateOf(settings(), index())

          return (
            <>
              <Section title={ctx.t("settings.status")}>
                <Row label={ctx.t("settings.state")} value={ctx.t(`state.${state()}`)} />
                <Row label={ctx.t("settings.points")} value={pointsText(index().ownPoints)} />
                <Row label={ctx.t("settings.workspace")} value={text(index().workspace)} />
                <Row label={ctx.t("settings.recommendation")} value={index().recommendation} />
              </Section>

              <Section title={ctx.t("settings.configuration")}>
                <Row label={ctx.t("settings.store")} value={settings().vectorStore} />
                <Row
                  label={ctx.t("settings.location")}
                  value={settings().vectorStore === "qdrant" ? settings().qdrantUrl : settings().lancedbDirectory}
                />
                <Row label={ctx.t("settings.provider")} value={settings().provider} />
                <Row label={ctx.t("settings.model")} value={settings().model} />
                <Row label={ctx.t("settings.dimension")} value={String(settings().dimension)} />
                <Row
                  label={ctx.t("settings.enabled")}
                  value={settings().enabled !== false ? ctx.t("common.yes") : ctx.t("common.no")}
                />
                <Row
                  label={ctx.t("settings.importFromKilo")}
                  value={settings().importFromKilo ? ctx.t("common.yes") : ctx.t("common.no")}
                />
                <Row
                  label={ctx.t("settings.autoRefresh")}
                  value={settings().autoRefresh ? ctx.t("common.yes") : ctx.t("common.no")}
                />
                <Row label={ctx.t("settings.searchMaxResults")} value={String(settings().searchMaxResults)} />
                <Row
                  label={ctx.t("settings.providers")}
                  value={settings().configuredProviders.join(", ") || ctx.t("settings.none")}
                />
                <Row label={ctx.t("settings.file")} value={settings().settingsFile} />
                <Row label={ctx.t("settings.version")} value={text(result.config.version)} />
              </Section>

              <div style={{ display: "flex", gap: "8px" }}>
                <button type="button" style={BUTTON_STYLE} onClick={() => void ctx.commands.run(`${ctx.id}.build`)}>
                  {ctx.t("settings.build")}
                </button>
                <button type="button" style={BUTTON_STYLE} onClick={() => void ctx.commands.run(`${ctx.id}.refresh`)}>
                  {ctx.t("settings.refresh")}
                </button>
                <button type="button" style={BUTTON_STYLE} onClick={() => void refetch()}>
                  {ctx.t("settings.reload")}
                </button>
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
      "settings.build": "Build",
      "settings.refresh": "Refresh",
      "settings.reload": "Reload",
      "settings.none": "none",
      "common.yes": "Yes",
      "common.no": "No",
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

    const runIndex =
      (method: "index.build" | "index.refresh") =>
      async (): Promise<void> => {
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
          const directory = ctx.sessions.current()?.directory
          if (directory) void refresh(directory)
        } catch (error) {
          pending.dismiss()
          ctx.toast.show({ variant: "error", title: ctx.t("toast.failed"), description: describeError(error) })
        }
      }

    ctx.add(
      Command,
      (): Command => ({
        id: "build",
        title: ctx.t("command.build"),
        group: ctx.t("command.group"),
        keywords: "index embedding build rebuild",
        run: runIndex("index.build"),
      }),
    )

    ctx.add(
      Command,
      (): Command => ({
        id: "refresh",
        title: ctx.t("command.refresh"),
        group: ctx.t("command.group"),
        keywords: "index embedding refresh update",
        run: runIndex("index.refresh"),
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
