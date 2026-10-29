/**
 * The models the `local` provider can embed with.
 *
 * Two sources, on purpose:
 *
 *  - `bundled` ships inside a dependency (`mini-semantic-search` packs
 *    potion-base-8M to 128 dimensions at 4 bits, ~2 MB), so the English default
 *    works offline with no download and no setup.
 *  - `weights` downloads a Model2Vec model once from the Hugging Face Hub and
 *    caches it as int8 weights. The multilingual model is 512 MB on the Hub and
 *    128 MB once quantized, which is what makes it usable with no ONNX runtime
 *    and no service — the ONNX path measured ~870 MB of RSS for a 118 MB model.
 *
 * Revisions are pinned to a commit: the download is the model, so a branch
 * moving under us would silently change every vector in the index.
 */
export type LocalModelSource =
  | { kind: "bundled" }
  | {
      kind: "weights"
      repo: string
      revision: string
      /** Tensor inside the safetensors file, `[vocab, dims]`, fp32. */
      weights: string
      tokenizer: string
      tokenizerConfig: string
      config: string
    }

export interface LocalModelSpec {
  dimension: number
  source: LocalModelSource
}

export const LOCAL_MODELS = {
  "potion-base-8M-128d": {
    dimension: 128,
    source: { kind: "bundled" },
  },
  "potion-multilingual-128M": {
    dimension: 256,
    source: {
      kind: "weights",
      repo: "minishlab/potion-multilingual-128M",
      revision: "73908c3438cf03b6a01bcb9611d62b23d0726f08",
      weights: "embeddings",
      tokenizer: "tokenizer.json",
      tokenizerConfig: "tokenizer_config.json",
      config: "config.json",
    },
  },
} as const satisfies Record<string, LocalModelSpec>

export type LocalModelId = keyof typeof LOCAL_MODELS

export function localModelSpec(modelId: string): LocalModelSpec | undefined {
  return (LOCAL_MODELS as Record<string, LocalModelSpec>)[modelId]
}
