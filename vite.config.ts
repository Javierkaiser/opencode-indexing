import { gui } from "@opencode/plugin/gui/vite"
import { defineConfig } from "vite"

/**
 * Builds the Desktop half: `src/gui.tsx` becomes the single CommonJS bundle
 * `dist/gui-experimental.cjs`, the file `./gui-experimental` exports.
 *
 * The SDK preset keeps the modules the app provides (Solid, `@opencode/*`) and
 * Node built-ins external, and fails the build on any other copy of them.
 */
export default defineConfig({ plugins: [gui()] })
