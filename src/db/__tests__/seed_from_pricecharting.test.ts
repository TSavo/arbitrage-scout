/**
 * Tests for seedFromPriceCharting — derives taxonomy fields/enum values from
 * PriceCharting CSV files.
 *
 * Uses an in-memory SQLite DB and fabricated minimal CSVs in a temp dir.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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

vi.mock("@/lib/logger", () => ({
  log: () => {},
  section: () => {},
  progress: () => {},
}));

beforeEach(() => {
  testBundle = createTestDb();
});

// Import after mocks.
import { seedFromPriceCharting } from "../seed_from_pricecharting";
import { taxonomyRepo } from "../repos/TaxonomyRepo";

async function seedMinimalTaxonomy() {
  const root = await taxonomyRepo.createNode(
    { parentId: null, slug: "root", label: "Root", canonical: true },
    "seed",
  );
  const electronics = await taxonomyRepo.createNode(
    { parentId: root.id, slug: "electronics", label: "Electronics", canonical: true },
    "seed",
  );
  const videoGames = await taxonomyRepo.createNode(
    { parentId: electronics.id, slug: "video_games", label: "Video Games", canonical: true },
    "seed",
  );
  const physical = await taxonomyRepo.createNode(
    {
      parentId: videoGames.id,
      slug: "physical_game_media",
      label: "Physical Game Media",
      canonical: true,
    },
    "seed",
  );

  const collectibles = await taxonomyRepo.createNode(
    { parentId: root.id, slug: "collectibles", label: "Collectibles", canonical: true },
    "seed",
  );
  const tradingCards = await taxonomyRepo.createNode(
    { parentId: collectibles.id, slug: "trading_cards", label: "Trading Cards", canonical: true },
    "seed",
  );
  const pokemon = await taxonomyRepo.createNode(
    { parentId: tradingCards.id, slug: "pokemon", label: "Pokemon", canonical: true },
    "seed",
  );

  return { root, physical, pokemon };
}

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pc-seed-test-"));
}

function writeCsv(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

describe("seedFromPriceCharting", () => {
  it("creates platform enum values + condition pricing axis for videogames CSV", async () => {
    const { physical } = await seedMinimalTaxonomy();
    const dir = mkTempDir();

    writeCsv(
      dir,
      "pc-videogames.csv",
      [
        "id,product-name,console-name,loose-price,cib-price,new-price,release-date,genre,sales-volume,upc",
        `1,"Super Mario 64","Nintendo 64","$25.00","$45.00","$200.00","1996-09-29","Platformer","5000","045496630034"`,
        `2,"GoldenEye 007","Nintendo 64","$15.00","$30.00","","1997-08-25","FPS","3000",""`,
        `3,"Sonic Adventure","Dreamcast","$12.00","$25.00","$80.00","1998-12-23","Platformer","500",""`,
      ].join("\n"),
    );

    const result = await seedFromPriceCharting({ csvDir: dir, pattern: "pc-*.csv" });

    expect(result.categoriesProcessed).toBe(1);
    expect(result.fieldsCreated).toBeGreaterThan(0);
    expect(result.enumValuesCreated).toBeGreaterThan(0);

    const fields = await taxonomyRepo.getFieldsForNode(physical.id);
    const platform = fields.find((f) => f.key === "platform");
    expect(platform).toBeDefined();
    expect(platform!.isSearchable).toBe(true);
    expect(platform!.enumValues.map((e) => e.value).sort()).toEqual([
      "dreamcast",
      "nintendo_64",
    ]);

    const condition = fields.find((f) => f.key === "condition");
    expect(condition).toBeDefined();
    expect(condition!.isPricingAxis).toBe(true);
    // loose + cib always present; new only in rows 1/3.
    const condVals = condition!.enumValues.map((e) => e.value).sort();
    expect(condVals).toContain("loose");
    expect(condVals).toContain("cib");
    expect(condVals).toContain("new");

    expect(fields.some((f) => f.key === "release_date")).toBe(true);
    expect(fields.some((f) => f.key === "genre")).toBe(true);
    expect(fields.some((f) => f.key === "sales_volume")).toBe(true);
    expect(fields.some((f) => f.key === "upc" && f.isIdentifier)).toBe(true);
  });

  it("is idempotent across re-runs", async () => {
    await seedMinimalTaxonomy();
    const dir = mkTempDir();
    writeCsv(
      dir,
      "pc-videogames.csv",
      [
        "id,product-name,console-name,loose-price",
        `1,"A","Nintendo 64","$5.00"`,
        `2,"B","SNES","$7.00"`,
      ].join("\n"),
    );

    const first = await seedFromPriceCharting({ csvDir: dir, pattern: "pc-*.csv" });
    const second = await seedFromPriceCharting({ csvDir: dir, pattern: "pc-*.csv" });

    expect(first.fieldsCreated).toBeGreaterThan(0);
    expect(first.enumValuesCreated).toBeGreaterThan(0);
    expect(second.fieldsCreated).toBe(0);
    expect(second.enumValuesCreated).toBe(0);
  });

  it("skips CSVs whose target taxonomy node doesn't exist", async () => {
    await seedMinimalTaxonomy();
    const dir = mkTempDir();
    writeCsv(
      dir,
      "pc-lego.csv",
      [
        "id,product-name,console-name,loose-price",
        `1,"Millennium Falcon","Star Wars","$500.00"`,
      ].join("\n"),
    );

    const result = await seedFromPriceCharting({ csvDir: dir, pattern: "pc-*.csv" });
    expect(result.categoriesProcessed).toBe(0);
    expect(result.fieldsCreated).toBe(0);
  });

  it("adds set_name enum values to pokemon node (trading cards flavor)", async () => {
    const { pokemon } = await seedMinimalTaxonomy();
    const dir = mkTempDir();

    writeCsv(
      dir,
      "pc-pokemon.csv",
      [
        "id,product-name,console-name,loose-price,graded-price",
        `1,"Charizard","Base Set","$100.00","$500.00"`,
        `2,"Pikachu","Jungle","$5.00","$25.00"`,
        `3,"Mewtwo","Base Set","$50.00","$300.00"`,
      ].join("\n"),
    );

    const result = await seedFromPriceCharting({ csvDir: dir, pattern: "pc-*.csv" });
    expect(result.categoriesProcessed).toBe(1);

    const fields = await taxonomyRepo.getFieldsForNode(pokemon.id);
    const setName = fields.find((f) => f.key === "set_name");
    expect(setName).toBeDefined();
    expect(setName!.isIdentifier).toBe(true);
    expect(setName!.searchWeight).toBe(3);
    const values = setName!.enumValues.map((e) => e.value).sort();
    expect(values).toEqual(["base_set", "jungle"]);

    const condition = fields.find((f) => f.key === "condition");
    expect(condition).toBeDefined();
    expect(condition!.enumValues.map((e) => e.value).sort()).toEqual([
      "graded",
      "loose",
    ]);
  });

  it("keeps existing condition field and only adds new enum values (collision handling)", async () => {
    const { pokemon } = await seedMinimalTaxonomy();

    // Pre-create a condition field with a "loose" value (simulating what
    // seed_taxonomy.ts would set up).
    const preField = await taxonomyRepo.createField(
      {
        nodeId: pokemon.id,
        key: "condition",
        label: "Condition",
        dataType: "string",
        isPricingAxis: true,
        displayPriority: 5,
        canonical: true,
      },
      "seed",
    );
    await taxonomyRepo.addEnumValue(preField.id, "loose", "Raw", 10);

    const dir = mkTempDir();
    writeCsv(
      dir,
      "pc-pokemon.csv",
      [
        "id,product-name,console-name,loose-price,graded-price",
        `1,"Charizard","Base Set","$100.00","$500.00"`,
      ].join("\n"),
    );

    const result = await seedFromPriceCharting({ csvDir: dir, pattern: "pc-*.csv" });
    // condition field must NOT be recreated (collision handling).
    expect(result.fieldsCreated).toBeGreaterThanOrEqual(1); // set_name was created
    // "loose" already existed, so only "graded" is added.
    const fields = await taxonomyRepo.getFieldsForNode(pokemon.id);
    const condFields = fields.filter((f) => f.key === "condition");
    expect(condFields.length).toBe(1);
    expect(condFields[0].id).toBe(preField.id);
    const vals = condFields[0].enumValues.map((e) => e.value).sort();
    expect(vals).toEqual(["graded", "loose"]);
  });
});
