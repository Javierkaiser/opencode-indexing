/**
 * Mount logic for the JSX settings page (option B).
 *
 * Node cannot execute `settings-page.tsx`, so the page module is injected by
 * the caller. This keeps the decision logic — register the page, navigate to
 * it, or fall back to the dialog menu — unit-testable without a renderer or a
 * JSX runtime, which is exactly the situation the plugin has to survive when
 * the host does not provide `@opentui/solid`.
 */

import type { SettingsPageProps } from "./settings-page-data.ts"

/** Route name of the plugin page. Stable: referenced by navigate() and tests. */
export const SETTINGS_PAGE_NAME = "opencode-indexing-settings"

/** Structural type of the page component; the real one returns JSX.Element. */
export type SettingsPageComponent = (props: SettingsPageProps) => unknown

export interface SettingsPageModule {
  SettingsPage: SettingsPageComponent
}

/** Minimal shape of `ui.router` from the host context. */
export interface RouterLike {
  register: (page: {
    name: string
    render: (input: { data?: Record<string, unknown> }) => unknown
  }) => () => void
  navigate: (destination: { type: "plugin"; name: string; data?: Record<string, unknown> }) => void
}

export interface MountOptions {
  /** `context.ui.router`, or undefined on hosts without page support. */
  router: RouterLike | undefined
  /** Loads the JSX module; rejects when no JSX runtime is available. */
  load: () => Promise<SettingsPageModule>
  /** Props handed to the page component on every render. */
  props: SettingsPageProps
  /** Dialog menu used when the page cannot be mounted. */
  fallback: () => Promise<void>
  /**
   * Receives the unregister function returned by `router.register`.
   *
   * The caller must keep it: re-registering the same page name while a previous
   * registration is still live is rejected by the host, which silently degrades
   * every later open of the page to the dialog fallback.
   */
  onRegistered?: (dispose: () => void) => void
  /** Diagnostics for the failure that caused the fallback. */
  onError?: (error: unknown) => void
}

export type MountResult = "page" | "fallback"

/**
 * Registers the settings page and navigates to it.
 *
 * Returns "fallback" (after running `options.fallback`) whenever the rich page
 * is unavailable: no router on the host, the module failing to load because the
 * JSX runtime is unresolvable, a malformed module, or a rejected registration.
 * Never throws.
 */
export async function mountSettingsPage(options: MountOptions): Promise<MountResult> {
  const { router, load, props, onError, onRegistered } = options

  // The fallback is the last line of defence: if it also fails there is nothing
  // left to show, so swallow its error rather than reject into the keymap
  // dispatcher (an unhandled rejection there would take down the command).
  const runFallback = async (): Promise<MountResult> => {
    try {
      await options.fallback()
    } catch (error) {
      onError?.(error)
    }
    return "fallback"
  }

  let component: SettingsPageComponent | undefined
  try {
    component = (await load())?.SettingsPage
  } catch (error) {
    onError?.(error)
  }
  if (typeof component !== "function") return runFallback()

  try {
    if (!router || typeof router.register !== "function" || typeof router.navigate !== "function") {
      throw new Error("host UI has no router: cannot register a plugin page")
    }
    const dispose = router.register({
      name: SETTINGS_PAGE_NAME,
      render: () => component(props),
    })
    if (typeof dispose !== "function") {
      throw new Error("router.register did not return an unregister function")
    }
    try {
      router.navigate({ type: "plugin", name: SETTINGS_PAGE_NAME })
    } catch (error) {
      // Never leave a registration behind that nothing can reach.
      dispose()
      throw error
    }
    onRegistered?.(dispose)
    return "page"
  } catch (error) {
    onError?.(error)
    return runFallback()
  }
}
