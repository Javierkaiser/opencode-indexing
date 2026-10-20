/**
 * The plugin's only door to the host runtime.
 *
 * WHY THE VIRTUAL SPECIFIERS
 *
 * Installed from npm, this plugin lives under node_modules, where the host's
 * JSX transform does not reach it: a bare `solid-js` or `@opentui/*` import
 * resolves to the plugin's own copy instead of the one the host renders with.
 * Two Solid instances mean two reactive graphs, so signals created by the
 * plugin never reach the host renderer and the UI freezes
 * (upstream anomalyco/opencode#33884).
 *
 * The host exposes its own runtime as `opentui:runtime-module:*` specifiers,
 * which is what keeps the singletons shared. The typechecker cannot resolve
 * those; `tui/virtual-modules.d.ts` maps each one back to its package.
 *
 * Every virtual specifier in the plugin must stay in this file: if a host
 * build renames the scheme, this module is the only one that has to change.
 */
export {
  For,
  Show,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "opentui:runtime-module:solid-js"

export type {
  Accessor,
  Resource,
  ResourceReturn,
  Setter,
} from "opentui:runtime-module:solid-js"

/** Return types of the views; the JSX namespace lives in the renderer. */
export type { JSX } from "opentui:runtime-module:%40opentui%2Fsolid"

// `Fragment` is the compiler's `<>…</>`: a component, not an element, so it
// travels with the JSX runtime rather than with the Solid primitives.
export { Fragment, jsx, jsxs } from "opentui:runtime-module:%40opentui%2Fsolid%2Fjsx-runtime"

export { createTextAttributes } from "opentui:runtime-module:%40opentui%2Fcore"
