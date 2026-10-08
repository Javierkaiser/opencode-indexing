/**
 * Selection state for the TUI settings page.
 *
 * The page is driven entirely by the host keymap (up/down/j/k, return, escape)
 * rather than by a `<select>` renderable: the select's height comes from the
 * layout pass, so inside an auto-sized box it collapses to a single invisible
 * row that still swallows keystrokes. Text rows plus an explicit selection
 * index are predictable and testable without a renderer.
 *
 * Pure and DOM-free, so `node --test` can cover the navigation rules.
 */

/** Commands the host keymap dispatches while the page is open. */
export type PageCommand = "up" | "down" | "run" | "edit" | "close" | "reload"

/** Keys bound to each command; the host resolves these names (enter → return). */
export const PAGE_KEYMAP: readonly { id: string; command: PageCommand; bind: string; title: string }[] = [
  { id: "opencode.indexing.page.up", command: "up", bind: "up", title: "Indexing: previous action" },
  { id: "opencode.indexing.page.down", command: "down", bind: "down", title: "Indexing: next action" },
  { id: "opencode.indexing.page.run", command: "run", bind: "return", title: "Indexing: run action" },
  { id: "opencode.indexing.page.edit", command: "edit", bind: "e", title: "Indexing: edit settings" },
  { id: "opencode.indexing.page.reload", command: "reload", bind: "r", title: "Indexing: reload status" },
  { id: "opencode.indexing.page.close", command: "close", bind: "escape", title: "Indexing: close page" },
]

export class SettingsPageStore {
  private indexValue = 0
  private listeners = new Set<() => void>()
  private pending: PageCommand | null = null
  private readonly size: number

  /** @param size number of navigable rows (actions plus any extra row). */
  constructor(size: number) {
    this.size = size
  }

  get index(): number {
    return this.indexValue
  }

  /** Registers a listener; returns the unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Applies a command. Navigation moves the selection and notifies; the other
   * commands are recorded for the page to consume via `takeCommand`, which keeps
   * RPC work inside the component that owns the client.
   */
  dispatch = (command: PageCommand): void => {
    if (this.size <= 0) return
    if (command === "up" || command === "down") {
      const step = command === "up" ? -1 : 1
      const next = (this.indexValue + step + this.size) % this.size
      this.indexValue = next
      this.pending = null
      this.notify()
      return
    }
    this.pending = command
    this.notify()
  }

  /** Returns and clears the pending command; the page calls this on notify. */
  takeCommand = (): PageCommand | null => {
    const command = this.pending
    this.pending = null
    return command
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
