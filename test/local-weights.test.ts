import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { LOCAL_MODELS, localModelSpec } from "../src/local/models.ts"
import { meanNormalize, quantizeInt8, readSafetensorsTensor } from "../src/local/weights.ts"

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * b[index]!
    na += a[index]! * a[index]!
    nb += b[index]! * b[index]!
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

function quantizedRow(values: Float32Array, row: number, cols: number) {
  const q = quantizeInt8({ rows: values.length / cols, cols, values })
  const offset = row * cols
  const out = new Float32Array(cols)
  for (let d = 0; d < cols; d += 1) out[d] = q.data[offset + d]! * q.scales[row]!
  return { q, out }
}

test("quantizeInt8: one scale per row, so a small row is not rounded away", () => {
  // The first row has an outlier at 5.7, the second is small everywhere. With a
  // single scale for the table (5.7/127) the second row would collapse to zero,
  // which is what the first implementation did and why retrieval got worse.
  const cols = 4
  const values = new Float32Array([
    5.7, 0.1, -0.05, 0.2, 0.02, -0.01, 0.03, -0.02,
  ])
  const q = quantizeInt8({ rows: 2, cols, values })

  assert.equal(q.scales.length, 2)
  assert.ok(q.scales[0]! > q.scales[1]!, "the outlier row needs the larger step")
  assert.ok(
    Array.from(q.data.slice(4, 8)).some((value) => value !== 0),
    "the small row must keep information",
  )

  const { out } = quantizedRow(values, 1, cols)
  assert.ok(cosine(values.slice(4, 8), out) > 0.99, "small row keeps its direction")
})

test("quantizeInt8: every non-zero row stays within a hair of the fp32 vector", () => {
  const cols = 8
  const values = new Float32Array(cols * 3)
  for (let index = 0; index < values.length; index += 1) values[index] = Math.sin(index) * (index % 5 === 0 ? 5 : 0.2)
  const q = quantizeInt8({ rows: 3, cols, values })
  for (let row = 0; row < 3; row += 1) {
    const { out } = quantizedRow(values, row, cols)
    assert.ok(cosine(values.slice(row * cols, (row + 1) * cols), out) > 0.999, `row ${row}`)
  }
})

test("meanNormalize: mean of the tokens, unit length", () => {
  // mean([3, 0, 4]) = [1, 0, 4/3], normalised to [0.6, 0, 0.8].
  const sum = new Float32Array([3, 0, 4])
  const vector = meanNormalize(sum, 3)
  assert.ok(Math.abs(vector[0]! - 0.6) < 1e-6)
  assert.ok(Math.abs(vector[2]! - 0.8) < 1e-6)
  assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-6)
})

test("meanNormalize: no tokens leaves the vector untouched", () => {
  const zero = meanNormalize(new Float32Array([0, 0]), 0)
  assert.deepEqual(Array.from(zero), [0, 0])
})

test("readSafetensorsTensor: reads one fp32 tensor out of the header", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-indexing-weights-"))
  try {
    const rows = 2
    const cols = 3
    const values = [1, 2, 3, 4, 5, 6]
    const header = JSON.stringify({
      embeddings: { dtype: "F32", shape: [rows, cols], data_offsets: [0, values.length * 4] },
    })
    const headerBytes = Buffer.from(header, "utf8")
    const length = Buffer.alloc(8)
    length.writeBigUInt64LE(BigInt(headerBytes.length))
    const data = Buffer.from(new Float32Array(values).buffer)
    const file = join(dir, "model.safetensors")
    writeFileSync(file, Buffer.concat([length, headerBytes, data]))

    const tensor = readSafetensorsTensor(file, "embeddings")
    assert.equal(tensor.rows, rows)
    assert.equal(tensor.cols, cols)
    assert.deepEqual(Array.from(tensor.values), values)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("local model catalog: every entry has a source and a positive dimension", () => {
  for (const [id, spec] of Object.entries(LOCAL_MODELS)) {
    assert.ok(spec.dimension > 0, `${id} has no dimension`)
    assert.ok(spec.source.kind === "bundled" || spec.source.revision.length > 0, `${id} is not pinned`)
  }
  assert.equal(localModelSpec("potion-base-8M-128d")?.dimension, 128)
  assert.equal(localModelSpec("potion-multilingual-128M")?.dimension, 256)
  assert.equal(localModelSpec("nope"), undefined)
})
