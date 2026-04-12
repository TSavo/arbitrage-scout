/**
 * Classify stress test — runs the classify walk on curated listings that
 * exercise the hard parts of the system:
 *   - attribute traps (LLM must not invent a category for a bottle property)
 *   - genuine new_child opportunities (LLM should grow the taxonomy)
 *   - pop-and-propose at the right level
 *   - cross-domain routing (spirits vs cards vs games vs comics)
 *   - leaf confirmation (node is correct, LLM should return done)
 *
 * Does not persist — just reports the walk path + any growth events.
 */

import { classify } from "@/pipeline/commands/classify";
import { buildLlm } from "@/scanner/helpers";
import type { RawListing } from "@/pipeline/types";

interface Case {
  readonly title: string;
  readonly description?: string;
  /** Substring(s) we expect to appear in the final path. */
  readonly expect: ReadonlyArray<string>;
  /** Slugs that MUST NOT appear as new_child proposals (attribute traps). */
  readonly forbiddenNew?: ReadonlyArray<string>;
  readonly note: string;
}

const CASES: readonly Case[] = [
  // ── normal path, should match cleanly ──────────────────────────────
  {
    title: "2023 Istine Chianti Classico",
    expect: ["wine", "red_wine"],
    note: "clean wine classification",
  },
  {
    title: "Macallan 18 Year Sherry Oak Single Malt Scotch Whisky",
    expect: ["scotch", "single_malt_scotch", "speyside_scotch"],
    note: "Macallan is Speyside — must route to speyside_scotch",
  },
  {
    title: "Laphroaig 10 Year Islay Single Malt Scotch Whisky",
    expect: ["islay_scotch"],
    note: "Laphroaig is Islay",
  },
  {
    title: "Springbank 15 Year Campbeltown Single Malt Scotch",
    expect: ["campbeltown_scotch"],
    note: "Campbeltown — smallest category, must resolve correctly",
  },

  // ── attribute traps: MUST match bourbon/etc, NOT create new subcategory ─
  {
    title: "Blanton's Single Barrel Bourbon 750ml",
    expect: ["bourbon"],
    forbiddenNew: ["single_barrel", "blantons", "750ml"],
    note: "'single barrel' is an attribute of bottling, not a category",
  },
  {
    title: "Booker's 2023-04 'Kentucky Tea Party' Batch 46.5% ABV",
    expect: ["bourbon"],
    forbiddenNew: ["bookers_2023", "batch_2023", "batch", "kentucky_tea_party"],
    note: "batch/release naming is an attribute, not a category",
  },
  {
    title: "E.H. Taylor Small Batch Cask Strength Bourbon",
    expect: ["bourbon"],
    forbiddenNew: ["cask_strength", "small_batch", "batch"],
    note: "cask strength + small batch are both attributes",
  },
  {
    title: "Pappy Van Winkle 23 Year Family Reserve Limited Edition",
    expect: ["bourbon"],
    forbiddenNew: ["limited_edition", "23_year", "family_reserve"],
    note: "'limited edition' is a marketing flag, never a category",
  },
  {
    title: "Foursquare Exceptional Cask Mark XII Barbados Rum",
    expect: ["barbadian_rum"],
    forbiddenNew: ["mark_xii", "exceptional_cask", "exceptional_cask_selection", "cask_strength"],
    note: "exceptional cask = attribute; product is a Barbados rum",
  },

  // ── genuine new_child opportunities ─────────────────────────────────
  {
    title: "Amrut Fusion Single Malt Indian Whisky",
    expect: ["whiskey"],
    note: "Indian whisky doesn't have a seeded child under whiskey yet — SHOULD propose indian_whisky",
  },

  // ── pop-and-propose (blended malt under scotch) ─────────────────────
  {
    title: "Compass Box Peat Monster Blended Malt Scotch Whisky",
    expect: ["blended_malt_scotch"],
    note: "blended malt → should land at blended_malt_scotch (seeded)",
  },

  // ── cross-domain routing ────────────────────────────────────────────
  {
    title: "Super Mario 64 Nintendo 64 CIB",
    expect: ["electronics", "video_games", "physical_game_media"],
    note: "cross-domain — wine/spirit paths must NOT match",
  },
  {
    title: "Amazing Spider-Man #300 Marvel Comics 1988 CGC 9.8",
    expect: ["comic_books"],
    note: "comic book — must NOT route through alcoholic_beverages",
  },
  {
    title: "Charizard VMAX 020/189 Darkness Ablaze Pokemon Card PSA 10",
    expect: ["pokemon"],
    forbiddenNew: ["psa_10", "grade_10", "graded_card"],
    note: "grading = attribute, category is pokemon",
  },
];

async function main() {
  const llm = buildLlm({
    provider: "ollama",
    base_url: process.env.OLLAMA_URL ?? "http://battleaxe:11434",
    model: process.env.OLLAMA_MODEL ?? "qwen3:8b",
  });
  if (!llm) throw new Error("no LLM available");

  let pass = 0;
  let fail = 0;

  for (const c of CASES) {
    const listing: RawListing = {
      marketplaceId: "stresstest",
      listingId: `t-${Math.random().toString(36).slice(2, 10)}`,
      title: c.title,
      description: c.description,
      priceUsd: 99.99,
      shippingUsd: 0,
      url: "",
      numBids: 0,
      itemCount: 1,
      extra: {},
      scrapedAt: Date.now(),
    };

    const result = await classify({ listing, extractedFields: {}, llmClient: llm });
    const path = result.path.map((n) => n.slug).join(" → ");

    const expectedMet = c.expect.every((e) => path.includes(e));
    const forbiddenViolations = (c.forbiddenNew ?? []).filter((f) =>
      result.growthEvents.some((g) => g.type === "node_created" && g.detail === f),
    );

    const ok = expectedMet && forbiddenViolations.length === 0;
    if (ok) pass++; else fail++;

    console.log(
      `${ok ? "✓" : "✗"}  ${c.title}`,
    );
    console.log(`     note: ${c.note}`);
    console.log(`     path: ${path}`);
    if (result.growthEvents.length > 0) {
      for (const g of result.growthEvents) {
        console.log(`     event: ${g.type} ${g.detail}`);
      }
    }
    if (!expectedMet) {
      console.log(`     ✗ expected path to include: ${c.expect.join(", ")}`);
    }
    if (forbiddenViolations.length > 0) {
      console.log(`     ✗ forbidden new_child slugs created: ${forbiddenViolations.join(", ")}`);
    }
    console.log("");
  }

  console.log(`\n── RESULT: ${pass}/${CASES.length} pass, ${fail} fail ──`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
