/**
 * OpenCode Desktop GUI for this plugin: the `./gui-experimental` bundle.
 *
 * It contributes a settings page, two palette commands and a composer pill, and
 * only reads and writes through the server part's RPC contract. The index itself
 * is never touched from this process.
 *
 * The page is built from the host's own settings components (`ctx.ui`) and its
 * native dialogs (`ctx.dialogs`): a settings page that draws its own layout and
 * controls reads as a different app.
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
import { Show, createResource, createSignal } from "solid-js"

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

/** Value of the model select's "Custom…" choice; never a real model id. */
const CUSTOM_MODEL = "\u0000custom"

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
    // With searchKilo off, Kilo was never consulted; `collection: null` then
    // means "not looked at", not "absent".
    kiloSearched: settings.searchKilo !== false,
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
    <ctx.ui.SettingsLayout
      title={ctx.t("settings.title")}
      description={ctx.t("settings.subtitle")}
      actions={
        <>
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
        </>
      }
    >
      <Show
        when={data()}
        fallback={
          <ctx.ui.SettingsSection title={ctx.t("settings.status")}>
            <ctx.ui.SettingsRow title={ctx.t("settings.loading")}>
              <ctx.ui.Loader size="small" />
            </ctx.ui.SettingsRow>
          </ctx.ui.SettingsSection>
        }
      >
        {(loaded) => {
          const result = loaded()
          if ("error" in result) {
            return (
              <ctx.ui.SettingsSection title={ctx.t("settings.status")}>
                <ctx.ui.SettingsRow title={ctx.t("settings.failed")} description={result.error}>
                  <ctx.ui.Button
                    variant="neutral"
                    size="small"
                    icon="outline-rotate-clockwise"
                    onClick={() => void refetch()}
                  >
                    {ctx.t("settings.reload")}
                  </ctx.ui.Button>
                </ctx.ui.SettingsRow>
              </ctx.ui.SettingsSection>
            )
          }

          const settings = () => result.config.settings
          const index = () => result.index
          const catalog = () => result.catalog
          const state = () => stateOf(settings(), index())
          const points = () => pointsText(index().ownPoints)
          const providerView = () => catalog().providers.find((provider) => provider.id === settings().provider)
          const providerNote = () => {
            const provider = providerView()
            if (!provider) return undefined
            return provider.liveTested ? ctx.t("settings.tested") : ctx.t("settings.notTested")
          }
          const modelOptions = () => [
            ...(providerView()?.models ?? []).map((model) => ({
              value: model.id,
              label: model.dimension
                ? ctx.t("settings.modelOption", { model: model.id, dimension: model.dimension })
                : model.id,
            })),
            { value: CUSTOM_MODEL, label: ctx.t("settings.customModel") },
          ]
          const modelPlaceholder = () => settings().model || ctx.t("settings.defaultModel")
          const isConfigured = (provider: string) => settings().configuredProviders.includes(provider)

          const confirmReindex = async (title: string, body: string): Promise<boolean> =>
            ctx.dialogs.confirm({
              title,
              description: body.replace("{points}", points()),
              confirm: ctx.t("settings.continue"),
              cancel: ctx.t("settings.cancel"),
              danger: true,
            })

          const chooseProvider = async (picked: string): Promise<void> => {
            if (!picked || picked === settings().provider) return
            if (!(await confirmReindex(ctx.t("confirm.providerTitle"), ctx.t("confirm.providerBody")))) return
            await applyKey("provider", picked)
          }

          const chooseModel = async (picked: string): Promise<void> => {
            let model = picked
            if (picked === CUSTOM_MODEL) {
              const typed = await ctx.dialogs.prompt({ title: ctx.t("settings.customModel"), value: settings().model })
              if (!typed) return
              model = typed.trim()
            }
            if (!model || model === settings().model) return
            if (!(await confirmReindex(ctx.t("confirm.modelTitle"), ctx.t("confirm.modelBody")))) return
            await applyKey("model", model)
          }

          const chooseStore = async (picked: string): Promise<void> => {
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
              <ctx.ui.SettingsSection title={ctx.t("settings.quickStart")}>
                <ctx.ui.SettingsRow title={ctx.t("setup.title")} description={ctx.t("setup.description")}>
                  <ctx.ui.Button
                    variant="contrast"
                    icon="cube"
                    busy={running() === "local"}
                    onClick={() => void setupLocal()}
                  >
                    {ctx.t("setup.action")}
                  </ctx.ui.Button>
                </ctx.ui.SettingsRow>
              </ctx.ui.SettingsSection>

              <ctx.ui.SettingsSection title={ctx.t("settings.status")}>
                <ctx.ui.SettingsRow title={ctx.t("settings.state")}>
                  <ctx.ui.Icon name={stateIcon(state())} size="small" /> {ctx.t(`state.${state()}`)}
                </ctx.ui.SettingsRow>
                <ctx.ui.SettingsRow title={ctx.t("settings.points")} description={points()} />
                <ctx.ui.SettingsRow title={ctx.t("settings.workspace")} description={text(index().workspace)} />
                <ctx.ui.SettingsRow title={ctx.t("settings.recommendation")} description={index().recommendation} />
              </ctx.ui.SettingsSection>

              <ctx.ui.SettingsSection title={ctx.t("settings.embedding")}>
                <ctx.ui.SettingsRow title={ctx.t("settings.provider")} description={providerNote()}>
                  <ctx.ui.Select
                    label={ctx.t("settings.provider")}
                    options={catalog().providers.map((provider) => ({ value: provider.id, label: provider.id }))}
                    value={settings().provider}
                    placeholder={settings().provider}
                    disabled={saving() === "provider"}
                    onChange={(picked) => void chooseProvider(picked)}
                  />
                </ctx.ui.SettingsRow>
                <ctx.ui.SettingsRow title={ctx.t("settings.model")}>
                  <ctx.ui.Select
                    label={ctx.t("settings.model")}
                    options={modelOptions()}
                    value={settings().model}
                    placeholder={modelPlaceholder()}
                    disabled={saving() === "model"}
                    onChange={(picked) => void chooseModel(picked)}
                  />
                </ctx.ui.SettingsRow>
                <ctx.ui.SettingsRow title={ctx.t("settings.dimension")} description={String(settings().dimension)} />
                <Show when={["mistral", "openai", "gemini", "voyage", "openrouter"].includes(settings().provider)}>
                  <ctx.ui.SettingsRow
                    title={`${settings().provider} ${ctx.t("settings.apiKey")}`}
                    description={
                      isConfigured(settings().provider) ? ctx.t("settings.configured") : ctx.t("settings.notConfigured")
                    }
                  >
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
                  </ctx.ui.SettingsRow>
                </Show>
                <ctx.ui.SettingsRow title={ctx.t("settings.ollamaUrl")}>
                  <ctx.ui.Button
                    variant="ghost"
                    size="small"
                    onClick={() => void editValue("ollamaurl", ctx.t("settings.ollamaUrl"))}
                  >
                    {ctx.t("settings.edit")}
                  </ctx.ui.Button>
                </ctx.ui.SettingsRow>
                <ctx.ui.SettingsRow title={ctx.t("settings.compatUrl")}>
                  <ctx.ui.Button
                    variant="ghost"
                    size="small"
                    onClick={() => void editValue("openaicompatibleurl", ctx.t("settings.compatUrl"))}
                  >
                    {ctx.t("settings.edit")}
                  </ctx.ui.Button>
                </ctx.ui.SettingsRow>
                <ctx.ui.SettingsRow
                  title={ctx.t("settings.compatKey")}
                  description={
                    isConfigured("openai-compatible") ? ctx.t("settings.configured") : ctx.t("settings.notConfigured")
                  }
                >
                  <ctx.ui.Button
                    variant="ghost"
                    size="small"
                    onClick={() => void setCredential("openai-compatible", ctx.t("settings.compatKey"))}
                  >
                    {ctx.t("settings.setKey")}
                  </ctx.ui.Button>
                </ctx.ui.SettingsRow>
                <ctx.ui.SettingsRow title={ctx.t("settings.testProvider")}>
                  <ctx.ui.Button variant="ghost" size="small" onClick={() => void testBackend("provider")}>
                    {ctx.t("settings.test")}
                  </ctx.ui.Button>
                </ctx.ui.SettingsRow>
              </ctx.ui.SettingsSection>

              <ctx.ui.SettingsSection title={ctx.t("settings.storage")}>
                <ctx.ui.SettingsRow
                  title={ctx.t("settings.store")}
                  description={
                    settings().vectorStore === "qdrant" ? ctx.t("settings.qdrantHint") : ctx.t("settings.lancedbHint")
                  }
                >
                  <ctx.ui.Select
                    label={ctx.t("settings.store")}
                    options={[
                      { value: "lancedb", label: "lancedb" },
                      { value: "qdrant", label: "qdrant" },
                    ]}
                    value={settings().vectorStore}
                    disabled={saving() === "vectorstore"}
                    onChange={(picked) => void chooseStore(picked)}
                  />
                </ctx.ui.SettingsRow>
                <ctx.ui.SettingsRow
                  title={ctx.t("settings.location")}
                  description={
                    settings().vectorStore === "qdrant" ? settings().qdrantUrl : settings().lancedbDirectory
                  }
                />
                <ctx.ui.SettingsRow title={ctx.t("settings.qdrantUrl")}>
                  <ctx.ui.Button
                    variant="ghost"
                    size="small"
                    onClick={() => void editValue("qdranturl", ctx.t("settings.qdrantUrl"), settings().qdrantUrl)}
                  >
                    {ctx.t("settings.edit")}
                  </ctx.ui.Button>
                </ctx.ui.SettingsRow>
                <ctx.ui.SettingsRow
                  title={ctx.t("settings.qdrantKey")}
                  description={settings().qdrantApiKey ? settings().qdrantApiKey : ctx.t("settings.notConfigured")}
                >
                  <ctx.ui.Button
                    variant="ghost"
                    size="small"
                    onClick={() => void setCredential("qdrant", ctx.t("settings.qdrantKey"))}
                  >
                    {ctx.t("settings.setKey")}
                  </ctx.ui.Button>
                </ctx.ui.SettingsRow>
                <ctx.ui.SettingsRow title={ctx.t("settings.lancedbDir")}>
                  <ctx.ui.Button
                    variant="ghost"
                    size="small"
                    onClick={() =>
                      void editValue("lancedbdirectory", ctx.t("settings.lancedbDir"), settings().lancedbDirectory)
                    }
                  >
                    {ctx.t("settings.edit")}
                  </ctx.ui.Button>
                </ctx.ui.SettingsRow>
                <ctx.ui.SettingsRow title={ctx.t("settings.testStore")}>
                  <ctx.ui.Button
                    variant="ghost"
                    size="small"
                    onClick={() => void testBackend(settings().vectorStore === "qdrant" ? "qdrant" : "lancedb")}
                  >
                    {ctx.t("settings.test")}
                  </ctx.ui.Button>
                </ctx.ui.SettingsRow>
              </ctx.ui.SettingsSection>

              <ctx.ui.SettingsSection title={ctx.t("settings.indexing")}>
                <ctx.ui.SettingsRow title={ctx.t("settings.enabled")} description={ctx.t("settings.enabledDescription")}>
                  <ctx.ui.Switch
                    label={ctx.t("settings.enabled")}
                    hideLabel
                    checked={settings().enabled !== false}
                    disabled={saving() === "enabled"}
                    onChange={(checked) => void applyKey("enabled", String(checked))}
                  />
                </ctx.ui.SettingsRow>
                <ctx.ui.SettingsRow
                  title={ctx.t("settings.importFromKilo")}
                  description={ctx.t("settings.importFromKiloDescription")}
                >
                  <ctx.ui.Switch
                    label={ctx.t("settings.importFromKilo")}
                    hideLabel
                    checked={settings().importFromKilo}
                    disabled={saving() === "importfromkilo"}
                    onChange={(checked) => void applyKey("importfromkilo", String(checked))}
                  />
                </ctx.ui.SettingsRow>
                <ctx.ui.SettingsRow
                  title={ctx.t("settings.searchKilo")}
                  description={ctx.t("settings.searchKiloDescription")}
                >
                  <ctx.ui.Switch
                    label={ctx.t("settings.searchKilo")}
                    hideLabel
                    checked={settings().searchKilo !== false}
                    disabled={saving() === "searchkilo"}
                    onChange={(checked) => void applyKey("searchkilo", String(checked))}
                  />
                </ctx.ui.SettingsRow>
                <ctx.ui.SettingsRow
                  title={ctx.t("settings.autoRefresh")}
                  description={ctx.t("settings.autoRefreshDescription")}
                >
                  <ctx.ui.Switch
                    label={ctx.t("settings.autoRefresh")}
                    hideLabel
                    checked={settings().autoRefresh}
                    disabled={saving() === "autorefresh"}
                    onChange={(checked) => void applyKey("autorefresh", String(checked))}
                  />
                </ctx.ui.SettingsRow>
                <ctx.ui.SettingsRow
                  title={ctx.t("settings.codegraph")}
                  description={ctx.t("settings.codegraphDescription")}
                >
                  <ctx.ui.Switch
                    label={ctx.t("settings.codegraph")}
                    hideLabel
                    checked={settings().codegraph !== false}
                    disabled={saving() === "codegraph"}
                    onChange={(checked) => void applyKey("codegraph", String(checked))}
                  />
                </ctx.ui.SettingsRow>
              </ctx.ui.SettingsSection>

              <ctx.ui.SettingsSection title={ctx.t("settings.search")}>
                <ctx.ui.SettingsRow
                  title={ctx.t("settings.searchMaxResults")}
                  description={String(settings().searchMaxResults)}
                >
                  <ctx.ui.Button
                    variant="ghost"
                    size="small"
                    onClick={() =>
                      void editValue("searchmaxresults", ctx.t("settings.searchMaxResults"), String(settings().searchMaxResults))
                    }
                  >
                    {ctx.t("settings.edit")}
                  </ctx.ui.Button>
                </ctx.ui.SettingsRow>
                <ctx.ui.SettingsRow
                  title={ctx.t("settings.searchMinScore")}
                  description={
                    settings().searchMinScore === null
                      ? ctx.t("settings.modelDefault")
                      : String(settings().searchMinScore)
                  }
                >
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
                </ctx.ui.SettingsRow>
                <ctx.ui.SettingsRow title={ctx.t("settings.batchSize")} description={String(settings().embeddingBatchSize)}>
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
                </ctx.ui.SettingsRow>
                <ctx.ui.SettingsRow
                  title={ctx.t("settings.extensions")}
                  description={settings().fileExtensions.join(", ")}
                >
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
                </ctx.ui.SettingsRow>
                <ctx.ui.SettingsRow title={ctx.t("settings.file")} description={settings().settingsFile} />
              </ctx.ui.SettingsSection>
            </>
          )
        }}
      </Show>
    </ctx.ui.SettingsLayout>
  )
}

/**
 * The composer pill for one state, or `undefined` to show nothing.
 *
 * It shows the state, not the point count: the pill is a glanceable indicator,
 * and the number is one click away in Settings. The vocabulary is the same one
 * the footer and the chat line use, so the three never describe the same state
 * with different words.
 */
const pillView = (ctx: Context, state: IndexingState) => {
  const title = ctx.t("pill.title")

  switch (state) {
    case "ready":
      return { icon: "circle-check", tone: "success", label: ctx.t("state.ready"), title } as const
    case "stale":
      return { icon: "refresh", tone: "warning", label: ctx.t("state.stale"), title } as const
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
      "settings.edit": "Edit",
      "settings.continue": "Continue",
      "settings.cancel": "Cancel",
      "settings.customModel": "Custom model…",
      "settings.modelOption": "{{model}} ({{dimension}}d)",
      "settings.tested": "Verified against the real API",
      "settings.notTested": "Not verified against the real API",
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
      "state.empty": "not indexed",
      "state.unavailable": "no index",
      "state.error": "index error",
      "pill.title": "Index status",
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
          return pillView(ctx, stateOf(current.settings, current.status))
        },
      }),
    )
  },
})
