import type { Rpc } from "@opencode/plugin/rpc"

/**
 * Shared RPC contract between the server plugin and the TUI plugin.
 *
 * Definition object is plain JSON-Schema (portable), so the TUI can import it
 * without pulling any runtime dependency: `client.rpc(IndexingRpc)`.
 */

const empty = { type: "object", properties: {}, additionalProperties: false } as const

/**
 * Optional workspace the call is about.
 *
 * The server plugin is instantiated for the directory the service runs in, so a
 * caller working elsewhere (the TUI opened in another folder) must say which
 * workspace it means. Without this, the footer would report — and index — the
 * service's directory rather than the user's current one.
 */
const directoryShape = { directory: { type: "string" } } as const

const settingsShape = {
  type: "object",
  properties: {
    vectorStore: { type: "string", enum: ["qdrant", "lancedb"] },
    qdrantUrl: { type: "string" },
    qdrantApiKey: { type: "string" },
    lancedbDirectory: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    dimension: { type: "number" },
    importFromKilo: { type: "boolean" },
    autoRefresh: { type: "boolean" },
    searchMaxResults: { type: "number" },
    hasMistralKey: { type: "boolean" },
    hasOpenAiKey: { type: "boolean" },
    settingsFile: { type: "string" },
  },
  required: ["vectorStore", "qdrantUrl", "provider", "importFromKilo", "settingsFile"],
  additionalProperties: true,
} as const

export const IndexingRpc = {
  id: "opencode.indexing",
  methods: {
    "settings.get": {
      input: empty,
      output: { type: "object", properties: { settings: settingsShape }, required: ["settings"], additionalProperties: true },
    },
    "settings.set": {
      input: {
        type: "object",
        properties: {
          patch: { type: "object", additionalProperties: true },
        },
        required: ["patch"],
        additionalProperties: false,
      },
      output: { type: "object", properties: { settings: settingsShape }, required: ["settings"], additionalProperties: true },
    },
    "settings.test": {
      input: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["qdrant", "lancedb", "provider", "kilo"] },
        },
        required: ["target"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" }, message: { type: "string" } },
        required: ["ok", "message"],
        additionalProperties: false,
      },
    },
    "kilo.discover": {
      input: empty,
      output: {
        type: "object",
        properties: {
          sources: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string" },
                name: { type: "string" },
                pointsCount: { type: ["number", "null"] },
                complete: { type: ["boolean", "null"] },
                profile: { type: ["string", "null"] },
                compatible: { type: "boolean" },
              },
              required: ["kind", "name", "compatible"],
              additionalProperties: true,
            },
          },
        },
        required: ["sources"],
        additionalProperties: false,
      },
    },
    "status.get": {
      input: {
        type: "object",
        properties: { checkFreshness: { type: "boolean" }, ...directoryShape },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          summary: { type: "string" },
          ownKind: { type: "string" },
          ownStore: { type: "string" },
          ownPoints: { type: ["number", "null"] },
          ownComplete: { type: ["boolean", "null"] },
          kiloCollection: { type: ["string", "null"] },
          recommendation: { type: "string" },
          workspace: { type: "string" },
        },
        required: ["summary", "recommendation"],
        additionalProperties: true,
      },
    },
    "index.build": {
      input: {
        type: "object",
        properties: { rebuild: { type: "boolean" }, skipImport: { type: "boolean" }, ...directoryShape },
        additionalProperties: false,
      },
      output: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: true },
    },
    "index.refresh": {
      input: { type: "object", properties: { maxFiles: { type: "number" }, ...directoryShape }, additionalProperties: false },
      output: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: true },
    },
    "index.import": {
      input: {
        type: "object",
        properties: { source: { type: "string" }, rebuild: { type: "boolean" }, ...directoryShape },
        additionalProperties: false,
      },
      output: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: true },
    },
    "workspaces.list": {
      input: empty,
      output: {
        type: "object",
        properties: {
          workspaces: {
            type: "array",
            items: {
              type: "object",
              properties: {
                /** Collection name, e.g. `oc-1a06d5eeba99bff7`. */
                store: { type: "string" },
                /** Directory it belongs to, or null when the registry does not know it. */
                root: { type: ["string", "null"] },
                points: { type: ["number", "null"] },
                complete: { type: ["boolean", "null"] },
                profile: { type: ["string", "null"] },
                updatedAt: { type: ["string", "null"] },
                source: { type: "string", enum: ["registry", "collection"] },
              },
              required: ["store", "root", "points", "complete", "profile", "updatedAt", "source"],
              additionalProperties: false,
            },
          },
        },
        required: ["workspaces"],
        additionalProperties: false,
      },
    },
    "workspace.forget": {
      input: {
        type: "object",
        properties: { store: { type: "string" } },
        required: ["store"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          summary: { type: "string" },
          pointsDeleted: { type: ["number", "null"] },
        },
        required: ["summary", "pointsDeleted"],
        additionalProperties: false,
      },
    },
  },
  events: {},
} as const satisfies Rpc.PortableDefinition

export type IndexingRpcDefinition = typeof IndexingRpc
