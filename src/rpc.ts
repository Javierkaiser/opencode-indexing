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

/**
 * Input schema for a method whose only argument is the caller's workspace.
 *
 * Exists so `kilo.discover` and `settings.test` cannot be written as a bare
 * `directoryShape`: that is a fragment of `properties`, not a schema, and a
 * validator reading it as one sees no `directory` at all — silently answering
 * about the service's own workspace again.
 */
const workspaceInputShape = {
  type: "object",
  properties: { ...directoryShape },
  additionalProperties: false,
} as const

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
    searchKilo: { type: "boolean" },
    autoRefresh: { type: "boolean" },
    enabled: { type: "boolean" },
    codegraph: { type: "boolean" },
    searchMaxResults: { type: "number" },
    searchMinScore: { type: ["number", "null"] },
    embeddingBatchSize: { type: "number" },
    fileExtensions: { type: "array", items: { type: "string" } },
    kiloVectorStore: { type: ["string", "null"] },
    configuredProviders: { type: "array", items: { type: "string" } },
    settingsFile: { type: "string" },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: ["vectorStore", "qdrantUrl", "provider", "importFromKilo", "settingsFile"],
  additionalProperties: true,
} as const

export const IndexingRpc = {
  id: "javierkaiser.indexing",
  methods: {
    "settings.get": {
      input: empty,
      // `version` names the release answering the call ("unknown" when its
      // manifest could not be read); it rides along so the UI needs no extra call.
      output: {
        type: "object",
        properties: { settings: settingsShape, version: { type: "string" } },
        required: ["settings"],
        additionalProperties: true,
      },
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
      output: {
        type: "object",
        properties: { settings: settingsShape, version: { type: "string" } },
        required: ["settings"],
        additionalProperties: true,
      },
    },
    /**
     * One validated setting, by the same rules as `/indexing-config set`.
     *
     * The UI does not send raw patches: a typo would otherwise be written and
     * only discovered when the next build failed. Credentials are refused here
     * and have their own method.
     */
    "settings.apply": {
      input: {
        type: "object",
        properties: { key: { type: "string" }, value: { type: "string" } },
        required: ["key", "value"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          error: { type: "string" },
          display: { type: "string" },
          settings: settingsShape,
          version: { type: "string" },
        },
        required: ["ok"],
        additionalProperties: true,
      },
    },
    /**
     * A credential typed by the user in a settings surface.
     *
     * Separate from `settings.apply` on purpose: the chat tool refuses secrets,
     * and a distinct method keeps that exception visible instead of hiding it
     * behind a key name in a generic patch.
     */
    "settings.credential": {
      input: {
        type: "object",
        properties: { provider: { type: "string" }, value: { type: "string" } },
        required: ["provider", "value"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          error: { type: "string" },
          display: { type: "string" },
          settings: settingsShape,
          version: { type: "string" },
        },
        required: ["ok"],
        additionalProperties: true,
      },
    },
    /**
     * The model catalog, served instead of imported.
     *
     * `src/registry.ts` imports `node:crypto`, so the GUI bundle cannot import
     * it: the renderer has no Node built-ins. The server answers with plain
     * JSON and the UI never needs the module.
     */
    "catalog.get": {
      input: empty,
      output: {
        type: "object",
        properties: {
          providers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                defaultModel: { type: "string" },
                liveTested: { type: "boolean" },
                models: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      dimension: { type: ["number", "null"] },
                      kiloMirrored: { type: "boolean" },
                    },
                    required: ["id", "kiloMirrored"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["id", "defaultModel", "liveTested", "models"],
              additionalProperties: false,
            },
          },
        },
        required: ["providers"],
        additionalProperties: false,
      },
    },
    "settings.test": {
      input: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["qdrant", "lancedb", "provider", "kilo"] },
          // Only `kilo` is workspace-scoped; the other targets describe global
          // backends. Sending it costs nothing and keeps one shape for the client.
          ...directoryShape,
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
      input: workspaceInputShape,
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
          /**
           * Sources that exist but could not be read, in plain language.
           *
           * Without this the only thing a caller can say when the list is empty
           * is "not found", which is a different statement from "found, and the
           * read failed" — and the second one is the one that needs acting on.
           */
          problems: { type: "array", items: { type: "string" } },
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
          /**
           * Whether the store holding the own index could be read at all.
           *
           * A stopped Qdrant and a workspace that was never indexed both yield
           * null points; the footer reads this to tell "empty" from "could not
           * look", so the contract has to declare it rather than leave it as an
           * undeclared extra field.
           */
          ownStoreReachable: { type: "boolean" },
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
      output: { type: "object", properties: { summary: { type: "string" }, error: { type: "string" } }, required: ["summary"], additionalProperties: true },
    },
    "index.refresh": {
      input: { type: "object", properties: { maxFiles: { type: "number" }, ...directoryShape }, additionalProperties: false },
      output: { type: "object", properties: { summary: { type: "string" }, error: { type: "string" } }, required: ["summary"], additionalProperties: true },
    },
    "index.import": {
      // No `rebuild`: the handler reuses whatever own index exists and only
      // copies vectors into it. Declaring the flag invited callers to send it
      // and expect the own index to be dropped first, which never happened.
      input: {
        type: "object",
        properties: { source: { type: "string" }, ...directoryShape },
        additionalProperties: false,
      },
      output: { type: "object", properties: { summary: { type: "string" }, error: { type: "string" } }, required: ["summary"], additionalProperties: true },
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
          ok: { type: "boolean" },
          // Present only on failure: `refused` is a policy decision, `failed` an error.
          reason: { type: "string", enum: ["refused", "failed"] },
          summary: { type: "string" },
          pointsDeleted: { type: ["number", "null"] },
        },
        required: ["ok", "summary", "pointsDeleted"],
        additionalProperties: false,
      },
    },
  },
  events: {},
} as const satisfies Rpc.PortableDefinition

export type IndexingRpcDefinition = typeof IndexingRpc
