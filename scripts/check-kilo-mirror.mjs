/**
 * Drift monitor for the embedding model catalog mirrored from Kilo Code.
 *
 * `src/registry.ts` is a hand-maintained copy of Kilo's
 * `packages/kilo-indexing/src/indexing/model-registry.ts`, and the copy is the
 * compatibility contract: an import is accepted only when provider, model id and
 * dimension match, so an entry that drifts makes every index built with it
 * un-importable, silently. This script fetches Kilo's registry and compares it
 * with ours.
 *
 * Exit codes, deliberately distinct: 0 clean, 1 drift, 2 the check itself could
 * not run (network, HTTP, parse). A weekly scheduled job must never report an
 * outage as drift.
 *
 * Parsing uses the TypeScript compiler API that ships in this repo's `typescript`
 * dependency (v7): its public AST entry point exposes `createScanner`, not
 * `createSourceFile`, so the object literals are read from the token stream.
 * Only the subset the registries use is supported: object literals, arrays of
 * literals, strings, numbers, booleans, null. Anything else is an error, never a
 * guess.
 */
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast"

export const UPSTREAM_REGISTRY_URL =
  "https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-indexing/src/indexing/model-registry.ts"
export const UPSTREAM_CONSTANTS_URL =
  "https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-indexing/src/indexing/constants/index.ts"

/** Providers this plugin has an adapter for, mirroring VALID_PROVIDERS in src/config.ts. */
export const SUPPORTED_PROVIDERS = Object.freeze([
  "local",
  "mistral",
  "openai",
  "ollama",
  "openai-compatible",
  "gemini",
  "voyage",
  "openrouter",
])

/** `resolveSettings`' fallback when no vector store is configured (src/config.ts:192). */
export const OUR_VECTOR_STORE = "lancedb"

// ---- Reading const initializers from source ----

function tokenize(text) {
  const scanner = createScanner(true, LanguageVariant.Standard, text)
  const tokens = []
  for (;;) {
    const kind = scanner.scan()
    tokens.push({ kind, text: scanner.getTokenText(), value: scanner.getTokenValue(), pos: scanner.getTokenStart() })
    if (kind === SyntaxKind.EndOfFile) return tokens
  }
}

function lineOf(text, pos) {
  let line = 1
  for (let index = 0; index < pos && index < text.length; index++) if (text[index] === "\n") line++
  return line
}

function describeToken(token, text) {
  if (!token || token.kind === SyntaxKind.EndOfFile) return "end of file"
  return `"${token.text}" at line ${lineOf(text, token.pos)}`
}

/**
 * Index of the token right after the `=` of `const <name> ... =`, skipping an
 * optional type annotation first. Throws when the declaration has no initializer
 * or the file ends inside the annotation.
 */
function findInitializer(tokens, name, text) {
  for (let index = 0; index < tokens.length - 1; index++) {
    if (tokens[index].kind !== SyntaxKind.ConstKeyword) continue
    const identifier = tokens[index + 1]
    if (identifier.kind !== SyntaxKind.Identifier || identifier.text !== name) continue

    let round = 0
    let square = 0
    let curly = 0
    let angle = 0
    for (let cursor = index + 2; cursor < tokens.length; cursor++) {
      const kind = tokens[cursor].kind
      if (kind === SyntaxKind.EqualsToken && round + square + curly + angle === 0) {
        // `=>` in a function type is not the assignment.
        if (tokens[cursor + 1]?.kind === SyntaxKind.GreaterThanToken) {
          cursor++
          continue
        }
        return cursor + 1
      }
      if (kind === SyntaxKind.OpenParenToken) round++
      else if (kind === SyntaxKind.CloseParenToken) round--
      else if (kind === SyntaxKind.OpenBracketToken) square++
      else if (kind === SyntaxKind.CloseBracketToken) square--
      else if (kind === SyntaxKind.OpenBraceToken) curly++
      else if (kind === SyntaxKind.CloseBraceToken) curly--
      else if (kind === SyntaxKind.LessThanToken) angle++
      else if (kind === SyntaxKind.GreaterThanToken && angle > 0) angle--
      else if (kind === SyntaxKind.SemicolonToken && round + square + curly + angle === 0) break
      else if (kind === SyntaxKind.EndOfFile) break
    }
    throw new Error(`cannot find the "=" of "const ${name}" (${describeToken(tokens[index], text)})`)
  }
  throw new Error(`no top-level "const ${name} = ..." declaration found`)
}

function readPropertyName(tokens, cursor, text, label) {
  const token = tokens[cursor]
  if (token.kind === SyntaxKind.Identifier) return [token.text, cursor + 1]
  if (token.kind === SyntaxKind.StringLiteral) return [token.value, cursor + 1]
  if (token.kind === SyntaxKind.NumericLiteral) return [token.value, cursor + 1]
  throw new Error(`${label}: unsupported property name ${describeToken(token, text)}`)
}

function readValue(tokens, cursor, text, label) {
  const token = tokens[cursor]
  switch (token.kind) {
    case SyntaxKind.OpenBraceToken:
      return readObject(tokens, cursor, text, label)
    case SyntaxKind.OpenBracketToken:
      return readArray(tokens, cursor, text, label)
    case SyntaxKind.StringLiteral:
      return [token.value, cursor + 1]
    case SyntaxKind.NumericLiteral:
      return [Number(token.value), cursor + 1]
    case SyntaxKind.MinusToken: {
      const next = tokens[cursor + 1]
      if (next?.kind !== SyntaxKind.NumericLiteral) {
        throw new Error(`${label}: unsupported unary minus applied to ${describeToken(next ?? token, text)}`)
      }
      return [-Number(next.value), cursor + 2]
    }
    case SyntaxKind.TrueKeyword:
      return [true, cursor + 1]
    case SyntaxKind.FalseKeyword:
      return [false, cursor + 1]
    case SyntaxKind.NullKeyword:
      return [null, cursor + 1]
    case SyntaxKind.Identifier:
      if (token.text === "undefined") return [undefined, cursor + 1]
      throw new Error(`${label}: unsupported reference ${describeToken(token, text)}; only literals are read`)
    default:
      throw new Error(`${label}: unsupported value ${describeToken(token, text)}`)
  }
}

function readObject(tokens, cursor, text, label) {
  const result = {}
  cursor++
  for (;;) {
    const token = tokens[cursor]
    if (token.kind === SyntaxKind.CloseBraceToken) return [result, cursor + 1]
    const [key, afterKey] = readPropertyName(tokens, cursor, text, label)
    cursor = afterKey
    if (tokens[cursor]?.kind !== SyntaxKind.ColonToken) {
      throw new Error(`${label}: expected ":" after property "${key}", found ${describeToken(tokens[cursor], text)}`)
    }
    const [value, afterValue] = readValue(tokens, cursor + 1, text, label)
    // defineProperty keeps a literal "__proto__" key a plain key instead of
    // reaching the prototype setter.
    Object.defineProperty(result, String(key), { value, enumerable: true, writable: true, configurable: true })
    cursor = afterValue
    if (tokens[cursor]?.kind === SyntaxKind.CommaToken) {
      cursor++
      continue
    }
    if (tokens[cursor]?.kind === SyntaxKind.CloseBraceToken) return [result, cursor + 1]
    throw new Error(`${label}: expected "," or "}" after property "${key}", found ${describeToken(tokens[cursor], text)}`)
  }
}

function readArray(tokens, cursor, text, label) {
  const result = []
  cursor++
  for (;;) {
    if (tokens[cursor]?.kind === SyntaxKind.CloseBracketToken) return [result, cursor + 1]
    const [value, afterValue] = readValue(tokens, cursor, text, label)
    result.push(value)
    cursor = afterValue
    if (tokens[cursor]?.kind === SyntaxKind.CommaToken) {
      cursor++
      continue
    }
    if (tokens[cursor]?.kind === SyntaxKind.CloseBracketToken) return [result, cursor + 1]
    throw new Error(`${label}: expected "," or "]" in array, found ${describeToken(tokens[cursor], text)}`)
  }
}

/**
 * Read `const <name> = { ... }` (an optional type annotation is ignored) into a
 * plain object. Throws when the declaration is missing or uses anything beyond
 * literals, because a half-read registry would compare as drift.
 */
export function extractObject(text, name) {
  const tokens = tokenize(text)
  const label = `const ${name}`
  const cursor = findInitializer(tokens, name, text)
  if (tokens[cursor]?.kind !== SyntaxKind.OpenBraceToken) {
    throw new Error(`${label} is initialized with ${describeToken(tokens[cursor], text)}, not an object literal`)
  }
  return readObject(tokens, cursor, text, label)[0]
}

/** Read `const <name> = "value"` (a trailing `as const` is ignored). */
export function extractStringConstant(text, name) {
  const tokens = tokenize(text)
  const cursor = findInitializer(tokens, name, text)
  const token = tokens[cursor]
  if (token?.kind !== SyntaxKind.StringLiteral) {
    throw new Error(`const ${name} is ${describeToken(token, text)}, not a string literal`)
  }
  return token.value
}

// ---- Comparing the catalogs ----

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireRegistry(registry, side) {
  if (!isRecord(registry) || !isRecord(registry.profiles)) {
    throw new TypeError(`compareRegistry: ${side} registry has no profiles object`)
  }
  if (registry.defaults !== undefined && !isRecord(registry.defaults)) {
    throw new TypeError(`compareRegistry: ${side} registry has a non-object defaults`)
  }
}

function modelEntries(registry, provider, side) {
  const models = registry.profiles[provider]
  if (models === undefined) return undefined
  if (!isRecord(models)) throw new TypeError(`compareRegistry: ${side} profiles.${provider} is not an object`)
  for (const [modelId, profile] of Object.entries(models)) {
    if (!isRecord(profile)) {
      throw new TypeError(`compareRegistry: ${side} profiles.${provider}["${modelId}"] is not an object`)
    }
  }
  return models
}

/**
 * Diff Kilo's registry against ours.
 *
 * `upstream` is Kilo (`profiles`, `defaults`, optional `vectorStore`); `ours` is
 * src/registry.ts in the same shape. Only providers in SUPPORTED_PROVIDERS are
 * compared; anything else Kilo adds is reported as unsupported, not as drift,
 * because having no adapter is a decision, not a mismatch.
 *
 * Models we add ourselves (`kiloMirror: false`) are allowed; a model we claim to
 * mirror but Kilo does not have is not.
 */
export function compareRegistry(upstream, ours, options = {}) {
  requireRegistry(upstream, "upstream")
  requireRegistry(ours, "ours")

  const supported = options.supportedProviders ?? SUPPORTED_PROVIDERS
  const ourVectorStore = options.ourVectorStore ?? ours.vectorStore ?? OUR_VECTOR_STORE
  const upstreamDefaults = upstream.defaults ?? {}
  const ownDefaults = ours.defaults ?? {}

  const missingProviders = []
  const missingModels = []
  const extraModels = []
  const dimensionMismatches = []
  const queryPrefixMismatches = []
  const scoreThresholdMismatches = []
  const defaultModelMismatches = []
  let providers = 0
  let models = 0

  const providersToCheck = supported.filter(
    (provider) => upstream.profiles[provider] !== undefined || ours.profiles[provider] !== undefined,
  )

  for (const provider of providersToCheck) {
    const upstreamModels = modelEntries(upstream, provider, "upstream")
    const ownModels = modelEntries(ours, provider, "ours")

    if (upstreamModels !== undefined && ownModels === undefined) {
      missingProviders.push({ provider, models: Object.keys(upstreamModels) })
      continue
    }

    providers++
    for (const [modelId, kiloProfile] of Object.entries(upstreamModels ?? {})) {
      const ownProfile = ownModels?.[modelId]
      if (ownProfile === undefined) {
        missingModels.push({ provider, modelId, dimension: kiloProfile.dimension })
        continue
      }
      models++
      if (kiloProfile.dimension !== ownProfile.dimension) {
        dimensionMismatches.push({ provider, modelId, upstream: kiloProfile.dimension, ours: ownProfile.dimension })
      }
      if ((kiloProfile.queryPrefix ?? null) !== (ownProfile.queryPrefix ?? null)) {
        queryPrefixMismatches.push({
          provider,
          modelId,
          upstream: kiloProfile.queryPrefix ?? null,
          ours: ownProfile.queryPrefix ?? null,
        })
      }
      if ((kiloProfile.scoreThreshold ?? null) !== (ownProfile.scoreThreshold ?? null)) {
        scoreThresholdMismatches.push({
          provider,
          modelId,
          upstream: kiloProfile.scoreThreshold ?? null,
          ours: ownProfile.scoreThreshold ?? null,
        })
      }
    }

    for (const [modelId, ownProfile] of Object.entries(ownModels ?? {})) {
      if (upstreamModels?.[modelId] !== undefined) continue
      if (ownProfile.kiloMirror === false) continue
      extraModels.push({ provider, modelId, dimension: ownProfile.dimension })
    }
  }

  for (const provider of Object.keys(upstreamDefaults)) {
    if (!supported.includes(provider)) continue
    const kiloDefault = upstreamDefaults[provider] ?? ""
    const ownDefault = ownDefaults[provider] ?? ""
    if (kiloDefault !== ownDefault) {
      defaultModelMismatches.push({ provider, upstream: kiloDefault, ours: ownDefault })
    }
  }

  // `kilo` has a default but no local profiles (its catalog lives in Kilo's
  // service), so the union of both maps is what Kilo actually knows about.
  const unsupported = [...new Set([...Object.keys(upstream.profiles), ...Object.keys(upstreamDefaults)])]
    .filter((provider) => !supported.includes(provider))
    .sort()
    .map((provider) => ({ provider, models: Object.keys(upstream.profiles[provider] ?? {}).length }))

  let vectorStore = null
  if (typeof upstream.vectorStore === "string") {
    vectorStore = { upstream: upstream.vectorStore, ours: ourVectorStore, ok: upstream.vectorStore === ourVectorStore }
  }

  const ok =
    missingProviders.length === 0 &&
    missingModels.length === 0 &&
    extraModels.length === 0 &&
    dimensionMismatches.length === 0 &&
    queryPrefixMismatches.length === 0 &&
    scoreThresholdMismatches.length === 0 &&
    defaultModelMismatches.length === 0 &&
    (vectorStore?.ok ?? true)

  return {
    ok,
    counts: { providers, models },
    providers: { missing: missingProviders, unsupported },
    missingModels,
    extraModels,
    dimensionMismatches,
    queryPrefixMismatches,
    scoreThresholdMismatches,
    defaultModelMismatches,
    vectorStore,
  }
}

// ---- Report and entry point ----

function quoted(value) {
  return value === null || value === undefined || value === "" ? "(none)" : JSON.stringify(value)
}

function formatReport(diff) {
  const lines = []
  if (diff.ok) {
    lines.push(`Kilo registry matches (${diff.counts.providers} providers, ${diff.counts.models} mirrored models)`)
  } else {
    lines.push(`Kilo registry drift detected against ${UPSTREAM_REGISTRY_URL}`)
    for (const entry of diff.providers.missing) {
      lines.push(`  missing provider      ${entry.provider} (${entry.models.length} models in Kilo)`)
    }
    for (const entry of diff.missingModels) {
      lines.push(`  missing model         ${entry.provider}/${entry.modelId} (${entry.dimension}d)`)
    }
    for (const entry of diff.extraModels) {
      lines.push(`  extra mirrored model  ${entry.provider}/${entry.modelId} (${entry.dimension}d, not in Kilo)`)
    }
    for (const entry of diff.dimensionMismatches) {
      lines.push(`  dimension             ${entry.provider}/${entry.modelId}: Kilo ${entry.upstream}, ours ${entry.ours}`)
    }
    for (const entry of diff.queryPrefixMismatches) {
      lines.push(
        `  query prefix          ${entry.provider}/${entry.modelId}: Kilo ${quoted(entry.upstream)}, ours ${quoted(entry.ours)}`,
      )
    }
    for (const entry of diff.scoreThresholdMismatches) {
      lines.push(
        `  score threshold       ${entry.provider}/${entry.modelId}: Kilo ${quoted(entry.upstream)}, ours ${quoted(entry.ours)}`,
      )
    }
    for (const entry of diff.defaultModelMismatches) {
      lines.push(`  default model         ${entry.provider}: Kilo ${quoted(entry.upstream)}, ours ${quoted(entry.ours)}`)
    }
    if (diff.vectorStore && !diff.vectorStore.ok) {
      lines.push(
        `  vector store default  Kilo ${quoted(diff.vectorStore.upstream)}, ours ${quoted(diff.vectorStore.ours)}`,
      )
    }
  }
  if (diff.providers.unsupported.length > 0) {
    const list = diff.providers.unsupported.map((entry) => `${entry.provider} (${entry.models})`).join(", ")
    lines.push(`note: Kilo providers with no adapter here, not mirrored: ${list}`)
  }
  return lines.join("\n")
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "opencode-indexing kilo-drift check" },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`${url} responded ${response.status} ${response.statusText}`)
  return response.text()
}

async function check() {
  const [registryText, constantsText, ownText] = await Promise.all([
    fetchText(UPSTREAM_REGISTRY_URL),
    fetchText(UPSTREAM_CONSTANTS_URL),
    readFile(new URL("../src/registry.ts", import.meta.url), "utf8"),
  ])

  const upstream = {
    profiles: extractObject(registryText, "profiles"),
    defaults: extractObject(registryText, "defaults"),
    vectorStore: extractStringConstant(constantsText, "DEFAULT_VECTOR_STORE"),
  }
  const ours = {
    profiles: extractObject(ownText, "profiles"),
    defaults: extractObject(ownText, "defaults"),
  }

  const diff = compareRegistry(upstream, ours, { ourVectorStore: OUR_VECTOR_STORE })
  console.log(formatReport(diff))
  return diff.ok ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await check()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : ""
    console.error(`kilo-mirror: could not complete the check, so this is not a drift verdict: ${message}${cause}`)
    process.exitCode = 2
  }
}
