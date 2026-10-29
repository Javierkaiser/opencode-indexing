/**
 * Multilingual Model2Vec weights: download once, quantize, embed in process.
 *
 * Model2Vec stores one vector per token and a text's vector is the mean of its
 * tokens' vectors, normalised. There is no network to run and no ONNX session:
 * the model is a lookup table, so 128M parameters become a 128 MB int8 buffer
 * and a chunk costs a few hundred microseconds.
 *
 * The Hub publishes the weights as fp32 safetensors (512 MB). They are
 * quantized to int8 on the first load and the fp32 file is removed: the int8
 * form retrieves the same neighbours at a quarter of the memory, and holding
 * 512 MB resident for a search index is the opposite of "minimal impact".
 *
 * The tokenizer is Hugging Face's own WASM implementation (361 KB, no native
 * addon): the multilingual model uses an XLM-R tokenizer, which the bundled
 * English model's WordPiece implementation cannot produce.
 */
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { Tokenizer } from "@huggingface/tokenizers"

import type { LocalModelSpec } from "./models.ts"

/** Where downloaded models live: `$XDG_CACHE_HOME` or `~/.cache`. */
export function modelCacheDir(modelId: string, revision: string): string {
  const xdg = process.env.XDG_CACHE_HOME?.trim()
  const root = xdg && xdg.length > 0 ? xdg : join(homedir(), ".cache")
  return join(root, "opencode-indexing", "models", modelId, revision)
}

function resolveUrl(repo: string, revision: string, file: string): string {
  return `https://huggingface.co/${repo}/resolve/${revision}/${file}`
}

/**
 * Download `url` into `dest` unless it is already there.
 *
 * Streamed rather than buffered: the weights are 512 MB, and holding them twice
 * (network buffer plus file) is enough to matter on a 16 GB machine. A partial
 * transfer stays in `.part` and is discarded on the next attempt, which is
 * cheaper than resuming a file whose length the Hub does not promise.
 */
async function ensureFile(url: string, dest: string): Promise<void> {
  if (existsSync(dest) && statSync(dest).size > 0) return
  const part = `${dest}.part`
  mkdirSync(dirname(dest), { recursive: true })
  const response = await fetch(url)
  if (!response.ok) throw new Error(`local: HTTP ${response.status} downloading ${url}`)
  if (!response.body) throw new Error(`local: empty response downloading ${url}`)

  const file = createWriteStream(part)
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      if (!file.write(chunk)) await new Promise<void>((resolve) => file.once("drain", () => resolve()))
    }
    await new Promise<void>((resolve, reject) => file.end((error?: Error | null) => (error ? reject(error) : resolve())))
    renameSync(part, dest)
  } catch (error) {
    rmSync(part, { force: true })
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/** Download an optional companion file; absence is not an error. */
async function ensureOptional(url: string, dest: string): Promise<boolean> {
  try {
    await ensureFile(url, dest)
    return true
  } catch {
    return false
  }
}

/** One tensor read out of a safetensors file. */
export interface SafetensorsTensor {
  rows: number
  cols: number
  values: Float32Array
}

/**
 * Read one fp32 tensor from a safetensors file.
 *
 * The format is an 8-byte little-endian header length, a JSON header with each
 * tensor's dtype, shape and byte range, then the data. Only what this plugin
 * needs is parsed: one two-dimensional fp32 tensor.
 */
export function readSafetensorsTensor(path: string, name: string): SafetensorsTensor {
  const fd = openSync(path, "r")
  try {
    const lengthBytes = Buffer.alloc(8)
    readSync(fd, lengthBytes, 0, 8, 0)
    const headerLength = Number(lengthBytes.readBigUInt64LE(0))
    if (!Number.isFinite(headerLength) || headerLength <= 0) {
      throw new Error(`local: ${path} is not a safetensors file (bad header length)`)
    }
    const headerBytes = Buffer.alloc(headerLength)
    readSync(fd, headerBytes, 0, headerLength, 8)
    const header = JSON.parse(headerBytes.toString("utf8")) as Record<
      string,
      { dtype?: string; shape?: number[]; data_offsets?: [number, number] }
    >
    const tensor = header[name]
    if (!tensor) throw new Error(`local: ${path} has no "${name}" tensor`)
    if (tensor.dtype !== "F32") throw new Error(`local: "${name}" is ${tensor.dtype}, expected F32`)
    const shape = tensor.shape ?? []
    const offsets = tensor.data_offsets
    if (shape.length !== 2 || !offsets) throw new Error(`local: "${name}" must be a 2-D tensor`)

    const [rows, cols] = shape as [number, number]
    const [start, end] = offsets
    const bytes = Buffer.alloc(end - start)
    readSync(fd, bytes, 0, bytes.length, 8 + headerLength + start)
    // The Buffer owns an ArrayBuffer that may be larger than the view; both the
    // offset and the length have to be carried into the Float32Array.
    return { rows, cols, values: new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4)) }
  } finally {
    closeSync(fd)
  }
}

/**
 * Symmetric int8 quantization, one scale per token row.
 *
 * A single scale for the whole table is dominated by the largest value in it
 * (5.7 here against a mean of 0.25), and every row whose values are small — the
 * frequent, low-information tokens — rounds to zero. Measured on this model that
 * put the cosine of some rows at 0; per-row scales keep it at 0.9998 or better
 * for 2 MB of extra scales.
 */
export interface QuantizedTensor {
  rows: number
  cols: number
  data: Int8Array
  scales: Float32Array
}

export function quantizeInt8(tensor: SafetensorsTensor): QuantizedTensor {
  const { rows, cols, values } = tensor
  const data = new Int8Array(rows * cols)
  const scales = new Float32Array(rows)

  for (let row = 0; row < rows; row += 1) {
    const offset = row * cols
    let maxAbs = 0
    for (let d = 0; d < cols; d += 1) {
      const magnitude = Math.abs(values[offset + d]!)
      if (magnitude > maxAbs) maxAbs = magnitude
    }
    const scale = maxAbs > 0 ? maxAbs / 127 : 1
    scales[row] = scale
    for (let d = 0; d < cols; d += 1) {
      const quantized = Math.round(values[offset + d]! / scale)
      data[offset + d] = quantized > 127 ? 127 : quantized < -127 ? -127 : quantized
    }
  }

  return { rows, cols, data, scales }
}

/** Mean over the tokens, normalised to unit length (the model's contract). */
export function meanNormalize(sum: Float32Array, count: number): Float32Array {
  if (count <= 0) return sum
  let norm = 0
  for (let index = 0; index < sum.length; index += 1) {
    sum[index] = sum[index]! / count
    norm += sum[index]! * sum[index]!
  }
  norm = Math.sqrt(norm)
  if (norm === 0) return sum
  for (let index = 0; index < sum.length; index += 1) sum[index] = sum[index]! / norm
  return sum
}

/** Drop the loaded model so an idle process stops paying for its weights. */
export function releaseWeightsModel(modelId: string): void {
  loaded.delete(modelId)
}

/** What the embedder needs from a weights-backed model. */
export interface WeightsModel {
  dimension: number
  embed(text: string): Float32Array
}

interface WeightsMeta {
  rows: number
  cols: number
}

const loaded = new Map<string, Promise<WeightsModel>>()

/**
 * Load (and cache) the multilingual model.
 *
 * The first call downloads ~512 MB and quantizes them; later calls read the
 * 128 MB int8 file and skip the network entirely. Loaded once per process: the
 * buffer is read-only and shared by every embedder instance.
 */
export function loadWeightsModel(modelId: string, spec: LocalModelSpec): Promise<WeightsModel> {
  const source = spec.source
  if (source.kind !== "weights") return Promise.reject(new Error(`local: ${modelId} is not a weights model`))

  let pending = loaded.get(modelId)
  if (pending) return pending

  pending = (async () => {
    const dir = modelCacheDir(modelId, source.revision)
    const int8Path = join(dir, "embeddings.int8")
    const scalesPath = join(dir, "scales.f32")
    const metaPath = join(dir, "embeddings.json")
    const tokenizerPath = join(dir, "tokenizer.json")
    const tokenizerConfigPath = join(dir, "tokenizer_config.json")
    const configPath = join(dir, "config.json")

    await Promise.all([
      ensureFile(resolveUrl(source.repo, source.revision, source.tokenizer), tokenizerPath),
      ensureOptional(resolveUrl(source.repo, source.revision, source.tokenizerConfig), tokenizerConfigPath),
      ensureFile(resolveUrl(source.repo, source.revision, source.config), configPath),
    ])

    let meta: WeightsMeta
    if (existsSync(int8Path) && existsSync(scalesPath) && existsSync(metaPath)) {
      meta = JSON.parse(readFileSync(metaPath, "utf8")) as WeightsMeta
    } else {
      const weightsPath = join(dir, "model.safetensors")
      await ensureFile(resolveUrl(source.repo, source.revision, "model.safetensors"), weightsPath)
      const quantized = quantizeInt8(readSafetensorsTensor(weightsPath, source.weights))
      writeFileSync(int8Path, Buffer.from(quantized.data.buffer, quantized.data.byteOffset, quantized.data.byteLength))
      writeFileSync(scalesPath, Buffer.from(quantized.scales.buffer, quantized.scales.byteOffset, quantized.scales.byteLength))
      meta = { rows: quantized.rows, cols: quantized.cols }
      writeFileSync(metaPath, JSON.stringify(meta), "utf8")
      // The fp32 file is 512 MB and never read again; the int8 buffer is the model.
      rmSync(weightsPath, { force: true })
    }

    const bytes = readFileSync(int8Path)
    const data = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const scaleBytes = readFileSync(scalesPath)
    const scales = new Float32Array(scaleBytes.buffer, scaleBytes.byteOffset, Math.floor(scaleBytes.byteLength / 4))

    const tokenizerJson = JSON.parse(readFileSync(tokenizerPath, "utf8")) as object
    const tokenizerConfig = existsSync(tokenizerConfigPath)
      ? (JSON.parse(readFileSync(tokenizerConfigPath, "utf8")) as object)
      : {}
    const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig)

    const { rows, cols } = meta
    return {
      dimension: cols,
      embed(text: string): Float32Array {
        const ids = tokenizer.encode(text).ids
        const sum = new Float32Array(cols)
        let count = 0
        for (const id of ids) {
          if (!Number.isInteger(id) || id < 0 || id >= rows) continue
          count += 1
          const offset = id * cols
          const scale = scales[id]!
          for (let d = 0; d < cols; d += 1) sum[d] += data[offset + d]! * scale
        }
        return meanNormalize(sum, count)
      },
    }
  })()

  pending.catch(() => loaded.delete(modelId))
  loaded.set(modelId, pending)
  return pending
}
