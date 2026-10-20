/**
 * Full settings page for the terminal UI (option B).
 *
 * Registered as a navigable plugin page (`router.register`) and opened from
 * `/indexing`. It renders the current configuration, detected Kilo sources and
 * the available index actions; every action goes through the server plugin RPC.
 *
 * Interaction is keyboard-driven through the host keymap (`tui/page-store.ts`):
 * up/down or j/k move, return runs, `e` edits settings in the dialog editor,
 * `r` reloads and escape closes. Actions are rendered as text rows on purpose —
 * a `<select>` inside an auto-sized box collapses to a single invisible row that
 * still eats keystrokes.
 *
 * Styling comes from the host theme via `tui/page-style.ts`: no hardcoded
 * colors, no panels, and selection carried by text contrast plus a marker rather
 * than a background that a theme is free to leave transparent.
 *
 * NO JSX SYNTAX ON PURPOSE. Installed from npm the file lives under
 * node_modules, where the host's JSX transform does not run, so the tree is
 * built with the `jsx`/`jsxs` runtime re-exported by `tui/host-runtime.ts`.
 * The runtime reads every prop inside a render effect, so anything that comes
 * from a signal or a resource must be passed as a getter; static values are
 * passed as plain values.
 */

import type { Accessor, JSX } from "./host-runtime.ts"
import { For, Show, createMemo, createResource, createSignal, createTextAttributes, jsx, jsxs, onCleanup, onMount } from "./host-runtime.ts"

import { describeError } from "../src/errors.ts"
import { LABEL_COLUMN, SELECTED_MARKER, UNSELECTED_MARKER, pagePalette, type PageColor } from "./page-style.ts"
import { describeRow, type WorkspaceRow } from "./workspaces.ts"
import {
  EDIT_ROW,
  PAGE_ACTIONS,
  PAGE_ROWS,
  actionRowText,
  configRows,
  describeSource,
  loadSettingsPageData,
  RELOAD_ROW,
  type ConfigRow,
  type KiloSourceView,
  type PageRow,
  type SettingsPageData,
  type SettingsPageProps,
} from "./settings-page-data.ts"

export type { SettingsPageProps }

type ActionState =
  | { phase: "idle" }
  | { phase: "running"; label: string }
  | { phase: "done"; label: string; result: string }
  | { phase: "error"; label: string; message: string }

/** Section headings, matching the host's bold headers. */
const HEADING = createTextAttributes({ bold: true })

/**
 * Renders a host component (`Show`, `For`) through the JSX runtime.
 *
 * `jsx` types every component as `(props: Record<string, unknown>) => unknown`,
 * which Solid's `Show`/`For` do not satisfy — their props have required keys —
 * so the cast has to live somewhere. One helper keeps it out of the render tree
 * and documents why it exists.
 */
function hostComponent(type: (props: never) => unknown, props: Record<string, unknown>): JSX.Element {
  return jsx(type as (props: Record<string, unknown>) => unknown, props)
}

export function SettingsPage(props: SettingsPageProps): JSX.Element {
  const palette = pagePalette(props.theme)
  const [data, { refetch }] = createResource<SettingsPageData>(() => loadSettingsPageData(props.rpc()))

  const [actionState, setActionState] = createSignal<ActionState>({ phase: "idle" })

  /** Bumped by the store so the memo below re-reads the selection index. */
  const [selectionVersion, bumpSelection] = createSignal(0)

  /**
   * Resource value, or undefined while loading and after a failure.
   *
   * The resource accessor re-throws once the load errored, so the error is
   * checked before touching the value: that is what turns a failure into the
   * error block below instead of an exception thrown into the host renderer.
   */
  const loadedData = (): SettingsPageData | undefined => (data.error !== undefined ? undefined : data())

  const runAction = async (id: string, source?: string): Promise<void> => {
    const action = PAGE_ACTIONS.find((entry) => entry.id === id)
    if (!action) return
    setActionState({ phase: "running", label: action.title })
    try {
      const result = await action.run(props.rpc(), source)
      setActionState({ phase: "done", label: action.title, result })
      props.toast(result, "success")
      void refetch()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setActionState({ phase: "error", label: action.title, message })
      props.toast(message, "error")
    }
  }

  const chooseAction = (id: string): void => {
    const action = PAGE_ACTIONS.find((entry) => entry.id === id)
    if (!action) return
    if (action.kind === "source" && (loadedData()?.sources ?? []).length === 0) {
      // Report the reason when there is one: an index that exists but cannot be
      // read is fixed by installing something, not by building one.
      const problems = loadedData()?.problems ?? []
      props.toast(
        problems.length > 0 ? `No importable Kilo index: ${problems.join(" · ")}` : "No Kilo index found for this workspace",
        problems.length > 0 ? "error" : "info",
      )
      return
    }
    // No source passed: the server picks the first compatible one. Use the
    // dialog editor (e) to import from a specific source.
    void runAction(id)
  }

  const reload = (): void => {
    void refetch()
    props.toast("Reloaded indexing status", "info")
  }

  const runSelected = (): void => {
    const row = props.store.index
    if (row === EDIT_ROW) {
      props.onEdit()
      return
    }
    if (row === RELOAD_ROW) {
      reload()
      return
    }
    const action = PAGE_ACTIONS[row]
    if (action) chooseAction(action.id)
  }

  onMount(() => {
    const unsubscribe = props.store.subscribe(() => {
      bumpSelection((value) => value + 1)
      const command = props.store.takeCommand()
      // "edit" and "close" never reach the page: tui.ts owns them because they
      // need the dialog/router, and routing them here would keep the page keys
      // live while a dialog is stacked on top.
      if (command === "run") runSelected()
      else if (command === "reload") reload()
    })
    onCleanup(unsubscribe)
  })

  const selectedIndex = createMemo(() => {
    selectionVersion()
    return props.store.index
  })

  const isSelected = (row: number): boolean => row === selectedIndex()

  /**
   * One text line whose content is read reactively.
   *
   * `fg` is static (the theme is resolved once) but the text is not, so it goes
   * in as a getter.
   */
  const line = (color: PageColor, text: () => string): JSX.Element =>
    jsx("text", {
      fg: color,
      get children() {
        return text()
      },
    })

  /** Bold section heading, in the muted color the host uses for headers. */
  const heading = (text: string): JSX.Element => jsx("text", { fg: palette.muted, attributes: HEADING, children: text })

  /**
   * Title, with the version of the plugin answering the RPC when it is known.
   *
   * "unknown" is the server's own placeholder for a manifest it could not read,
   * which is not a version and would read as noise next to the title.
   */
  const titleText = (): string => {
    const version = loadedData()?.version
    return version && version !== "unknown" ? `Indexing settings · v${version}` : "Indexing settings"
  }

  /**
   * What the status section shows when there is no data.
   *
   * A failed load gets the message and a way out; only a genuinely pending
   * resource gets the "Loading…" line, so a rejection can never leave the page
   * sitting on it forever.
   */
  const fallbackBlock = (): JSX.Element => {
    const error = data.error
    // The same check the resource itself makes before re-throwing: only
    // `undefined` means "no error".
    if (error !== undefined) {
      return jsxs("box", {
        flexDirection: "column",
        children: [
          jsx("text", { fg: palette.error, children: `Could not load indexing status: ${describeError(error)}` }),
          jsx("text", { fg: palette.muted, children: "press r to retry" }),
        ],
      })
    }
    return jsx("text", { fg: palette.muted, children: "Loading indexing status…" })
  }

  /** Line describing the last action; the phase decides both text and color. */
  const lastActionText = (): string | null => {
    const state = actionState()
    switch (state.phase) {
      case "idle":
        return null
      case "running":
        return `${state.label}…`
      case "done":
        return `${state.label}: ${state.result}`
      case "error":
        return `${state.label} failed: ${state.message}`
    }
  }

  const lastActionColor = (): PageColor => {
    const phase = actionState().phase
    if (phase === "done") return palette.success
    if (phase === "error") return palette.error
    return palette.value
  }

  const statusSection = hostComponent(Show, {
    get when() {
      return loadedData()
    },
    get fallback() {
      return fallbackBlock()
    },
    children: (loaded: Accessor<SettingsPageData>) => [
      heading("Status"),
      line(palette.value, () => loaded().status.summary),
      hostComponent(Show, {
        get when() {
          return loaded().status.recommendation !== ""
        },
        get children() {
          return line(palette.muted, () => loaded().status.recommendation)
        },
      }),

      heading("Configuration"),
      hostComponent(For, {
        get each() {
          return configRows(loaded().settings, loaded().version)
        },
        children: (row: ConfigRow) =>
          jsxs("box", {
            flexDirection: "row",
            gap: 2,
            children: [
              jsx("text", { fg: palette.muted, width: LABEL_COLUMN, get children() { return row.label } }),
              jsx("text", { fg: palette.value, get children() { return row.value } }),
            ],
          }),
      }),
    ],
  })

  const sourcesSection = hostComponent(Show, {
    get when() {
      return (loadedData()?.sources ?? []).length > 0
    },
    get children() {
      return [
        heading("Kilo sources"),
        hostComponent(For, {
          get each() {
            return loadedData()?.sources ?? []
          },
          children: (source: KiloSourceView) =>
            jsxs("box", {
              flexDirection: "row",
              gap: 2,
              children: [
                jsx("text", { fg: palette.accent, width: 2, children: "•" }),
                jsx("text", { fg: palette.value, children: source.name }),
                jsx("text", { fg: palette.muted, children: describeSource(source) }),
              ],
            }),
        }),
      ]
    },
  })

  const workspacesSection = hostComponent(Show, {
    get when() {
      return (loadedData()?.workspaces.rows ?? []).length > 0
    },
    get children() {
      return [
        heading("Indexed workspaces"),
        hostComponent(For, {
          get each() {
            return loadedData()?.workspaces.rows ?? []
          },
          children: (row: WorkspaceRow) =>
            jsxs("box", {
              flexDirection: "row",
              gap: 2,
              children: [
                jsx("text", {
                  width: 2,
                  get fg() {
                    return row.root === null ? palette.error : palette.accent
                  },
                  get children() {
                    return row.root === null ? "?" : "•"
                  },
                }),
                jsx("text", { fg: palette.value, children: describeRow(row) }),
              ],
            }),
        }),
        hostComponent(Show, {
          get when() {
            return (loadedData()?.workspaces.unknownCount ?? 0) > 0
          },
          get children() {
            return jsx("text", {
              fg: palette.muted,
              children: "Rows marked ? predate the registry, so their directory is unknown. Press e to forget one.",
            })
          },
        }),
      ]
    },
  })

  const actionsList = hostComponent(For, {
    each: PAGE_ROWS,
    children: (entry: PageRow) =>
      // One element per text run, with the description appended to the title
      // string instead of mounted conditionally: mounting a child into an
      // already-laid-out column box left the description drawn over the title,
      // so the selected row showed mangled text and lost its title.
      jsxs("box", {
        flexDirection: "row",
        gap: 1,
        paddingLeft: 1,
        get backgroundColor() {
          return isSelected(entry.row) ? palette.selectedBg : undefined
        },
        children: [
          jsx("text", {
            get fg() {
              return isSelected(entry.row) ? palette.selectedFg : palette.muted
            },
            get children() {
              return isSelected(entry.row) ? SELECTED_MARKER : UNSELECTED_MARKER
            },
          }),
          jsx("text", {
            get fg() {
              return isSelected(entry.row) ? palette.selectedFg : palette.value
            },
            get children() {
              return actionRowText(entry, isSelected(entry.row))
            },
          }),
        ],
      }),
  })

  const lastActionSection = hostComponent(Show, {
    get when() {
      return actionState().phase !== "idle"
    },
    get children() {
      return [
        heading("Last action"),
        jsx("text", {
          get fg() {
            return lastActionColor()
          },
          get children() {
            return lastActionText()
          },
        }),
      ]
    },
  })

  return jsxs("box", {
    flexDirection: "column",
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 1,
    gap: 1,
    width: "100%",
    children: [
      jsx("text", {
        fg: palette.title,
        attributes: HEADING,
        get children() {
          return titleText()
        },
      }),
      statusSection,
      sourcesSection,
      workspacesSection,
      heading("Actions"),
      actionsList,
      lastActionSection,
      jsx("text", { fg: palette.muted, children: "↑↓ move · enter run · e edit · r reload · esc close" }),
    ],
  })
}
