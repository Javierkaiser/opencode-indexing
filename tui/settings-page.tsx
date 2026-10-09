/** @jsxImportSource @opentui/solid */
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
 */
import type { JSX } from "@opentui/solid"
import { createTextAttributes } from "@opentui/core"
import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"

import { LABEL_COLUMN, SELECTED_MARKER, UNSELECTED_MARKER, pagePalette } from "./page-style.ts"
import { describeRow } from "./workspaces.ts"
import {
  EDIT_ROW,
  PAGE_ACTIONS,
  PAGE_ROWS,
  actionRowText,
  RELOAD_ROW,
  configRows,
  describeSource,
  loadSettingsPageData,
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

export function SettingsPage(props: SettingsPageProps): JSX.Element {
  const palette = pagePalette(props.theme)
  const [data, { refetch }] = createResource<SettingsPageData>(() => loadSettingsPageData(props.rpc()))

  const [actionState, setActionState] = createSignal<ActionState>({ phase: "idle" })

  /** Bumped by the store so the memo below re-reads the selection index. */
  const [version, setVersion] = createSignal(0)

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
    if (action.kind === "source" && (data()?.sources ?? []).length === 0) {
      props.toast("No Kilo index found for this workspace", "info")
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
      setVersion((value) => value + 1)
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
    version()
    return props.store.index
  })

  const isSelected = (row: number): boolean => row === selectedIndex()

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} gap={1} width="100%">
      <text fg={palette.title} attributes={HEADING}>
        Indexing settings
      </text>

      <Show when={data()} fallback={<text fg={palette.muted}>Loading indexing status…</text>}>
        {(loaded) => (
          <>
            <text fg={palette.muted} attributes={HEADING}>
              Status
            </text>
            <text fg={palette.value}>{loaded().status.summary}</text>
            <Show when={loaded().status.recommendation !== ""}>
              <text fg={palette.muted}>{loaded().status.recommendation}</text>
            </Show>

            <text fg={palette.muted} attributes={HEADING}>
              Configuration
            </text>
            <For each={configRows(loaded().settings)}>
              {(row) => (
                <box flexDirection="row" gap={2}>
                  <text fg={palette.muted} width={LABEL_COLUMN}>
                    {row.label}
                  </text>
                  <text fg={palette.value}>{row.value}</text>
                </box>
              )}
            </For>
          </>
        )}
      </Show>

      <Show when={(data()?.sources ?? []).length > 0}>
        <text fg={palette.muted} attributes={HEADING}>
          Kilo sources
        </text>
        <For each={data()?.sources ?? []}>
          {(source) => (
            <box flexDirection="row" gap={2}>
              <text fg={palette.accent} width={2}>
                •
              </text>
              <text fg={palette.value}>{source.name}</text>
              <text fg={palette.muted}>{describeSource(source)}</text>
            </box>
          )}
        </For>
      </Show>

      <Show when={(data()?.workspaces.rows ?? []).length > 0}>
        <text fg={palette.muted} attributes={HEADING}>
          Indexed workspaces
        </text>
        <For each={data()?.workspaces.rows ?? []}>
          {(row) => (
            <box flexDirection="row" gap={2}>
              <text fg={row.root === null ? palette.error : palette.accent} width={2}>
                {row.root === null ? "?" : "•"}
              </text>
              <text fg={palette.value}>{describeRow(row)}</text>
            </box>
          )}
        </For>
        <Show when={(data()?.workspaces.unknownCount ?? 0) > 0}>
          <text fg={palette.muted}>
            Rows marked ? predate the registry, so their directory is unknown. Press e to forget one.
          </text>
        </Show>
      </Show>

      <text fg={palette.muted} attributes={HEADING}>
        Actions
      </text>
      <For each={PAGE_ROWS}>
        {(entry) => (
          // One element per text run, with the description appended to the title
          // string instead of mounted conditionally: mounting a child into an
          // already-laid-out column box left the description drawn over the title,
          // so the selected row showed mangled text and lost its title.
          <box
            flexDirection="row"
            gap={1}
            paddingLeft={1}
            backgroundColor={isSelected(entry.row) ? palette.selectedBg : undefined}
          >
            <text fg={isSelected(entry.row) ? palette.selectedFg : palette.muted}>
              {isSelected(entry.row) ? SELECTED_MARKER : UNSELECTED_MARKER}
            </text>
            <text fg={isSelected(entry.row) ? palette.selectedFg : palette.value}>
              {actionRowText(entry, isSelected(entry.row))}
            </text>
          </box>
        )}
      </For>

      <Show when={actionState().phase !== "idle"}>
        <text fg={palette.muted} attributes={HEADING}>
          Last action
        </text>
        <Show when={actionState().phase === "running"}>
          <text fg={palette.value}>{(actionState() as { label: string }).label}…</text>
        </Show>
        <Show when={actionState().phase === "done"}>
          <text fg={palette.success}>
            {(actionState() as { label: string }).label}: {(actionState() as { result: string }).result}
          </text>
        </Show>
        <Show when={actionState().phase === "error"}>
          <text fg={palette.error}>
            {(actionState() as { label: string }).label} failed:{" "}
            {(actionState() as { message: string }).message}
          </text>
        </Show>
      </Show>

      <text fg={palette.muted}>↑↓ move · enter run · e edit · r reload · esc close</text>
    </box>
  )
}
