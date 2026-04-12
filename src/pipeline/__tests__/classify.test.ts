/**
 * Tests for the taxonomy walk classifier.
 *
 * Drives a seeded in-memory DB and a stub LLM client to exercise:
 *   - successful descent through a simple hierarchy,
 *   - `match_with_augmentation` adding a tentative field,
 *   - `new_child` creating a tentative node,
 *   - frequency gate: tentative node stays tentative until N observations,
 *   - similarity gate: a near-duplicate proposal merges into an existing sibling.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "@/__tests__/helpers";

let testBundle = createTestDb();

vi.mock("@/db/client", () => ({
  get db() {
    return testBundle.db;
  },
  get sqlite() {
    return testBundle.sqlite;
  },
}));

vi.mock("@/db/repos/EmbeddingRepo", () => {
  const stub = {
    exists: vi.fn().mockResolvedValue(false),
    getOrCompute: vi.fn().mockResolvedValue(undefined),
    findSimilar: vi.fn().mockResolvedValue([]),
  };
  return {
    embeddingRepo: stub,
    EmbeddingRepo: class {},
  };
});

beforeEach(() => {
  testBundle = createTestDb();
});

// Import after mocks.
import { classify } from "../commands/classify";
import { SchemaGrowthService } from "../schema_growth";
import { TaxonomyRepo } from "@/db/repos/TaxonomyRepo";
import type { RawListing } from "../types";
import type { LlmClient } from "@/llm/pool";

async function seedBeverages(repo: TaxonomyRepo) {
  const root = await repo.createNode(
    { parentId: null, slug: "root", label: "Root", canonical: true },
    "seed",
  );
  const beverages = await repo.createNode(
    { parentId: root.id, slug: "beverages", label: "Beverages", canonical: true },
    "seed",
  );
  const spirits = await repo.createNode(
    { parentId: beverages.id, slug: "spirits", label: "Spirits", canonical: true },
    "seed",
  );
  const whiskey = await repo.createNode(
    { parentId: spirits.id, slug: "whiskey", label: "Whiskey", canonical: true },
    "seed",
  );
  const bourbon = await repo.createNode(
    { parentId: whiskey.id, slug: "bourbon", label: "Bourbon", canonical: true },
    "seed",
  );
  return { root, beverages, spirits, whiskey, bourbon };
}

function scriptedClient(responses: readonly unknown[]): LlmClient {
  let i = 0;
  return {
    async generateJson() {
      const r = responses[i++];
      if (r === undefined) throw new Error("no more scripted responses");
      return r;
    },
  };
}

function makeRaw(overrides: Partial<RawListing> = {}): RawListing {
  return {
    marketplaceId: "shopgoodwill",
    listingId: "sgw-1",
    title: "Booker's Bourbon 7 yr",
    priceUsd: 100,
    shippingUsd: 0,
    url: "https://shopgoodwill.com/item/1",
    scrapedAt: Date.now(),
    ...overrides,
  };
}

describe("classify — successful descent", () => {
  it("descends root → Beverages → Spirits → Whiskey → Bourbon and stops", async () => {
    const repo = new TaxonomyRepo();
    const { bourbon } = await seedBeverages(repo);

    const llm = scriptedClient([
      { type: "match", slug: "beverages" },
      { type: "match", slug: "spirits" },
      { type: "match", slug: "whiskey" },
      { type: "match", slug: "bourbon" },
      { type: "done" },
    ]);

    const result = await classify({
      listing: makeRaw(),
      extractedFields: { distillery: "Booker's", age: 7 },
      llmClient: llm,
    });

    expect(result.path.map((n) => n.slug)).toEqual([
      "root",
      "beverages",
      "spirits",
      "whiskey",
      "bourbon",
    ]);
    expect(result.path[result.path.length - 1].id).toBe(bourbon.id);
    expect(result.usedLlm).toBe(true);
  });
});

describe("classify — match_with_augmentation", () => {
  it("adds a tentative field at the matched node", async () => {
    const repo = new TaxonomyRepo();
    await seedBeverages(repo);

    const llm = scriptedClient([
      { type: "match", slug: "beverages" },
      { type: "match", slug: "spirits" },
      { type: "match", slug: "whiskey" },
      {
        type: "match_with_augmentation",
        slug: "bourbon",
        new_fields: [
          {
            key: "batch_code",
            label: "Batch code",
            dataType: "string",
            isIdentifier: true,
          },
        ],
      },
      { type: "done" },
    ]);

    const growth = new SchemaGrowthService();
    const result = await classify({
      listing: makeRaw(),
      extractedFields: { distillery: "Booker's", batch_code: "2026-01" },
      llmClient: llm,
      growthService: growth,
    });

    const evt = result.growthEvents.find((e) => e.detail === "batch_code");
    expect(evt).toBeDefined();
    expect(["field_added", "field_reinforced"]).toContain(evt!.type);

    const bourbon = result.path[result.path.length - 1];
    const fields = await repo.getFieldsForNode(bourbon.id);
    const batch = fields.find((f) => f.key === "batch_code");
    expect(batch).toBeDefined();
    expect(batch?.canonical).toBe(false); // tentative
  });
});

describe("classify — new_child creates tentative node", () => {
  it("creates a new sibling under Whiskey when LLM proposes one", async () => {
    const repo = new TaxonomyRepo();
    await seedBeverages(repo);

    const llm = scriptedClient([
      { type: "match", slug: "beverages" },
      { type: "match", slug: "spirits" },
      { type: "match", slug: "whiskey" },
      {
        type: "new_child",
        proposal: {
          slug: "rye",
          label: "Rye Whiskey",
          description: "Rye whiskey (majority rye mash).",
          fields: [
            { key: "distillery", label: "Distillery", dataType: "string" },
          ],
        },
      },
    ]);

    const growth = new SchemaGrowthService();
    const result = await classify({
      listing: makeRaw({ title: "Pikesville 6 year rye" }),
      extractedFields: { distillery: "Pikesville" },
      llmClient: llm,
      growthService: growth,
    });

    const leaf = result.path[result.path.length - 1];
    expect(leaf.slug).toBe("rye");
    expect(leaf.canonical).toBe(false);
    const created = result.growthEvents.find((e) => e.detail === "rye");
    expect(created?.type).toBe("node_created");
  });
});

describe("classify — frequency gate", () => {
  it("keeps a tentative node tentative until N observations", async () => {
    const repo = new TaxonomyRepo();
    await seedBeverages(repo);

    // Drop threshold to a clean 3 (default)
    const growth = new SchemaGrowthService({ frequencyThreshold: 3 });

    async function run() {
      const llm = scriptedClient([
        { type: "match", slug: "beverages" },
        { type: "match", slug: "spirits" },
        { type: "match", slug: "whiskey" },
        {
          type: "new_child",
          proposal: {
            slug: "rye",
            label: "Rye Whiskey",
            description: "Rye whiskey.",
            fields: [],
          },
        },
      ]);
      return classify({
        listing: makeRaw(),
        extractedFields: {},
        llmClient: llm,
        growthService: growth,
      });
    }

    const r1 = await run();
    const nodeId = r1.path[r1.path.length - 1].id;
    const after1 = await repo.getNode(nodeId);
    expect(after1?.canonical).toBe(false);
    expect(after1?.observationCount).toBe(1);

    // Subsequent proposals with the same slug reinforce rather than create.
    await run(); // 2 observations
    await run(); // 3 observations → promoted

    const finalNode = await repo.getNode(nodeId);
    expect(finalNode?.observationCount).toBeGreaterThanOrEqual(3);
    expect(finalNode?.canonical).toBe(true);
  });
});

describe("classify — similarity gate", () => {
  it("merges a near-duplicate proposal into an existing sibling", async () => {
    const repo = new TaxonomyRepo();
    const { whiskey } = await seedBeverages(repo);

    // Pre-create a tentative "rye_whiskey" sibling.
    const existing = await repo.createNode(
      {
        parentId: whiskey.id,
        slug: "rye_whiskey",
        label: "Rye Whiskey",
        description: "Rye whiskey (majority rye mash).",
        canonical: false,
      },
      "seed",
    );

    // Use a string-overlap-friendly similarity threshold so the fallback
    // picks up the near-duplicate proposal without needing Ollama.
    const growth = new SchemaGrowthService({
      frequencyThreshold: 3,
      similarityThreshold: 0.5,
    });

    const llm = scriptedClient([
      { type: "match", slug: "beverages" },
      { type: "match", slug: "spirits" },
      { type: "match", slug: "whiskey" },
      {
        type: "new_child",
        proposal: {
          slug: "rye",
          label: "Rye Whiskey",
          description: "Rye whiskey (majority rye mash).",
          fields: [],
        },
      },
    ]);

    const result = await classify({
      listing: makeRaw({ title: "Pikesville rye" }),
      extractedFields: {},
      llmClient: llm,
      growthService: growth,
    });

    const leaf = result.path[result.path.length - 1];
    expect(leaf.id).toBe(existing.id);
    const event = result.growthEvents.find((e) => e.nodeId === existing.id);
    expect(event?.type).toBe("node_reinforced");
  });
});

describe("classify — hot path (no LLM)", () => {
  it("stops at root when no LLM is provided", async () => {
    const repo = new TaxonomyRepo();
    await seedBeverages(repo);

    const result = await classify({
      listing: makeRaw(),
      extractedFields: {},
    });

    expect(result.path.length).toBe(1);
    expect(result.path[0].slug).toBe("root");
    expect(result.usedLlm).toBe(false);
  });
});
