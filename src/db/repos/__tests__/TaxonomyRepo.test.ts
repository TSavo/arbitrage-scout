/**
 * Tests for TaxonomyRepo — the DB-driven hierarchical taxonomy repo.
 *
 * Uses an in-memory SQLite DB. Verifies:
 *   - accumulated schema with deepest-wins (replace) field semantics,
 *   - enum value scoping (deepest node with enum values for a key wins),
 *   - getPath returns root → node in order,
 *   - unique(parent_id, slug) prevents duplicate slugs under same parent.
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

beforeEach(() => {
  testBundle = createTestDb();
});

// Import after mocks.
import { TaxonomyRepo } from "../TaxonomyRepo";

async function seedTree(repo: TaxonomyRepo) {
  const root = await repo.createNode(
    { parentId: null, slug: "root", label: "Root", canonical: true },
    "seed",
  );
  const collectibles = await repo.createNode(
    { parentId: root.id, slug: "collectibles", label: "Collectibles", canonical: true },
    "seed",
  );
  const tradingCards = await repo.createNode(
    {
      parentId: collectibles.id,
      slug: "trading_cards",
      label: "Trading Cards",
      canonical: true,
    },
    "seed",
  );
  const pokemon = await repo.createNode(
    { parentId: tradingCards.id, slug: "pokemon", label: "Pokemon", canonical: true },
    "seed",
  );
  const mtg = await repo.createNode(
    { parentId: tradingCards.id, slug: "mtg", label: "Magic: The Gathering", canonical: true },
    "seed",
  );
  return { root, collectibles, tradingCards, pokemon, mtg };
}

describe("TaxonomyRepo.getPath", () => {
  it("returns root → node in order", async () => {
    const repo = new TaxonomyRepo();
    const { pokemon, root, collectibles, tradingCards } = await seedTree(repo);

    const path = await repo.getPath(pokemon.id);
    expect(path.map((n) => n.slug)).toEqual([
      root.slug,
      collectibles.slug,
      tradingCards.slug,
      pokemon.slug,
    ]);
  });
});

describe("TaxonomyRepo unique constraint", () => {
  it("prevents duplicate slugs under the same parent", async () => {
    const repo = new TaxonomyRepo();
    const { tradingCards } = await seedTree(repo);

    await expect(
      repo.createNode(
        {
          parentId: tradingCards.id,
          slug: "pokemon",
          label: "Pokemon duplicate",
          canonical: true,
        },
        "seed",
      ),
    ).rejects.toThrow();
  });
});

describe("TaxonomyRepo.getAccumulatedSchema — deepest-wins semantics", () => {
  it("child field replaces parent field with same key", async () => {
    const repo = new TaxonomyRepo();
    const { tradingCards, pokemon } = await seedTree(repo);

    // Parent (Trading Cards) defines a generic `condition` field.
    await repo.createField(
      {
        nodeId: tradingCards.id,
        key: "condition",
        label: "Condition (generic)",
        dataType: "string",
        canonical: true,
        displayPriority: 5,
      },
      "seed",
    );

    // Pokemon overrides with a more specific label.
    await repo.createField(
      {
        nodeId: pokemon.id,
        key: "condition",
        label: "Pokemon Condition",
        dataType: "string",
        isPricingAxis: true,
        canonical: true,
        displayPriority: 5,
      },
      "seed",
    );

    const schema = await repo.getAccumulatedSchema(pokemon.id);
    const condFields = schema.fields.filter((f) => f.key === "condition");
    expect(condFields.length).toBe(1);
    expect(condFields[0].label).toBe("Pokemon Condition");
    expect(condFields[0].isPricingAxis).toBe(true);
  });

  it("dedups to unique keys and merges cleanly across multiple levels", async () => {
    const repo = new TaxonomyRepo();
    const { tradingCards, pokemon } = await seedTree(repo);

    await repo.createField(
      {
        nodeId: tradingCards.id,
        key: "set_name",
        label: "Set name",
        dataType: "string",
        canonical: true,
      },
      "seed",
    );
    await repo.createField(
      {
        nodeId: tradingCards.id,
        key: "card_number",
        label: "Card number",
        dataType: "string",
        canonical: true,
      },
      "seed",
    );
    await repo.createField(
      {
        nodeId: pokemon.id,
        key: "rarity",
        label: "Rarity",
        dataType: "string",
        canonical: true,
      },
      "seed",
    );

    const schema = await repo.getAccumulatedSchema(pokemon.id);
    const keys = schema.fields.map((f) => f.key).sort();
    expect(keys).toEqual(["card_number", "rarity", "set_name"]);
  });
});

describe("TaxonomyRepo.getAccumulatedSchema — enum value scoping", () => {
  it("deepest node with enum values for a key wins", async () => {
    const repo = new TaxonomyRepo();
    const { tradingCards, pokemon, mtg } = await seedTree(repo);

    // Shared field at Trading Cards — no enum values.
    const sharedField = await repo.createField(
      {
        nodeId: tradingCards.id,
        key: "set_name",
        label: "Set name",
        dataType: "string",
        canonical: true,
        isIdentifier: true,
      },
      "seed",
    );

    // Pokemon-specific field override with its own enum values.
    const pokeField = await repo.createField(
      {
        nodeId: pokemon.id,
        key: "set_name",
        label: "Pokemon Set",
        dataType: "string",
        canonical: true,
      },
      "seed",
    );
    await repo.addEnumValue(pokeField.id, "crown_zenith", "Crown Zenith", 10);
    await repo.addEnumValue(pokeField.id, "darkness_ablaze", "Darkness Ablaze", 20);

    // MTG-specific field override with its own enum values.
    const mtgField = await repo.createField(
      {
        nodeId: mtg.id,
        key: "set_name",
        label: "MTG Set",
        dataType: "string",
        canonical: true,
      },
      "seed",
    );
    await repo.addEnumValue(mtgField.id, "modern_horizons_3", "Modern Horizons 3", 10);

    const pokeSchema = await repo.getAccumulatedSchema(pokemon.id);
    const pokeSetField = pokeSchema.fields.find((f) => f.key === "set_name")!;
    expect(pokeSetField.enumValues.map((e) => e.value).sort()).toEqual([
      "crown_zenith",
      "darkness_ablaze",
    ]);

    const mtgSchema = await repo.getAccumulatedSchema(mtg.id);
    const mtgSetField = mtgSchema.fields.find((f) => f.key === "set_name")!;
    expect(mtgSetField.enumValues.map((e) => e.value)).toEqual(["modern_horizons_3"]);

    // Shared field at Trading Cards has no enum values of its own — tested
    // by looking at just that node's fields.
    const parentFields = await repo.getFieldsForNode(tradingCards.id);
    const parentSetName = parentFields.find((f) => f.key === "set_name");
    expect(parentSetName?.enumValues.length).toBe(0);
    expect(sharedField.id).toBe(parentSetName?.id);
  });
});

describe("TaxonomyRepo.incrementObservation", () => {
  it("bumps the observation counter", async () => {
    const repo = new TaxonomyRepo();
    const { pokemon } = await seedTree(repo);

    expect(pokemon.observationCount).toBe(0);
    await repo.incrementObservation(pokemon.id);
    await repo.incrementObservation(pokemon.id);

    const after = await repo.getNode(pokemon.id);
    expect(after?.observationCount).toBe(2);
    expect(after?.lastObservedAt).toBeTruthy();
  });
});

describe("TaxonomyRepo schema_versions", () => {
  it("records an event per create/promote", async () => {
    const repo = new TaxonomyRepo();
    await seedTree(repo);
    const v = await repo.getCurrentSchemaVersion();
    expect(v).toBeGreaterThan(0);
  });
});
