import assert from "node:assert/strict"
import { test } from "node:test"

import { VALID_PROVIDERS } from "../src/config.ts"
import { getDefaultModelId, getModelDimension, getModelProfile, isKiloMirrored, profileKey } from "../src/registry.ts"

/**
 * The catalog is a mirror of Kilo's model registry, and the mirror is the
 * compatibility contract: an import is accepted only when provider, model id
 * and dimension match byte for byte. An entry that drifts makes every index
 * built with it un-importable, silently, and it already happened once - our
 * openrouter Gemini entry said `google/gemini-embedding-001` where Kilo says
 * `google/gemini-embedding-2-preview`.
 *
 * This pins the mirrored set so drift has to be deliberate. It is a lockfile,
 * not a live check: update it when Kilo's registry changes.
 *
 * Source: packages/kilo-indexing/src/indexing/model-registry.ts, Kilo-Org/kilocode
 */

/** provider -> model id -> dimension, exactly as Kilo's registry defines them. */
const KILO_MIRROR: Record<string, Record<string, number>> = {
  openai: {
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    "text-embedding-ada-002": 1536,
  },
  ollama: {
    "nomic-embed-text": 768,
    "mxbai-embed-large": 1024,
    "all-minilm": 384,
  },
  gemini: {
    "gemini-embedding-001": 3072,
    "text-embedding-004": 768,
    "embedding-001": 768,
  },
  mistral: {
    "codestral-embed-2505": 1536,
    "codestral-embed": 1536,
    "mistral-embed": 1024,
  },
  voyage: {
    "voyage-code-3": 1024,
    "voyage-3": 1024,
    "voyage-3-lite": 512,
  },
  openrouter: {
    "openai/text-embedding-3-small": 1536,
    "openai/text-embedding-3-large": 3072,
    "google/gemini-embedding-2-preview": 3072,
  },
}

test("every model Kilo knows is present here with the same dimension", () => {
  for (const [provider, models] of Object.entries(KILO_MIRROR)) {
    for (const [modelId, dimension] of Object.entries(models)) {
      assert.equal(
        getModelDimension(provider as never, modelId),
        dimension,
        `${provider}/${modelId} must match Kilo at ${dimension} dimensions, or no index built with it can be imported`,
      )
      assert.equal(
        isKiloMirrored(provider as never, modelId),
        true,
        `${provider}/${modelId} comes from Kilo and must not be marked kiloMirror: false`,
      )
    }
  }
})

test("a model Kilo does not have is marked as ours", () => {
  // These cannot be imported from anywhere, and the status report relies on the
  // flag to say so rather than promising an import that will be refused.
  const ours: Array<[string, string]> = [
    ["voyage", "voyage-code-4"],
    ["voyage", "voyage-4-large"],
    ["voyage", "voyage-4"],
    ["voyage", "voyage-4-lite"],
    ["gemini", "gemini-embedding-2"],
    ["ollama", "bge-m3"],
    ["ollama", "nomic-embed-text:latest"],
  ]
  for (const [provider, modelId] of ours) {
    assert.equal(
      isKiloMirrored(provider as never, modelId),
      false,
      `${provider}/${modelId} is not in Kilo's registry and must say so`,
    )
  }
})

test("the openrouter Gemini entry names Kilo's id, not a plausible-looking one", () => {
  // The regression this whole file exists for.
  assert.equal(getModelDimension("openrouter", "google/gemini-embedding-2-preview"), 3072)
  assert.equal(
    getModelDimension("openrouter", "google/gemini-embedding-001"),
    undefined,
    "the id we used to carry is not one Kilo writes",
  )
})

test("every selectable provider has a default model and a resolvable dimension", () => {
  for (const provider of VALID_PROVIDERS) {
    const modelId = getDefaultModelId(provider)
    if (provider === "openai-compatible") {
      // No default is correct: the endpoint is the user's, so its models are
      // unknowable here and the dimension is probed on first use.
      assert.equal(modelId, "")
      continue
    }
    assert.ok(modelId, `${provider} is selectable but has no default model`)
    assert.ok(
      (getModelDimension(provider, modelId) ?? 0) > 0,
      `${provider}'s default model ${modelId} has no known dimension`,
    )
  }
})

test("a provider with no catalog entry is not offered as selectable", () => {
  // Kilo also ships bedrock and vercel-ai-gateway. Neither is here, because
  // neither has an adapter; offering one would fail only once indexing started.
  for (const absent of ["bedrock", "vercel-ai-gateway"]) {
    assert.equal(
      (VALID_PROVIDERS as readonly string[]).includes(absent),
      false,
      `${absent} has no adapter and must not be selectable`,
    )
  }
})

test("profileKey is the identity used by every compatibility check", () => {
  // Three separate places compare profiles; two build the string and one
  // compares fields. They agree today and this pins the shape they agree on.
  assert.equal(profileKey({ provider: "mistral", modelId: "codestral-embed-2505", dimension: 1536 }), "mistral:codestral-embed-2505:1536")
  assert.notEqual(
    profileKey({ provider: "mistral", modelId: "codestral-embed-2505", dimension: 1536 }),
    profileKey({ provider: "mistral", modelId: "codestral-embed-2505", dimension: 1024 }),
    "the dimension is part of the identity, not decoration",
  )
})

test("input ceilings are documented per model, never assumed generous", () => {
  // The spread is the point: 512 to 32,000. A single global constant silently
  // truncates every chunk past the smallest model's limit.
  assert.equal(getModelProfile("ollama", "mxbai-embed-large")?.maxInputTokens, 512)
  assert.equal(getModelProfile("voyage", "voyage-code-4")?.maxInputTokens, 32_000)
  assert.equal(getModelProfile("gemini", "gemini-embedding-001")?.maxInputTokens, 2048)
})
