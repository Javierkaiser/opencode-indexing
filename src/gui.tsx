/**
 * OpenCode Desktop GUI for this plugin: the `./gui-experimental` bundle.
 *
 * It contributes a settings page, two palette commands and a composer pill, and
 * only reads and writes through the server part's RPC contract. The index itself
 * is never touched from this process.
 *
 * The page is built from the host's own components (`ctx.ui`) and its native
 * dialogs (`ctx.dialogs`): a settings page that draws its own controls reads as
 * a different app. The layout numbers come from the host's settings CSS; the
 * colours from its `--v2-*` theme variables.
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
  readonly vectorStore: "qdrant" | "lancedb"
  readonly qdrantUrl: string
  readonly qdrantApiKey: string
  readonly lancedbDirectory: string
  readonly provider: string
  readonly model: string
  readonly dimension: number
  readonly importFromKilo: boolean
  readonly searchKilo: boolean
  readonly autoRefresh: boolean
  readonly enabled: boolean
  readonly codegraph: boolean
  readonly searchMaxResults: number
  readonly searchMinScore: number | null
  readonly embeddingBatchSize: number
  readonly fileExtensions: string[]
  readonly configuredProviders: string[]
  readonly settingsFile: string
  readonly warnings: string[]
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

interface ModelView {
  readonly id: string
  readonly dimension: number | null
  readonly kiloMirrored: boolean
}

interface ProviderView {
  readonly id: string
  readonly defaultModel: string
  readonly liveTested: boolean
  readonly models: readonly ModelView[]
}

interface CatalogView {
  readonly providers: readonly ProviderView[]
}

interface WriteResult {
  readonly ok: boolean
  readonly error?: string
  readonly display?: string
  readonly settings?: SettingsView
}

interface IndexResult {
  readonly summary: string
  readonly error?: string
}

/** The RPC methods this GUI calls, typed as the server answers them. */
interface IndexingClient {
  readonly "settings.get": (input: Record<string, never>) => Promise<{ settings: SettingsView; version?: string }>
  readonly "settings.set": (input: { patch: Record<string, unknown> }) => Promise<{ settings: SettingsView; version?: string }>
  readonly "settings.apply": (input: { key: string; value: string }) => Promise<WriteResult>
  readonly "settings.credential": (input: { provider: string; value: string }) => Promise<WriteResult>
  readonly "settings.test": (input: { target: "qdrant" | "lancedb" | "provider" | "kilo"; directory?: string }) => Promise<{
    ok: boolean
    message: string
  }>
  readonly "catalog.get": (input: Record<string, never>) => Promise<CatalogView>
  readonly "status.get": (input: { checkFreshness?: boolean; directory?: string }) => Promise<StatusView>
  readonly "index.build": (input: { rebuild?: boolean; skipImport?: boolean; directory?: string }) => Promise<IndexResult>
  readonly "index.refresh": (input: { maxFiles?: number; directory?: string }) => Promise<IndexResult>
}

const client = (ctx: Context): IndexingClient => ctx.client.rpc(IndexingRpc) as unknown as IndexingClient

const NO_VALUE = "—"

const text = (value: string | number | null | undefined): string =>
  value === null || value === undefined || value === "" ? NO_VALUE : String(value)

const pointsText = (points: number | null | undefined): string =>
  points === null || points === undefined ? NO_VALUE : formatPoints(points)

const stateOf = (settings: SettingsView, status: StatusView): IndexingState =>
  indexState({
    enabled: settings.enabled !== false,
    ownPoints: status.ownPoints ?? null,
    ownComplete: status.ownComplete ?? null,
    hasKilo: status.kiloCollection != null,
    ownStoreReachable: status.ownStoreReachable,
  })

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

/* Layout, taken from the host's settings CSS and its theme variables. */
const PAGE_STYLE: JSX.CSSProperties = {
  display: "grid",
  gap: "32px",
  "max-width": "720px",
  width: "100%",
  "padding-top": "48px",
}
const HEADER_STYLE: JSX.CSSProperties = { display: "grid", gap: "8px" }
const TITLE_STYLE: JSX.CSSProperties = {
  margin: "0",
  "font-size": "15px",
  "font-weight": "640",
  "line-height": "var(--line-height-base, 1.5)",
  color: "var(--v2-text-text-base, inherit)",
}
const SUBTITLE_STYLE: JSX.CSSProperties = {
  margin: "0",
  "font-size": "13px",
  "font-weight": "440",
  "line-height": "20px",
  color: "var(--v2-text-text-muted, inherit)",
}
const SECTION_STYLE: JSX.CSSProperties = { display: "grid", gap: "16px" }
const SECTION_TITLE_STYLE: JSX.CSSProperties = {
  margin: "0",
  padding: "0",
  "font-size": "13px",
  "font-weight": "530",
  "line-height": "var(--line-height-compact, 1.3)",
  color: "var(--v2-text-text-base, inherit)",
}
const LIST_STYLE: JSX.CSSProperties = {
  "background-color": "var(--v2-background-bg-layer-01, transparent)",
  "box-shadow":
    "inset 0 0 0 0.5px var(--v2-border-border-muted, color-mix(in srgb, currentColor 14%, transparent))",
  "border-radius": "8px",
  "padding-inline": "20px",
}
const ROW_STYLE: JSX.CSSProperties = {
  display: "flex",
  gap: "16px",
  "align-items": "center",
  "justify-content": "space-between",
  "padding-block": "20px",
}
const ROW_BORDER =
  "0.5px solid var(--v2-border-border-base, color-mix(in srgb, currentColor 10%, transparent))"
const LABEL_STYLE: JSX.CSSProperties = {
  "font-size": "13px",
  "font-weight": "530",
  "line-height": "var(--line-height-compact, 1.3)",
  color: "var(--v2-text-text-base, inherit)",
}
const DESCRIPTION_STYLE: JSX.CSSProperties = {
  "font-size": "13px",
  "font-weight": "440",
  "line-height": "20px",
  "margin-block": "-3.5px",
  color: "var(--v2-text-text-muted, inherit)",
}
const VALUE_STYLE: JSX.CSSProperties = {
  "font-size": "13px",
  "font-weight": "440",
  "line-height": "20px",
  "text-align": "right",
  "overflow-wrap": "anywhere",
  color: "var(--v2-text-text-muted, inherit)",
}
const BUTTONS_STYLE: JSX.CSSProperties = { display: "flex", gap: "8px", "align-items": "center" }

function Row(props: {
  readonly label: string
  readonly value?: string
  readonly last?: boolean
  readonly children?: JSX.Element
}) {
  return (
    <div style={props.last ? ROW_STYLE : { ...ROW_STYLE, "border-bottom": ROW_BORDER }}>
      <span style={LABEL_STYLE}>{props.label}</span>
      {props.children ?? <span style={VALUE_STYLE}>{props.value}</span>}
    </div>
  )
}

function SwitchRow(props: {
  readonly label: string
  readonly description: string
  readonly control: JSX.Element
  readonly last?: boolean
}) {
  return (
    <div style={props.last ? ROW_STYLE : { ...ROW_STYLE, "border-bottom": ROW_BORDER }}>
      <div style={{ display: "flex", "flex-direction": "column", flex: "1", gap: "8px", "min-width": "0" }}>
        <span style={LABEL_STYLE}>{props.label}</span>
        <span style={DESCRIPTION_STYLE}>{props.description}</span>
      </div>
      {props.control}
    </div>
  )
}

function Section(props: { readonly title: string; readonly children: JSX.Element }) {
  return (
    <section style={SECTION_STYLE}>
      <h2 style={SECTION_TITLE_STYLE}>{props.title}</h2>
      <div style={LIST_STYLE}>{props.children}</div>
    </section>
  )
}

type SettingsPageResult =
  | {
      config: { settings: SettingsView; version?: string }
      index: StatusView
      catalog: CatalogView
    }
  | { error: string }

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

/** The Settings > Indexing page. */
function IndexingSettings(props: { readonly ctx: Context }) {
  const ctx = props.ctx
  const [saving, setSaving] = createSignal<string>()
  const [running, setRunning] = createSignal<"build" | "refresh" | "local">()

  const [data, { refetch, mutate }] = createResource<SettingsPageResult>(async () => {
    const api = client(ctx)
    const directory = ctx.sessions.current()?.directory
    try {
      const [config, index, catalog] = await Promise.all([
        api["settings.get"]({}),
        api["status.get"]({ checkFreshness: false, directory }),
        api["catalog.get"]({}),
      ])
      return { config, index, catalog }
    } catch (error) {
      return { error: describeError(error) }
    }
  })

  const adopt = (settings: SettingsView): void => {
    mutate((current) => {
      if (!current || "error" in current) return current
      return { ...current, config: { ...current.config, settings } }
    })
  }

  const saveFailed = (error: unknown): void => {
    ctx.toast.show({ variant: "error", title: ctx.t("settings.saveFailed"), description: describeError(error) })
  }

  const applyKey = async (key: string, value: string): Promise<boolean> => {
    setSaving(key)
    try {
      const result = await client(ctx)["settings.apply"]({ key, value })
      if (!result.ok) {
        ctx.toast.show({ variant: "error", title: ctx.t("settings.saveFailed"), description: result.error })
        return false
      }
      if (result.settings) adopt(result.settings)
      return true
    } catch (error) {
      saveFailed(error)
      return false
    } finally {
      setSaving(undefined)
    }
  }

  const setCredential = async (provider: string, title: string): Promise<void> => {
    const value = await ctx.dialogs.prompt({
      title,
      secret: true,
      placeholder: ctx.t("settings.secretPlaceholder"),
    })
    if (value === undefined) return
    setSaving(`credential:${provider}`)
    try {
      const result = await client(ctx)["settings.credential"]({ provider, value })
      if (!result.ok) {
        ctx.toast.show({ variant: "error", title: ctx.t("settings.saveFailed"), description: result.error })
        return
      }
      if (result.settings) adopt(result.settings)
      ctx.toast.show({ variant: "success", title: ctx.t("toast.saved") })
    } catch (error) {
      saveFailed(error)
    } finally {
      setSaving(undefined)
    }
  }

  const editValue = async (key: string, title: string, value?: string): Promise<void> => {
    const typed = await ctx.dialogs.prompt({ title, value })
    if (typed === undefined) return
    await applyKey(key, typed)
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
              <Section title={ctx.t("settings.status")}>
                <div style={{ display: "grid", gap: "10px", "padding-block": "20px", "justify-items": "start" }}>
                  <p style={{ margin: "0", "font-size": "13px" }}>{ctx.t("settings.failed")}</p>
                  <p style={{ ...DESCRIPTION_STYLE, margin: "0" }}>{result.error}</p>
                  <ctx.ui.Button
                    variant="neutral"
                    size="small"
                    icon="outline-rotate-clockwise"
                    onClick={() => void refetch()}
                  >
                    {ctx.t("settings.reload")}
                  </ctx.ui.Button>
                </div>
              </Section>
            )
          }

          const settings = () => result.config.settings
          const index = () => result.index
          const catalog = () => result.catalog
          const state = () => stateOf(settings(), index())
          const points = () => pointsText(index().ownPoints)
          const providerView = () => catalog().providers.find((provider) => provider.id === settings().provider)
          const modelLabel = () => settings().model || providerView()?.defaultModel || ctx.t("settings.defaultModel")
          const isConfigured = (provider: string) => settings().configuredProviders.includes(provider)

          const confirmReindex = async (title: string, body: string): Promise<boolean> =>
            ctx.dialogs.confirm({
              title,
              description: body.replace("{points}", points()),
              confirm: ctx.t("settings.continue"),
              cancel: ctx.t("settings.cancel"),
              danger: true,
            })

          const chooseProvider = async (): Promise<void> => {
            const picked = await ctx.dialogs.select<string>({
              title: ctx.t("settings.chooseProvider"),
              current: settings().provider,
              options: catalog().providers.map((provider) => ({
                title: provider.id,
                value: provider.id,
                description: provider.liveTested ? ctx.t("settings.tested") : ctx.t("settings.notTested"),
              })),
            })
            if (!picked || picked === settings().provider) return
            if (!(await confirmReindex(ctx.t("confirm.providerTitle"), ctx.t("confirm.providerBody")))) return
            await applyKey("provider", picked)
          }

          const chooseModel = async (): Promise<void> => {
            const provider = providerView()
            const options = (provider?.models ?? []).map((model) => ({
              title: model.id,
              value: model.id,
              description: [
                model.dimension ? `${model.dimension}d` : undefined,
                model.kiloMirrored ? ctx.t("settings.kiloImportable") : undefined,
              ]
                .filter(Boolean)
                .join(" · "),
            }))
            if (options.length === 0) {
              await editValue("model", ctx.t("settings.chooseModel"), settings().model)
              return
            }
            const custom = "\u0000custom"
            const picked = await ctx.dialogs.select<string>({
              title: ctx.t("settings.chooseModel"),
              current: settings().model,
              options: [...options, { title: ctx.t("settings.customModel"), value: custom }],
            })
            if (picked === undefined) return
            let model = picked
            if (picked === custom) {
              const typed = await ctx.dialogs.prompt({ title: ctx.t("settings.customModel"), value: settings().model })
              if (!typed) return
              model = typed.trim()
            }
            if (!model || model === settings().model) return
            if (!(await confirmReindex(ctx.t("confirm.modelTitle"), ctx.t("confirm.modelBody")))) return
            await applyKey("model", model)
          }

          const chooseStore = async (): Promise<void> => {
            const picked = await ctx.dialogs.select<"lancedb" | "qdrant">({
              title: ctx.t("settings.chooseStore"),
              current: settings().vectorStore,
              options: [
                { title: "lancedb", value: "lancedb", description: ctx.t("settings.lancedbHint") },
                { title: "qdrant", value: "qdrant", description: ctx.t("settings.qdrantHint") },
              ],
            })
            if (!picked || picked === settings().vectorStore) return
            const ok = await ctx.dialogs.confirm({
              title: ctx.t("confirm.storeTitle"),
              description: ctx.t("confirm.storeBody"),
              confirm: ctx.t("settings.continue"),
              cancel: ctx.t("settings.cancel"),
              danger: true,
            })
            if (!ok) return
            await applyKey("vectorstore", picked)
          }

          const testBackend = async (target: "qdrant" | "lancedb" | "provider"): Promise<void> => {
            const outcome = await client(ctx)["settings.test"]({ target })
            ctx.toast.show({
              variant: outcome.ok ? "success" : "error",
              title: outcome.ok ? ctx.t("settings.testPassed") : ctx.t("settings.testFailed"),
              description: outcome.message,
            })
          }

          const setupLocal = async (): Promise<void> => {
            const ok = await ctx.dialogs.confirm({
              title: ctx.t("setup.title"),
              description: ctx.t("setup.description"),
              confirm: ctx.t("setup.confirm"),
              cancel: ctx.t("settings.cancel"),
            })
            if (!ok) return
            setRunning("local")
            try {
              const probe = await client(ctx)["settings.test"]({ target: "lancedb" })
              if (!probe.ok) {
                ctx.toast.show({ variant: "error", title: ctx.t("setup.failed"), description: probe.message })
                return
              }
              const written = await client(ctx)["settings.set"]({
                patch: {
                  vectorStore: "lancedb",
                  provider: "local",
                  model: "",
                  importFromKilo: true,
                  searchKilo: true,
                  autoRefresh: true,
                },
              })
              if (written.settings) adopt(written.settings)
              await runIndexAction(ctx, "index.build")
              await refetch()
            } catch (error) {
              ctx.toast.show({ variant: "error", title: ctx.t("setup.failed"), description: describeError(error) })
            } finally {
              setRunning(undefined)
            }
          }

          return (
            <>
              <Section title={ctx.t("settings.quickStart")}>
                <div style={{ display: "grid", gap: "12px", "padding-block": "20px", "justify-items": "start" }}>
                  <p style={{ ...DESCRIPTION_STYLE, margin: "0" }}>{ctx.t("setup.description")}</p>
                  <ctx.ui.Button
                    variant="contrast"
                    icon="cube"
                    busy={running() === "local"}
                    onClick={() => void setupLocal()}
                  >
                    {ctx.t("setup.action")}
                  </ctx.ui.Button>
                </div>
              </Section>

              <Section title={ctx.t("settings.status")}>
                <Row label={ctx.t("settings.state")}>
                  <span
                    style={{
                      display: "inline-flex",
                      gap: "6px",
                      "align-items": "center",
                      "font-size": "13px",
                      color: "var(--v2-text-text-muted, inherit)",
                    }}
                  >
                    <ctx.ui.Icon name={stateIcon(state())} size="small" />
                    {ctx.t(`state.${state()}`)}
                  </span>
                </Row>
                <Row label={ctx.t("settings.points")} value={points()} />
                <Row label={ctx.t("settings.workspace")} value={text(index().workspace)} />
                <Row label={ctx.t("settings.recommendation")} value={index().recommendation} last />
              </Section>

              <Section title={ctx.t("settings.embedding")}>
                <Row label={ctx.t("settings.provider")}>
                  <span style={{ display: "inline-flex", gap: "8px", "align-items": "center" }}>
                    <span style={VALUE_STYLE}>{settings().provider}</span>
                    <ctx.ui.Button variant="ghost" size="small" onClick={() => void chooseProvider()}>
                      {ctx.t("settings.change")}
                    </ctx.ui.Button>
                  </span>
                </Row>
                <Row label={ctx.t("settings.model")}>
                  <span style={{ display: "inline-flex", gap: "8px", "align-items": "center" }}>
                    <span style={VALUE_STYLE}>{modelLabel()}</span>
                    <ctx.ui.Button variant="ghost" size="small" onClick={() => void chooseModel()}>
                      {ctx.t("settings.change")}
                    </ctx.ui.Button>
                  </span>
                </Row>
                <Row label={ctx.t("settings.dimension")} value={String(settings().dimension)} />
                <Show when={["mistral", "openai", "gemini", "voyage", "openrouter"].includes(settings().provider)}>
                  <Row label={ctx.t("settings.apiKey")}>
                    <span style={{ display: "inline-flex", gap: "8px", "align-items": "center" }}>
                      <span style={VALUE_STYLE}>
                        {isConfigured(settings().provider) ? ctx.t("settings.configured") : ctx.t("settings.notConfigured")}
                      </span>
                      <ctx.ui.Button
                        variant="ghost"
                        size="small"
                        busy={saving() === `credential:${settings().provider}`}
                        onClick={() =>
                          void setCredential(settings().provider, `${settings().provider} ${ctx.t("settings.apiKey")}`)
                        }
                      >
                        {ctx.t("settings.setKey")}
                      </ctx.ui.Button>
                    </span>
                  </Row>
                </Show>
                <Row label={ctx.t("settings.ollamaUrl")}>
                  <ctx.ui.Button
                    variant="ghost"
                    size="small"
                    onClick={() => void editValue("ollamaurl", ctx.t("settings.ollamaUrl"))}
                  >
                    {ctx.t("settings.edit")}
                  </ctx.ui.Button>
                </Row>
                <Row label={ctx.t("settings.compatUrl")}>
                  <ctx.ui.Button
                    variant="ghost"
                    size="small"
                    onClick={() => void editValue("openaicompatibleurl", ctx.t("settings.compatUrl"))}
                  >
                    {ctx.t("settings.edit")}
                  </ctx.ui.Button>
                </Row>
                <Row label={ctx.t("settings.compatKey")}>
                  <span style={{ display: "inline-flex", gap: "8px", "align-items": "center" }}>
                    <span style={VALUE_STYLE}>
                      {isConfigured("openai-compatible") ? ctx.t("settings.configured") : ctx.t("settings.notConfigured")}
                    </span>
                    <ctx.ui.Button
                      variant="ghost"
                      size="small"
                      onClick={() => void setCredential("openai-compatible", ctx.t("settings.compatKey"))}
                    >
                      {ctx.t("settings.setKey")}
                    </ctx.ui.Button>
                  </span>
                </Row>
                <Row label={ctx.t("settings.testProvider")} last>
                  <ctx.ui.Button variant="ghost" size="small" onClick={() => void testBackend("provider")}>
                    {ctx.t("settings.test")}
                  </ctx.ui.Button>
                </Row>
              </Section>

              <Section title={ctx.t("settings.storage")}>
                <Row label={ctx.t("settings.store")}>
                  <span style={{ display: "inline-flex", gap: "8px", "align-items": "center" }}>
                    <span style={VALUE_STYLE}>{settings().vectorStore}</span>
                    <ctx.ui.Button variant="ghost" size="small" onClick={() => void chooseStore()}>
                      {ctx.t("settings.change")}
                    </ctx.ui.Button>
                  </span>
                </Row>
                <Row
                  label={ctx.t("settings.location")}
                  value={settings().vectorStore === "qdrant" ? settings().qdrantUrl : settings().lancedbDirectory}
                />
                <Row label={ctx.t("settings.qdrantUrl")}>
                  <ctx.ui.Button
                    variant="ghost"
                    size="small"
                    onClick={() => void editValue("qdranturl", ctx.t("settings.qdrantUrl"), settings().qdrantUrl)}
                  >
                    {ctx.t("settings.edit")}
                  </ctx.ui.Button>
                </Row>
                <Row label={ctx.t("settings.qdrantKey")}>
                  <span style={{ display: "inline-flex", gap: "8px", "align-items": "center" }}>
                    <span style={VALUE_STYLE}>
                      {settings().qdrantApiKey ? settings().qdrantApiKey : ctx.t("settings.notConfigured")}
                    </span>
                    <ctx.ui.Button
                      variant="ghost"
                      size="small"
                      onClick={() => void setCredential("qdrant", ctx.t("settings.qdrantKey"))}
                    >
                      {ctx.t("settings.setKey")}
                    </ctx.ui.Button>
                  </span>
                </Row>
                <Row label={ctx.t("settings.lancedbDir")}>
                  <ctx.ui.Button
                    variant="ghost"
                    size="small"
                    onClick={() =>
                      void editValue("lancedbdirectory", ctx.t("settings.lancedbDir"), settings().lancedbDirectory)
                    }
                  >
                    {ctx.t("settings.edit")}
                  </ctx.ui.Button>
                </Row>
                <Row label={ctx.t("settings.testStore")} last>
                  <ctx.ui.Button
                    variant="ghost"
                    size="small"
                    onClick={() => void testBackend(settings().vectorStore === "qdrant" ? "qdrant" : "lancedb")}
                  >
                    {ctx.t("settings.test")}
                  </ctx.ui.Button>
                </Row>
              </Section>

              <Section title={ctx.t("settings.indexing")}>
                <SwitchRow
                  label={ctx.t("settings.enabled")}
                  description={ctx.t("settings.enabledDescription")}
                  control={
                    <ctx.ui.Switch
                      label={ctx.t("settings.enabled")}
                      hideLabel
                      checked={settings().enabled !== false}
                      disabled={saving() === "enabled"}
                      onChange={(checked) => void applyKey("enabled", String(checked))}
                    />
                  }
                />
                <SwitchRow
                  label={ctx.t("settings.importFromKilo")}
                  description={ctx.t("settings.importFromKiloDescription")}
                  control={
                    <ctx.ui.Switch
                      label={ctx.t("settings.importFromKilo")}
                      hideLabel
                      checked={settings().importFromKilo}
                      disabled={saving() === "importfromkilo"}
                      onChange={(checked) => void applyKey("importfromkilo", String(checked))}
                    />
                  }
                />
                <SwitchRow
                  label={ctx.t("settings.searchKilo")}
                  description={ctx.t("settings.searchKiloDescription")}
                  control={
                    <ctx.ui.Switch
                      label={ctx.t("settings.searchKilo")}
                      hideLabel
                      checked={settings().searchKilo !== false}
                      disabled={saving() === "searchkilo"}
                      onChange={(checked) => void applyKey("searchkilo", String(checked))}
                    />
                  }
                />
                <SwitchRow
                  label={ctx.t("settings.autoRefresh")}
                  description={ctx.t("settings.autoRefreshDescription")}
                  control={
                    <ctx.ui.Switch
                      label={ctx.t("settings.autoRefresh")}
                      hideLabel
                      checked={settings().autoRefresh}
                      disabled={saving() === "autorefresh"}
                      onChange={(checked) => void applyKey("autorefresh", String(checked))}
                    />
                  }
                />
                <SwitchRow
                  label={ctx.t("settings.codegraph")}
                  description={ctx.t("settings.codegraphDescription")}
                  last
                  control={
                    <ctx.ui.Switch
                      label={ctx.t("settings.codegraph")}
                      hideLabel
                      checked={settings().codegraph !== false}
                      disabled={saving() === "codegraph"}
                      onChange={(checked) => void applyKey("codegraph", String(checked))}
                    />
                  }
                />
              </Section>

              <Section title={ctx.t("settings.search")}>
                <Row label={ctx.t("settings.searchMaxResults")}>
                  <span style={{ display: "inline-flex", gap: "8px", "align-items": "center" }}>
                    <span style={VALUE_STYLE}>{String(settings().searchMaxResults)}</span>
                    <ctx.ui.Button
                      variant="ghost"
                      size="small"
                      onClick={() =>
                        void editValue("searchmaxresults", ctx.t("settings.searchMaxResults"), String(settings().searchMaxResults))
                      }
                    >
                      {ctx.t("settings.edit")}
                    </ctx.ui.Button>
                  </span>
                </Row>
                <Row label={ctx.t("settings.searchMinScore")}>
                  <span style={{ display: "inline-flex", gap: "8px", "align-items": "center" }}>
                    <span style={VALUE_STYLE}>
                      {settings().searchMinScore === null ? ctx.t("settings.modelDefault") : String(settings().searchMinScore)}
                    </span>
                    <ctx.ui.Button
                      variant="ghost"
                      size="small"
                      onClick={() =>
                        void editValue(
                          "searchminscore",
                          ctx.t("settings.searchMinScore"),
                          settings().searchMinScore === null ? "default" : String(settings().searchMinScore),
                        )
                      }
                    >
                      {ctx.t("settings.edit")}
                    </ctx.ui.Button>
                  </span>
                </Row>
                <Row label={ctx.t("settings.batchSize")}>
                  <span style={{ display: "inline-flex", gap: "8px", "align-items": "center" }}>
                    <span style={VALUE_STYLE}>{String(settings().embeddingBatchSize)}</span>
                    <ctx.ui.Button
                      variant="ghost"
                      size="small"
                      onClick={() =>
                        void editValue(
                          "embeddingbatchsize",
                          ctx.t("settings.batchSize"),
                          String(settings().embeddingBatchSize),
                        )
                      }
                    >
                      {ctx.t("settings.edit")}
                    </ctx.ui.Button>
                  </span>
                </Row>
                <Row label={ctx.t("settings.extensions")}>
                  <span style={{ display: "inline-flex", gap: "8px", "align-items": "center" }}>
                    <span style={VALUE_STYLE}>{settings().fileExtensions.length}</span>
                    <ctx.ui.Button
                      variant="ghost"
                      size="small"
                      onClick={() =>
                        void editValue(
                          "fileextensions",
                          ctx.t("settings.extensions"),
                          settings().fileExtensions.join(","),
                        )
                      }
                    >
                      {ctx.t("settings.edit")}
                    </ctx.ui.Button>
                  </span>
                </Row>
                <Row label={ctx.t("settings.file")} value={settings().settingsFile} last />
              </Section>

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
      "settings.quickStart": "Quick start",
      "settings.status": "Index status",
      "settings.state": "State",
      "settings.points": "Points",
      "settings.workspace": "Workspace",
      "settings.recommendation": "Next step",
      "settings.embedding": "Embedding",
      "settings.storage": "Storage",
      "settings.indexing": "Indexing",
      "settings.search": "Search",
      "settings.provider": "Embedding provider",
      "settings.model": "Embedding model",
      "settings.defaultModel": "(provider default)",
      "settings.dimension": "Dimensions",
      "settings.apiKey": "API key",
      "settings.apiKeyConfigured": "Configured",
      "settings.configured": "Configured",
      "settings.notConfigured": "Not set",
      "settings.setKey": "Set key",
      "settings.secretPlaceholder": "Paste the key",
      "settings.ollamaUrl": "Ollama base URL",
      "settings.compatUrl": "OpenAI-compatible URL",
      "settings.compatKey": "OpenAI-compatible key",
      "settings.testProvider": "Test the provider",
      "settings.store": "Vector store",
      "settings.location": "Location",
      "settings.qdrantUrl": "Qdrant URL",
      "settings.qdrantKey": "Qdrant API key",
      "settings.lancedbDir": "LanceDB directory",
      "settings.testStore": "Test the store",
      "settings.test": "Test",
      "settings.testPassed": "Connection works",
      "settings.testFailed": "Connection failed",
      "settings.change": "Change",
      "settings.edit": "Edit",
      "settings.continue": "Continue",
      "settings.cancel": "Cancel",
      "settings.chooseProvider": "Choose the embedding provider",
      "settings.chooseModel": "Choose the embedding model",
      "settings.chooseStore": "Choose the vector store",
      "settings.customModel": "Custom model…",
      "settings.tested": "Verified against the real API",
      "settings.notTested": "Not verified against the real API",
      "settings.kiloImportable": "importable from Kilo",
      "settings.lancedbHint": "Embedded, nothing to run",
      "settings.qdrantHint": "A server you run yourself",
      "settings.defaultModelValue": "(model default)",
      "settings.modelDefault": "(model default)",
      "settings.enabled": "Indexing enabled",
      "settings.enabledDescription": "When off, nothing is written or refreshed.",
      "settings.importFromKilo": "Import from Kilo",
      "settings.importFromKiloDescription": "Copy a compatible Kilo index instead of re-embedding.",
      "settings.searchKilo": "Search Kilo's index",
      "settings.searchKiloDescription": "Also search Kilo's index. Turn it off when that index was built with a model this machine cannot embed.",
      "settings.autoRefresh": "Auto refresh",
      "settings.autoRefreshDescription": "Refresh on search when a few files changed.",
      "settings.codegraph": "Codegraph companion",
      "settings.codegraphDescription": "Also run the codegraph CLI on build.",
      "settings.searchMaxResults": "Search results",
      "settings.searchMinScore": "Minimum score",
      "settings.modelDefaultShort": "(model default)",
      "settings.batchSize": "Embedding batch size",
      "settings.extensions": "File extensions",
      "settings.file": "Settings file",
      "settings.loading": "Reading index status…",
      "settings.failed": "Could not read the index status.",
      "settings.saveFailed": "Could not save the setting",
      "settings.build": "Build",
      "settings.refresh": "Refresh",
      "settings.reload": "Reload",
      "settings.none": "none",
      "setup.title": "Set up locally",
      "setup.description":
        "Use the bundled local model and embedded LanceDB: no API key, no server, and one reindex. Change it later from this page.",
      "setup.action": "Set up locally",
      "setup.confirm": "Set up",
      "setup.failed": "Could not set up locally",
      "confirm.providerTitle": "Change the embedding provider?",
      "confirm.providerBody":
        "The own index holds {points} points embedded with the current model. A different provider means a different vector space, so the next build re-embeds every file. With a cloud provider that is a full API run.",
      "confirm.modelTitle": "Change the embedding model?",
      "confirm.modelBody":
        "The own index holds {points} points embedded with the current model. A different model re-embeds every file; with a cloud provider that costs a full API run.",
      "confirm.storeTitle": "Change where the index lives?",
      "confirm.storeBody":
        "The own index will be written to the new store. The existing index stays where it is and is not migrated; build it again to search this workspace.",
      "toast.saved": "Saved",
      "toast.building": "Building the index…",
      "toast.refreshing": "Refreshing the index…",
      "toast.done": "Index updated",
      "toast.failed": "Indexing failed",
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
          if (!current || current.directory !== input.session.directory) return undefined
          return pillView(ctx, stateOf(current.settings, current.status), current.status.ownPoints)
        },
      }),
    )
  },
})
