/**
 * Type mappings for the host's runtime specifiers.
 *
 * At runtime the host resolves `opentui:runtime-module:*` to the exact modules
 * it is running (see `tui/host-runtime.ts` for why that matters); TypeScript
 * cannot follow them, so each specifier re-exports the package that provides
 * its types. A host build that renames the scheme needs this file and
 * `tui/host-runtime.ts` updated together.
 *
 * Deliberately a global script: `declare module` declares ambient modules
 * here, and a top-level import or export would turn this file into a module
 * and silently change their meaning.
 */

declare module "opentui:runtime-module:solid-js" {
  export * from "solid-js"
}

declare module "opentui:runtime-module:solid-js%2Fstore" {
  export * from "solid-js/store"
}

declare module "opentui:runtime-module:%40opentui%2Fsolid" {
  export * from "@opentui/solid"
}

declare module "opentui:runtime-module:%40opentui%2Fsolid%2Fjsx-runtime" {
  export * from "@opentui/solid/jsx-runtime"
}

declare module "opentui:runtime-module:%40opentui%2Fsolid%2Fjsx-dev-runtime" {
  export * from "@opentui/solid/jsx-dev-runtime"
}

declare module "opentui:runtime-module:%40opentui%2Fcore" {
  export * from "@opentui/core"
}
