/**
 * Derive taxonomy fields and enum values from PriceCharting CSV exports.
 *
 * Runs AFTER seed-taxonomy. For each pc-<category>.csv file in the configured
 * directory, this:
 *   1. Locates the target taxonomy node (by slug path).
 *   2. Streams the CSV header + data rows to learn:
 *      - which enum values to add to the category's enum-bearing field
 *        (platform / set_name / series / theme / publisher / denomination),
 *      - which condition/grade enum values to add to the `condition` pricing
 *        axis (derived from *-price columns),
 *      - which ancillary fields exist (genre, release_date, sales_volume,
 *        upc / asin / epid identifiers).
 *   3. Creates any missing fields and enum values via TaxonomyRepo. Fields
 *      seeded here are marked canonical=true (PC data is trusted).
 *
 * Idempotent: re-running is a no-op after the first pass. Uses the DB's unique
 * constraints + pre-checks to avoid duplicate rows.
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { taxonomyRepo, type FieldDef } from "./repos/TaxonomyRepo";
import { log } from "@/lib/logger";

type EnumBearingDef = {
  readonly key: string;
  readonly label: string;
  readonly searchWeight: number;
  readonly isIdentifier?: boolean;
};

interface CategoryConfig {
  readonly slugPath: readonly string[];
  /** Field name for the `console-name` column (the enum-bearing field). */
  readonly enumBearing: EnumBearingDef;
}

const CATEGORY_CONFIG: Record<string, CategoryConfig> = {
  videogames: {
    slugPath: ["electronics", "video_games", "physical_game_media"],
    enumBearing: { key: "platform", label: "Platform", searchWeight: 2 },
  },
  pokemon: {
    slugPath: ["collectibles", "trading_cards", "pokemon"],
    enumBearing: { key: "set_name", label: "Set name", searchWeight: 3, isIdentifier: true },
  },
  magic: {
    slugPath: ["collectibles", "trading_cards", "mtg"],
    enumBearing: { key: "set_name", label: "Set name", searchWeight: 3, isIdentifier: true },
  },
  yugioh: {
    slugPath: ["collectibles", "trading_cards", "yugioh"],
    enumBearing: { key: "set_name", label: "Set name", searchWeight: 3, isIdentifier: true },
  },
  onepiece: {
    slugPath: ["collectibles", "trading_cards", "one_piece"],
    enumBearing: { key: "set_name", label: "Set name", searchWeight: 3, isIdentifier: true },
  },
  funko: {
    slugPath: ["collectibles", "figures", "funko_pop"],
    enumBearing: { key: "series", label: "Series", searchWeight: 2 },
  },
  lego: {
    slugPath: ["toys_games", "building_sets", "lego"],
    enumBearing: { key: "theme", label: "Theme", searchWeight: 2 },
  },
  comics: {
    slugPath: ["collectibles", "comic_books"],
    enumBearing: { key: "publisher", label: "Publisher", searchWeight: 2 },
  },
  coins: {
    slugPath: ["collectibles", "coins"],
    enumBearing: { key: "denomination", label: "Denomination", searchWeight: 2 },
  },
};

/** Columns we ignore outright — metadata about the PC row, not the product. */
const SKIPPED_COLUMNS = new Set(["id", "product-name"]);

/** Columns treated as external identifiers (string, is_identifier=true). */
const IDENTIFIER_COLUMNS = new Set(["upc", "asin", "epid", "isbn"]);

/** Columns that map to ancillary (non-identifier) scalar fields. */
interface AncillaryDef {
  readonly key: string;
  readonly label: string;
  readonly dataType: "string" | "number" | "boolean";
  readonly format?: string;
  readonly isHidden?: boolean;
  readonly displayPriority?: number;
}
const ANCILLARY_COLUMNS: Record<string, AncillaryDef> = {
  "release-date": { key: "release_date", label: "Release date", dataType: "string", format: "date", displayPriority: 30 },
  "genre": { key: "genre", label: "Genre", dataType: "string", displayPriority: 40 },
  "sales-volume": { key: "sales_volume", label: "Sales volume", dataType: "number", isHidden: true, displayPriority: 200 },
};

// ── Helpers ───────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function toEnumValue(raw: string): string | null {
  const cleaned = raw.trim();
  if (!cleaned) return null;
  return cleaned
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

/** Categorize a CSV header column. */
type ColumnRole =
  | { kind: "skip" }
  | { kind: "enum_bearing" }
  | { kind: "price"; condition: string }
  | { kind: "ancillary"; def: AncillaryDef }
  | { kind: "identifier"; identifierType: string };

function classifyColumn(col: string): ColumnRole {
  if (SKIPPED_COLUMNS.has(col)) return { kind: "skip" };
  if (col === "console-name") return { kind: "enum_bearing" };
  if (col.endsWith("-price")) {
    const condition = col.slice(0, -"-price".length);
    return { kind: "price", condition };
  }
  const ancillary = ANCILLARY_COLUMNS[col];
  if (ancillary) return { kind: "ancillary", def: ancillary };
  if (IDENTIFIER_COLUMNS.has(col)) return { kind: "identifier", identifierType: col };
  return { kind: "skip" };
}

/** Stream the CSV header; pick distinct enum-bearing values + distinct prices present. */
async function scanCsv(
  csvPath: string,
): Promise<{ headers: string[]; enumBearingValues: Set<string>; presentConditions: Set<string> }> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(csvPath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let headers: string[] = [];
    let headerIdx = -1;
    let consoleNameIdx = -1;
    const priceIdxToCondition = new Map<number, string>();
    const enumBearingValues = new Set<string>();
    const presentConditions = new Set<string>();
    let lineNo = 0;

    rl.on("line", (line) => {
      if (!line.trim()) return;
      if (lineNo === 0) {
        headers = parseCsvLine(line);
        headerIdx = 0;
        for (let i = 0; i < headers.length; i++) {
          const h = headers[i];
          if (h === "console-name") consoleNameIdx = i;
          else if (h.endsWith("-price")) {
            priceIdxToCondition.set(i, h.slice(0, -"-price".length));
          }
        }
        lineNo++;
        return;
      }
      lineNo++;
      const values = parseCsvLine(line);
      if (consoleNameIdx >= 0) {
        const ev = toEnumValue(values[consoleNameIdx] ?? "");
        if (ev) enumBearingValues.add(ev);
      }
      for (const [idx, cond] of priceIdxToCondition) {
        const raw = (values[idx] ?? "").trim();
        if (raw) presentConditions.add(cond);
      }
    });

    rl.on("close", () => {
      void headerIdx;
      resolve({ headers, enumBearingValues, presentConditions });
    });
    rl.on("error", reject);
    stream.on("error", reject);
  });
}

/** Ensure a field with the given key exists at nodeId; return the existing or newly created FieldDef. */
async function ensureField(
  nodeId: number,
  params: {
    readonly key: string;
    readonly label: string;
    readonly dataType: "string" | "number" | "boolean";
    readonly format?: string;
    readonly isSearchable?: boolean;
    readonly searchWeight?: number;
    readonly isIdentifier?: boolean;
    readonly isPricingAxis?: boolean;
    readonly isHidden?: boolean;
    readonly displayPriority?: number;
  },
): Promise<{ field: FieldDef; created: boolean }> {
  const existing = await taxonomyRepo.getFieldsForNode(nodeId);
  const match = existing.find((f) => f.key === params.key);
  if (match) return { field: match, created: false };

  const created = await taxonomyRepo.createField(
    {
      nodeId,
      key: params.key,
      label: params.label,
      dataType: params.dataType,
      format: params.format,
      isSearchable: params.isSearchable ?? false,
      searchWeight: params.searchWeight ?? 1,
      isIdentifier: params.isIdentifier ?? false,
      isPricingAxis: params.isPricingAxis ?? false,
      isHidden: params.isHidden ?? false,
      displayPriority: params.displayPriority ?? 100,
      canonical: true,
    },
    "seed-pc",
  );
  return { field: created, created: true };
}

async function ensureEnumValues(
  fieldId: number,
  values: Iterable<string>,
  labelFor?: (v: string) => string,
): Promise<number> {
  let added = 0;
  // Re-fetch current enum set to avoid double-counting on re-runs.
  const list = Array.from(values);
  if (list.length === 0) return 0;
  // Load existing values for this field once.
  // Use TaxonomyRepo indirectly via getFieldsForNode is expensive; addEnumValue
  // is idempotent via ON CONFLICT so we just probe before to count created ones.
  const existingSet = await loadExistingEnumSet(fieldId);
  let order = existingSet.size * 10 + 10;
  for (const v of list) {
    if (!v) continue;
    if (existingSet.has(v)) continue;
    const label = labelFor ? labelFor(v) : humanizeEnumLabel(v);
    await taxonomyRepo.addEnumValue(fieldId, v, label, order);
    existingSet.add(v);
    order += 10;
    added++;
  }
  return added;
}

async function loadExistingEnumSet(fieldId: number): Promise<Set<string>> {
  // Fetch via the field's parent node — we don't have a direct "get enums for
  // field" method, but getFieldsForNode returns fully hydrated fields. We can
  // instead query via a tiny helper that uses the same primitive the rest of
  // the repo exposes: look up field → node → reload.
  const { db } = await import("./client");
  const { taxonomyNodeFieldEnumValues, taxonomyNodeFields } = await import("./schema");
  const { eq } = await import("drizzle-orm");
  const fieldRow = await db.query.taxonomyNodeFields.findFirst({
    where: eq(taxonomyNodeFields.id, fieldId),
  });
  if (!fieldRow) return new Set();
  const rows = await db
    .select({ value: taxonomyNodeFieldEnumValues.value })
    .from(taxonomyNodeFieldEnumValues)
    .where(eq(taxonomyNodeFieldEnumValues.fieldId, fieldId));
  return new Set(rows.map((r) => r.value));
}

function humanizeEnumLabel(v: string): string {
  return v
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

// ── Main ──────────────────────────────────────────────────────────────

export interface SeedFromPcResult {
  readonly nodesCreated: number;
  readonly fieldsCreated: number;
  readonly enumValuesCreated: number;
  readonly categoriesProcessed: number;
}

export async function seedFromPriceCharting(opts?: {
  readonly csvDir?: string;
  readonly pattern?: string;
}): Promise<SeedFromPcResult> {
  const csvDir = opts?.csvDir ?? "/tmp";
  const pattern = opts?.pattern ?? "pc-*.csv";

  let nodesCreated = 0;
  let fieldsCreated = 0;
  let enumValuesCreated = 0;
  let categoriesProcessed = 0;

  const files = listMatchingFiles(csvDir, pattern);
  log("seed-pc", `found ${files.length} CSV file(s) in ${csvDir} matching ${pattern}`);

  for (const file of files) {
    const fileName = path.basename(file);
    const category = extractCategoryFromFilename(fileName);
    if (!category) {
      log("seed-pc", `skip ${fileName}: cannot extract category from filename`);
      continue;
    }
    const cfg = CATEGORY_CONFIG[category];
    if (!cfg) {
      log("seed-pc", `skip ${fileName}: no config for category "${category}"`);
      continue;
    }

    const target = await taxonomyRepo.getNodeBySlugPath(cfg.slugPath);
    if (!target) {
      log(
        "seed-pc",
        `skip ${fileName}: target node not found at /${cfg.slugPath.join("/")} — run seed-taxonomy first`,
      );
      continue;
    }

    log(
      "seed-pc",
      `processing ${fileName} → ${target.pathCache} (${cfg.enumBearing.key})`,
    );

    const { headers, enumBearingValues, presentConditions } = await scanCsv(file);
    log(
      "seed-pc",
      `  ${headers.length} columns, ${enumBearingValues.size} distinct ${cfg.enumBearing.key}, ${presentConditions.size} price axes`,
    );

    // 1. Enum-bearing field (platform / set_name / series / theme / publisher / denomination).
    const { field: enumField, created: enumFieldCreated } = await ensureField(
      target.id,
      {
        key: cfg.enumBearing.key,
        label: cfg.enumBearing.label,
        dataType: "string",
        isSearchable: true,
        searchWeight: cfg.enumBearing.searchWeight,
        isIdentifier: cfg.enumBearing.isIdentifier ?? false,
        displayPriority: 20,
      },
    );
    if (enumFieldCreated) fieldsCreated++;
    const addedEnums = await ensureEnumValues(enumField.id, enumBearingValues);
    enumValuesCreated += addedEnums;

    // 2. condition (pricing axis) field with a value per *-price column present.
    if (presentConditions.size > 0) {
      const { field: conditionField, created: condFieldCreated } = await ensureField(
        target.id,
        {
          key: "condition",
          label: "Condition",
          dataType: "string",
          isPricingAxis: true,
          displayPriority: 5,
        },
      );
      if (condFieldCreated) fieldsCreated++;
      const addedCond = await ensureEnumValues(conditionField.id, presentConditions);
      enumValuesCreated += addedCond;
    }

    // 3. Ancillary fields + identifier fields — only if column is present in header.
    const headerSet = new Set(headers);
    for (const [col, def] of Object.entries(ANCILLARY_COLUMNS)) {
      if (!headerSet.has(col)) continue;
      const { created } = await ensureField(target.id, {
        key: def.key,
        label: def.label,
        dataType: def.dataType,
        format: def.format,
        isHidden: def.isHidden ?? false,
        displayPriority: def.displayPriority ?? 100,
      });
      if (created) fieldsCreated++;
    }
    for (const col of IDENTIFIER_COLUMNS) {
      if (!headerSet.has(col)) continue;
      const { created } = await ensureField(target.id, {
        key: col,
        label: col.toUpperCase(),
        dataType: "string",
        isIdentifier: true,
        isSearchable: true,
        searchWeight: 1,
        displayPriority: 90,
      });
      if (created) fieldsCreated++;
    }

    categoriesProcessed++;
  }

  log(
    "seed-pc",
    `done — categories: ${categoriesProcessed}, nodes: ${nodesCreated}, fields: ${fieldsCreated}, enum values: ${enumValuesCreated}`,
  );

  return { nodesCreated, fieldsCreated, enumValuesCreated, categoriesProcessed };
}

// ── File discovery ────────────────────────────────────────────────────

function extractCategoryFromFilename(fileName: string): string | null {
  const m = fileName.match(/^pc-([a-z0-9_-]+)\.csv$/i);
  if (!m) return null;
  return m[1].toLowerCase();
}

function listMatchingFiles(dir: string, pattern: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const regex = globToRegex(pattern);
  const entries = fs.readdirSync(dir);
  return entries
    .filter((n) => regex.test(n))
    .map((n) => path.join(dir, n))
    .filter((p) => fs.statSync(p).isFile())
    .sort();
}

function globToRegex(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else if (/[.+^${}()|[\]\\]/.test(ch)) re += "\\" + ch;
    else re += ch;
  }
  re += "$";
  return new RegExp(re);
}
