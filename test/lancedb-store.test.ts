import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after, describe, test } from "node:test"

/**
 * `@lancedb/lancedb` is an optional dependency, so its suites are skipped when
 * the native module is not installed instead of failing the whole run.
 */
const lanceUnavailable = await import("@lancedb/lancedb")
  .then(() => false as const)
  .catch(() => "optional @lancedb/lancedb is not installed")

import {
  createKeyedQueue,
  createLanceDbStore,
  lanceDbName,
  openLanceDbReader,
  readLanceDbBatch,
  readLanceDbInfoAt,
} from "../src/lancedb-store.ts"
import type { EmbeddingProfile, QdrantPoint } from "../src/types.ts"
import type { ExportBatch } from "../src/vector-store.ts"

/**
 * These tests exercise the real native module (tiny data sets only). Every
 * test uses its own database directory under a shared temp root, cleaned up
 * once in `after()`.
 */

/** Absolute on the running OS: the delete path relativizes file paths against it. */
const ROOT = process.platform === "win32" ? "D:\\fake\\workspace" : "/fake/workspace"
const DIRECTORY = fs.mkdtempSync(path.join(os.tmpdir(), "oi-lance-"))

const PROFILE: EmbeddingProfile = { provider: "openai", modelId: "text-embedding-3-small", dimension: 4 }
const OTHER_PROFILE: EmbeddingProfile = { provider: "ollama", modelId: "nomic-embed-text", dimension: 4 }

let counter = 0
function uniqueName(label: string): string {
  counter += 1
  return `${label}-${counter}`
}

function store(name: string) {
  return createLanceDbStore({ root: ROOT, directory: DIRECTORY, dbName: name })
}

function idFor(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
}

function point(n: number, filePath: string, vector: number[], startLine = 1, endLine = 2): QdrantPoint {
  return {
    id: idFor(n),
    vector,
    payload: {
      filePath,
      fileHash: `hash-${n}`,
      codeChunk: `chunk ${n}`,
      startLine,
      endLine,
    },
  }
}

/** Values chosen to be exactly representable in float32, so round-trips compare equal. */
const EXACT_VECTORS: number[][] = [
  [1, 0, 0, 0],
  [0.5, 0.25, 0.5, 0],
  [0.125, 0.75, 1, 0.5],
  [0, 0.5, 0.25, 1],
  [0.75, 0.125, 0, 0.5],
]

after(() => {
  fs.rmSync(DIRECTORY, { recursive: true, force: true })
})

describe("lanceDbName", () => {
  test("is <basename>-<sha256(root)[0:16]>", () => {
    const expected = `workspace-${createHash("sha256").update(ROOT).digest("hex").slice(0, 16)}`
    assert.equal(lanceDbName(ROOT), expected)
    assert.match(lanceDbName(ROOT), /^workspace-[0-9a-f]{16}$/)
    // The store name defaults to the same value under the configured directory.
    const s = createLanceDbStore({ root: ROOT, directory: DIRECTORY })
    assert.equal(s.name, path.join(DIRECTORY, expected))
  })
})

describe("ensure / info", { skip: lanceUnavailable }, () => {
  test("creates the db with schema and profile metadata, then validates on re-ensure", async () => {
    const name = uniqueName("ensure")
    const s = store(name)

    assert.deepEqual(await s.ensure(4, PROFILE), { created: true })

    const info = await s.info()
    assert.equal(info.kind, "lancedb")
    assert.equal(info.name, path.join(DIRECTORY, name))
    assert.equal(info.exists, true)
    assert.equal(info.pointsCount, 0)
    assert.equal(info.schema, 2)
    assert.equal(info.complete, false)
    assert.deepEqual(info.profile, PROFILE)

    assert.deepEqual(await s.ensure(4, PROFILE), { created: false })

    const raw = await readLanceDbInfoAt(s.name)
    assert.equal(raw.vectorExists, true)
    assert.equal(raw.metadataExists, true)
    assert.equal(raw.pointsCount, 0)
    assert.deepEqual(raw.profile, PROFILE)
    assert.equal(raw.complete, false)
    assert.equal(raw.schema, 2)
  })

  test("throws on dimension mismatch instead of recreating", async () => {
    const name = uniqueName("dim")
    const s = store(name)
    await s.ensure(4, PROFILE)

    await assert.rejects(s.ensure(8, { ...PROFILE, dimension: 8 }), /vector size 4/)

    // The store is untouched.
    const info = await s.info()
    assert.equal(info.exists, true)
    assert.equal(info.pointsCount, 0)
    assert.deepEqual(info.profile, PROFILE)
  })

  test("throws on profile mismatch when the store has points", async () => {
    const name = uniqueName("profile")
    const s = store(name)
    await s.ensure(4, PROFILE)
    await s.upsert([point(1, "src\\a.ts", [1, 0, 0, 0])])

    await assert.rejects(s.ensure(4, OTHER_PROFILE), /built with openai\/text-embedding-3-small/)
  })
})

describe("upsert / search", { skip: lanceUnavailable }, () => {
  test("stores points and finds the exact vector with its payload", async () => {
    const name = uniqueName("search")
    const s = store(name)
    await s.ensure(4, PROFILE)

    await s.upsert([
      point(1, "src\\a.ts", [1, 0, 0, 0], 10, 20),
      point(2, "src\\b.ts", [0, 1, 0, 0], 1, 5),
      point(3, "lib\\c.ts", [0, 0, 1, 0], 7, 9),
    ])
    assert.equal((await s.info()).pointsCount, 3)

    // Invalid payloads are ignored.
    await s.upsert([{ id: idFor(99), vector: [0, 0, 0, 0], payload: { filePath: "x" } }])
    assert.equal((await s.info()).pointsCount, 3)

    const hits = await s.search({ vector: [1, 0, 0, 0] })
    assert.equal(hits.length, 1)
    const hit = hits[0]!
    assert.equal(hit.id, idFor(1))
    assert.ok(Math.abs(hit.score - 1) < 1e-6, `expected score ~1, got ${hit.score}`)
    assert.deepEqual(hit.payload, {
      filePath: "src/a.ts",
      fileHash: "hash-1",
      codeChunk: "chunk 1",
      startLine: 10,
      endLine: 20,
    })

    // minScore filters at the database level: orthogonal vectors are far away.
    const strict = await s.search({ vector: [1, 0, 0, 0], minScore: 0.99 })
    assert.equal(strict.length, 1)
    assert.equal(strict[0]!.id, idFor(1))
  })

  test("filters by pathPrefix with native-separator stored paths", async () => {
    const name = uniqueName("prefix")
    const s = store(name)
    await s.ensure(4, PROFILE)

    await s.upsert([
      point(1, "src\\a.ts", [1, 0, 0, 0]),
      point(2, "lib\\b.ts", [1, 0, 0, 0]),
    ])

    const all = await s.search({ vector: [1, 0, 0, 0] })
    assert.equal(all.length, 2)

    const src = await s.search({ vector: [1, 0, 0, 0], pathPrefix: "src" })
    assert.deepEqual(
      src.map((hit) => hit.payload?.filePath),
      ["src/a.ts"],
    )

    // Trailing separator variant must behave the same.
    const srcSlash = await s.search({ vector: [1, 0, 0, 0], pathPrefix: "src\\" })
    assert.deepEqual(
      srcSlash.map((hit) => hit.payload?.filePath),
      ["src/a.ts"],
    )

    const lib = await s.search({ vector: [1, 0, 0, 0], pathPrefix: "lib" })
    assert.deepEqual(
      lib.map((hit) => hit.payload?.filePath),
      ["lib/b.ts"],
    )

    // Trivial prefixes disable the filter.
    const dot = await s.search({ vector: [1, 0, 0, 0], pathPrefix: "." })
    assert.equal(dot.length, 2)
  })
})

describe("deleteByFilePaths", { skip: lanceUnavailable }, () => {
  test("removes only the points of the given files", async () => {
    const name = uniqueName("delete")
    const s = store(name)
    await s.ensure(4, PROFILE)

    await s.upsert([
      point(1, "src\\a.ts", [1, 0, 0, 0]),
      point(2, "src\\a.ts", [0.5, 0.5, 0, 0], 30, 40),
      point(3, "lib\\b.ts", [1, 0, 0, 0]),
    ])
    assert.equal((await s.info()).pointsCount, 3)

    await s.deleteByFilePaths(["src\\a.ts"])
    assert.equal((await s.info()).pointsCount, 1)

    const hits = await s.search({ vector: [1, 0, 0, 0] })
    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.payload?.filePath, "lib/b.ts")

    // Empty input is a no-op; absolute paths are relativized to the root.
    await s.deleteByFilePaths([])
    assert.equal((await s.info()).pointsCount, 1)
    await s.deleteByFilePaths([path.join(ROOT, "lib", "b.ts")])
    assert.equal((await s.info()).pointsCount, 0)
  })
})

describe("deleteAll", { skip: lanceUnavailable }, () => {
  test("clears both tables but keeps the database usable", async () => {
    const name = uniqueName("clear")
    const s = store(name)
    await s.ensure(4, PROFILE)
    await s.upsert([point(1, "src\\a.ts", [1, 0, 0, 0])])
    await s.markComplete(PROFILE, true, 4)

    await s.deleteAll()

    const info = await s.info()
    assert.equal(info.exists, true)
    assert.equal(info.pointsCount, 0)

    const hits = await s.search({ vector: [1, 0, 0, 0] })
    assert.equal(hits.length, 0)

    // The directory is not removed.
    assert.equal(fs.existsSync(s.name), true)

    // ensure() re-seeds the cleared metadata instead of bricking the store.
    const recreated = await s.ensure(4, PROFILE)
    assert.equal(recreated.created, true)
    const reseeded = await s.info()
    assert.equal(reseeded.complete, false)
    assert.deepEqual(reseeded.profile, PROFILE)
    assert.equal(reseeded.schema, 2)

    await s.upsert([point(2, "src\\b.ts", [1, 0, 0, 0])])
    assert.equal((await s.info()).pointsCount, 1)
  })
})

describe("markComplete", { skip: lanceUnavailable }, () => {
  test("persists the completion flag and profile", async () => {
    const name = uniqueName("complete")
    const s = store(name)
    await s.ensure(4, PROFILE)
    await s.markComplete(PROFILE, true, 4)

    const info = await s.info()
    assert.equal(info.complete, true)
    assert.deepEqual(info.profile, PROFILE)
    assert.equal(info.schema, 2)

    const raw = await readLanceDbInfoAt(s.name)
    assert.equal(raw.complete, true)
    assert.deepEqual(raw.profile, PROFILE)

    await s.markComplete(PROFILE, false, 4)
    assert.equal((await s.info()).complete, false)
  })
})

describe("exportBatch", { skip: lanceUnavailable }, () => {
  test("paginates via the numeric cursor and round-trips vectors exactly", async () => {
    const name = uniqueName("export")
    const s = store(name)
    await s.ensure(4, PROFILE)

    const points = EXACT_VECTORS.map((vector, index) => point(index + 1, `src\\file${index}.ts`, vector, index + 1, index + 10))
    await s.upsert(points)

    const seen = new Map<string, QdrantPoint>()
    const sizes: number[] = []
    let cursor: unknown = undefined
    let guard = 0

    while (guard < 10) {
      guard += 1
      const batch = (await s.exportBatch({ limit: 2, cursor })) as ExportBatch & { done: boolean }
      sizes.push(batch.points.length)
      for (const exported of batch.points) seen.set(exported.id, exported)
      if (batch.done) {
        assert.equal(batch.next, undefined)
        break
      }
      assert.equal(typeof batch.next, "number")
      cursor = batch.next
    }

    assert.deepEqual(sizes, [2, 2, 1])
    assert.equal(seen.size, 5)
    for (const original of points) {
      const exported = seen.get(original.id)
      assert.ok(exported, `missing exported point ${original.id}`)
      assert.deepEqual(exported.vector, original.vector)
      assert.deepEqual(exported.payload, {
        ...original.payload,
        filePath: String(original.payload.filePath).replaceAll("\\", "/"),
      })
    }
  })
})

describe("readLanceDbInfoAt / readLanceDbBatch", { skip: lanceUnavailable }, () => {
  test("read a created store through the standalone helpers", async () => {
    const name = uniqueName("readonly")
    const s = store(name)
    await s.ensure(4, PROFILE)

    const points = EXACT_VECTORS.slice(0, 3).map((vector, index) => point(index + 1, `src\\f${index}.ts`, vector, index + 1, index + 3))
    await s.upsert(points)
    await s.markComplete(PROFILE, true, 4)

    const raw = await readLanceDbInfoAt(s.name)
    assert.equal(raw.vectorExists, true)
    assert.equal(raw.metadataExists, true)
    assert.equal(raw.pointsCount, 3)
    assert.deepEqual(raw.profile, PROFILE)
    assert.equal(raw.complete, true)
    assert.equal(raw.schema, 2)

    const all = await readLanceDbBatch(s.name, { limit: 10, offset: 0 })
    assert.equal(all.done, true)
    assert.equal(all.points.length, 3)
    for (const original of points) {
      const exported = all.points.find((entry) => entry.id === original.id)
      assert.ok(exported, `missing read point ${original.id}`)
      assert.deepEqual(exported.vector, original.vector)
      // filePath is normalized to forward slashes on write (separator-agnostic
      // storage); the other payload fields round-trip verbatim.
      assert.deepEqual(exported.payload, {
        ...original.payload,
        filePath: String(original.payload.filePath).replaceAll("\\", "/"),
      })
    }

    const first = await readLanceDbBatch(s.name, { limit: 2, offset: 0 })
    assert.equal(first.done, false)
    assert.equal(first.points.length, 2)
    const second = await readLanceDbBatch(s.name, { limit: 2, offset: 2 })
    assert.equal(second.done, true)
    assert.equal(second.points.length, 1)
  })

  /**
   * Kilo's first LanceDB indexes predate `fileHash`. Asking LanceDB for a column
   * that does not exist fails the whole query, so those databases used to be
   * unreadable end to end: discovery found them and the import died on the first
   * page. The read now selects the intersection with the table's real schema.
   */
  test("reads a Kilo-era table that has no fileHash column", async () => {
    const dir = path.join(DIRECTORY, uniqueName("legacy"))
    const lancedb = await import("@lancedb/lancedb")
    const db = await lancedb.connect(dir)
    const table = await db.createTable("vector", [
      { id: idFor(901), vector: [0.1, 0.2, 0.3, 0.4], filePath: "src/old.ts", codeChunk: "old chunk", startLine: 3, endLine: 9 },
      { id: idFor(902), vector: [0.5, 0.6, 0.7, 0.8], filePath: "src/older.ts", codeChunk: "older chunk", startLine: 1, endLine: 4 },
    ])
    await table.close?.()
    await db.close?.()

    const page = await readLanceDbBatch(dir, { limit: 10, offset: 0 })
    assert.equal(page.done, true)
    assert.equal(page.points.length, 2)

    const byPath = new Map(page.points.map((entry) => [String(entry.payload.filePath), entry.payload]))
    // The key is absent, not present-and-undefined.
    assert.deepEqual(byPath.get("src/old.ts"), {
      filePath: "src/old.ts",
      codeChunk: "old chunk",
      startLine: 3,
      endLine: 9,
    })
    assert.equal("fileHash" in (byPath.get("src/older.ts") ?? {}), false)
  })

  test("missing paths yield empty values instead of throwing", async () => {
    const missing = path.join(DIRECTORY, "does-not-exist")
    assert.deepEqual(await readLanceDbInfoAt(missing), {
      vectorExists: false,
      metadataExists: false,
      pointsCount: 0,
    })
    assert.deepEqual(await readLanceDbBatch(missing, { limit: 10, offset: 0 }), { points: [], done: true })
  })
})

describe("openLanceDbReader", { skip: lanceUnavailable }, () => {
  test("reads every page from one open connection", async () => {
    const name = uniqueName("reader")
    const s = store(name)
    await s.ensure(4, PROFILE)

    const points = EXACT_VECTORS.map((vector, index) => point(index + 1, `src\\r${index}.ts`, vector, index + 1, index + 4))
    await s.upsert(points)
    await s.markComplete(PROFILE, true, 4)

    const reader = await openLanceDbReader(s.name)
    assert.ok(reader, "the reader must open an existing store")
    try {
      assert.deepEqual(reader.info, {
        vectorExists: true,
        metadataExists: true,
        pointsCount: 5,
        profile: PROFILE,
        complete: true,
        schema: 2,
      })

      const seen: QdrantPoint[] = []
      const sizes: number[] = []
      for (let guard = 0; guard < 10; guard++) {
        const page = await reader.next(2)
        sizes.push(page.points.length)
        seen.push(...page.points)
        if (page.done) break
      }

      assert.deepEqual(sizes, [2, 2, 1])
      assert.equal(seen.length, points.length)
      for (const original of points) {
        const exported = seen.find((entry) => entry.id === original.id)
        assert.ok(exported, `missing read point ${original.id}`)
        assert.deepEqual(exported.vector, original.vector)
        assert.deepEqual(exported.payload, {
          ...original.payload,
          filePath: String(original.payload.filePath).replaceAll("\\", "/"),
        })
      }
    } finally {
      reader.close()
    }
  })

  test("returns null for a missing path or a database without a vector table", async () => {
    assert.equal(await openLanceDbReader(path.join(DIRECTORY, "no-such-store")), null)

    const emptyDir = path.join(DIRECTORY, uniqueName("empty"))
    fs.mkdirSync(emptyDir, { recursive: true })
    assert.equal(await openLanceDbReader(emptyDir), null)
  })
})

describe("createKeyedQueue", () => {
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve = (): void => {}
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }

  test("runs different keys in parallel and the same key in call order", async () => {
    const queue = createKeyedQueue()
    const first = deferred()
    const second = deferred()
    const events: string[] = []

    const a1 = queue.run("a", async () => {
      events.push("a1:start")
      await first.promise
      events.push("a1:end")
      return "a1"
    })
    const b1 = queue.run("b", async () => {
      events.push("b1:start")
      await second.promise
      events.push("b1:end")
      return "b1"
    })

    await Promise.resolve()
    // Both tasks started although neither has finished: separate keys do not block.
    assert.deepEqual(events, ["a1:start", "b1:start"])

    const a2 = queue.run("a", async () => {
      events.push("a2:start")
      return "a2"
    })
    await Promise.resolve()
    assert.deepEqual(events, ["a1:start", "b1:start"], "a queued task for a busy key must wait")

    first.resolve()
    assert.equal(await a1, "a1")
    assert.equal(await a2, "a2")
    assert.ok(events.indexOf("a1:end") < events.indexOf("a2:start"))
    assert.equal(events.includes("b1:end"), false, "the other key is still running")

    second.resolve()
    assert.equal(await b1, "b1")

    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(queue.size(), 0, "settled keys are dropped instead of leaking")
  })

  test("keeps the tail of a newer task when an older one settles", async () => {
    const queue = createKeyedQueue()
    const gate = deferred()
    const events: string[] = []

    const first = queue.run("k", async () => {
      events.push("first")
    })
    const second = queue.run("k", async () => {
      events.push("second:start")
      await gate.promise
      events.push("second:end")
    })
    await first
    // Let the cleanup of the settled first task run while `second` is pending.
    await new Promise((resolve) => setImmediate(resolve))

    const third = queue.run("k", async () => {
      events.push("third")
    })
    await Promise.resolve()
    assert.deepEqual(events, ["first", "second:start"], "third must queue behind the pending second task")

    gate.resolve()
    await second
    await third
    assert.deepEqual(events, ["first", "second:start", "second:end", "third"])
  })
})
