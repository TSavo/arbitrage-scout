import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb } from "./helpers";
import { embeddings } from "../db/schema";

/**
 * Test the float buffer serialization used by EmbeddingRepo.
 * Can't test the full repo without sqlite-vec loaded,
 * but we can verify the data transformation is lossless.
 */

function floatsToBuffer(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

function bufferToFloats(buf: Buffer): number[] {
  const n = buf.length / 4;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(buf.readFloatLE(i * 4));
  return out;
}

describe("embedding serialization", () => {
  it("round-trips float vectors through Buffer", () => {
    const original = [0.1, 0.2, 0.3, -0.5, 1.0, 0.0];
    const buf = floatsToBuffer(original);
    const restored = bufferToFloats(buf);

    expect(restored).toHaveLength(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  it("handles 4096-dim vectors", () => {
    const original = Array.from({ length: 4096 }, (_, i) => Math.sin(i * 0.01));
    const buf = floatsToBuffer(original);
    expect(buf.length).toBe(4096 * 4);

    const restored = bufferToFloats(buf);
    expect(restored).toHaveLength(4096);
    expect(restored[0]).toBeCloseTo(original[0], 5);
    expect(restored[4095]).toBeCloseTo(original[4095], 5);
  });

  it("handles zero vector", () => {
    const zeros = new Array(10).fill(0);
    const buf = floatsToBuffer(zeros);
    const restored = bufferToFloats(buf);
    expect(restored.every((v) => v === 0)).toBe(true);
  });

  it("handles empty vector", () => {
    const buf = floatsToBuffer([]);
    expect(buf.length).toBe(0);
    expect(bufferToFloats(buf)).toEqual([]);
  });
});

describe("embedding metadata (Drizzle table)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
  });

  it("stores and retrieves embedding metadata", () => {

    db.insert(embeddings).values({
      entityType: "product",
      entityId: "pc-1",
      embeddedAt: new Date().toISOString(),
    }).run();

    const row = db.select().from(embeddings)
      .where(and(
        eq(embeddings.entityType, "product"),
        eq(embeddings.entityId, "pc-1"),
      ))
      .all();

    expect(row).toHaveLength(1);
    expect(row[0].entityType).toBe("product");
    expect(row[0].entityId).toBe("pc-1");
  });

  it("enforces unique constraint on (entityType, entityId)", () => {

    db.insert(embeddings).values({
      entityType: "product",
      entityId: "pc-1",
      embeddedAt: new Date().toISOString(),
    }).run();

    // Second insert should conflict
    const result = db.insert(embeddings).values({
      entityType: "product",
      entityId: "pc-1",
      embeddedAt: new Date().toISOString(),
    }).onConflictDoNothing().run();

    expect(result.changes).toBe(0);
  });

  it("allows same entityId for different entityTypes", () => {

    db.insert(embeddings).values({
      entityType: "product",
      entityId: "123",
      embeddedAt: new Date().toISOString(),
    }).run();

    db.insert(embeddings).values({
      entityType: "listing",
      entityId: "123",
      embeddedAt: new Date().toISOString(),
    }).run();

    const all = db.select().from(embeddings).all();
    expect(all).toHaveLength(2);
  });
});
