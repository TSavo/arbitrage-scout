/**
 * Seed the DB-driven hierarchical taxonomy.
 *
 * Creates:
 *   1. root node,
 *   2. Google Product Taxonomy top-level categories (stable, canonical),
 *   3. a concrete starting hierarchy for the verticals we already support.
 *
 * All seeded nodes and fields are canonical=true. Safe to re-run — idempotent
 * via unique(parent_id, slug) and unique(node_id, key).
 *
 * Also migrates existing products: for any product whose productTypeId maps
 * onto a leaf in the new taxonomy, set taxonomyNodeId on the product row.
 */

import { eq, sql } from "drizzle-orm";
import { db } from "./client";
import { products, taxonomyNodes, taxonomyNodeFields, taxonomyNodeFieldEnumValues } from "./schema";
import { taxonomyRepo } from "./repos/TaxonomyRepo";
import { log } from "@/lib/logger";

interface EnumSeed {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly displayOrder?: number;
}

interface FieldSeed {
  readonly key: string;
  readonly label: string;
  readonly dataType: "string" | "number" | "boolean";
  readonly pattern?: string;
  readonly minValue?: number;
  readonly maxValue?: number;
  readonly isInteger?: boolean;
  readonly format?: string;
  readonly unit?: string;
  readonly extractHint?: string;
  readonly isRequired?: boolean;
  readonly isSearchable?: boolean;
  readonly searchWeight?: number;
  readonly isIdentifier?: boolean;
  readonly isPricingAxis?: boolean;
  readonly displayPriority?: number;
  readonly isHidden?: boolean;
  readonly enumValues?: readonly EnumSeed[];
}

interface NodeSeed {
  readonly slug: string;
  readonly label: string;
  readonly description?: string;
  readonly gptId?: string;
  readonly fields?: readonly FieldSeed[];
  readonly children?: readonly NodeSeed[];
  /** productTypeId of legacy product rows that should be re-parented here. */
  readonly productTypeMapping?: string;
}

// ── Google Product Taxonomy top-level anchors ─────────────────────────
// IDs from the public Google Product Taxonomy. Stable — chosen for breadth.
const GPT_TOP: readonly NodeSeed[] = [
  { slug: "food_beverages_tobacco", label: "Food, Beverages & Tobacco", gptId: "412", description: "Food, drinks, alcohol (wine, spirits, bourbon, whiskey, beer), tobacco, cigars." },
  { slug: "arts_entertainment", label: "Arts & Entertainment", gptId: "8", description: "Fine art, party supplies, event tickets, hobbies. NOT collectible trading cards, figures, or comics — those belong under Collectibles." },
  { slug: "electronics", label: "Electronics", gptId: "222", description: "Consumer electronics: video game consoles and physical game media (cartridges/discs for NES, SNES, N64, PlayStation, etc.), computers, audio/video equipment, phones, cameras." },
  { slug: "apparel_accessories", label: "Apparel & Accessories", gptId: "166", description: "Wearable clothing, shoes, jewelry, handbags, watches. NOT collectible figures, pop-culture merchandise, or trading cards." },
  { slug: "health_beauty", label: "Health & Beauty", gptId: "469", description: "Cosmetics, personal care, health products, fragrances." },
  { slug: "home_garden", label: "Home & Garden", gptId: "536", description: "Furniture, kitchenware, appliances, tools, garden supplies, home decor." },
  { slug: "office_products", label: "Office Supplies", gptId: "922", description: "Office supplies, paper, writing instruments, filing, office equipment." },
  { slug: "toys_games", label: "Toys & Games", gptId: "1239", description: "Toys, dolls, action figures (non-collectible), building sets (LEGO), board games, puzzles, remote-control toys." },
  { slug: "vehicles_parts", label: "Vehicles & Parts", gptId: "888", description: "Cars, motorcycles, bicycles, vehicle parts and accessories." },
  { slug: "sporting_goods", label: "Sporting Goods", gptId: "988", description: "Athletic equipment, exercise gear, outdoor recreation (camping, fishing, hunting)." },
  { slug: "media", label: "Media", gptId: "783", description: "Books, music albums, movies (DVDs/Blu-ray), magazines. NOT collectible comic books (those are under Collectibles)." },
  { slug: "religious_ceremonial", label: "Religious & Ceremonial", gptId: "5605", description: "Religious items, ceremonial objects, memorial supplies." },
  // Collectibles isn't a first-class GPT category at root — it lives under
  // Arts & Entertainment. We synthesize a "collectibles" top-level node for
  // our domain since most of our catalog lives there.
  { slug: "collectibles", label: "Collectibles", description: "Secondary-market collectibles: trading cards (Pokemon, MTG, Yu-Gi-Oh, sports cards), Funko Pops and other collectible figures, comic books (Marvel, DC, etc.), coins, stamps, memorabilia. Items whose value is driven by collector demand, grading, and rarity rather than utility." },
];

// ── Reusable enum presets ─────────────────────────────────────────────

const GAME_CONDITION: readonly EnumSeed[] = [
  { value: "loose", label: "Loose (cart/disc only)", displayOrder: 10 },
  { value: "cib", label: "Complete in box", displayOrder: 20 },
  { value: "new_sealed", label: "New / sealed", displayOrder: 30 },
  { value: "graded", label: "Graded", displayOrder: 40 },
];

const MTG_CONDITION: readonly EnumSeed[] = [
  { value: "NM", label: "Near Mint", displayOrder: 10 },
  { value: "LP", label: "Lightly Played", displayOrder: 20 },
  { value: "MP", label: "Moderately Played", displayOrder: 30 },
  { value: "HP", label: "Heavily Played", displayOrder: 40 },
  { value: "DMG", label: "Damaged", displayOrder: 50 },
];

const POKEMON_CONDITION: readonly EnumSeed[] = [
  { value: "loose", label: "Raw / ungraded", displayOrder: 10 },
  { value: "graded", label: "Graded", displayOrder: 20 },
];

const TCG_GRADING_COMPANY: readonly EnumSeed[] = [
  { value: "PSA", label: "PSA", displayOrder: 10 },
  { value: "BGS", label: "Beckett (BGS)", displayOrder: 20 },
  { value: "CGC", label: "CGC", displayOrder: 30 },
  { value: "SGC", label: "SGC", displayOrder: 40 },
];

// Shared fields attached at the Wine node — inherited by every subcategory.
const SHARED_WINE_FIELDS: readonly FieldSeed[] = [
  { key: "producer", label: "Producer / Winery", dataType: "string", isSearchable: true, searchWeight: 3, isRequired: true, isIdentifier: true, displayPriority: 10 },
  { key: "vintage", label: "Vintage", dataType: "number", isInteger: true, format: "year", isPricingAxis: true, isIdentifier: true, displayPriority: 20 },
  { key: "appellation", label: "Appellation / Region", dataType: "string", isSearchable: true, searchWeight: 2, displayPriority: 30 },
  { key: "country", label: "Country", dataType: "string", displayPriority: 40 },
  { key: "varietal", label: "Varietal / Grape", dataType: "string", isSearchable: true, searchWeight: 2, displayPriority: 50 },
  { key: "bottle_size_ml", label: "Bottle size", dataType: "number", unit: "ml", displayPriority: 60 },
];

// Shared fields attached at the Whiskey node — inherited by bourbon/rye/scotch/etc.
const SHARED_WHISKEY_FIELDS: readonly FieldSeed[] = [
  { key: "distillery", label: "Distillery", dataType: "string", isSearchable: true, searchWeight: 3, isRequired: true, isIdentifier: true, displayPriority: 10 },
  { key: "expression", label: "Expression / Release", dataType: "string", isSearchable: true, searchWeight: 2, displayPriority: 15 },
  { key: "age_years", label: "Age statement", dataType: "number", isInteger: true, unit: "yr", displayPriority: 20 },
  { key: "proof", label: "Proof", dataType: "number", displayPriority: 30 },
  { key: "abv_pct", label: "ABV", dataType: "number", unit: "%", displayPriority: 31 },
  { key: "vintage_year", label: "Vintage / Bottling year", dataType: "number", isInteger: true, format: "year", displayPriority: 40 },
  { key: "bottle_size_ml", label: "Bottle size", dataType: "number", unit: "ml", displayPriority: 60 },
];

// Shared fields attached at rum/tequila/mezcal — basic spirit metadata.
const SHARED_SPIRIT_FIELDS: readonly FieldSeed[] = [
  { key: "distillery", label: "Distillery / Producer", dataType: "string", isSearchable: true, searchWeight: 3, isRequired: true, isIdentifier: true, displayPriority: 10 },
  { key: "expression", label: "Expression / Release", dataType: "string", isSearchable: true, searchWeight: 2, displayPriority: 15 },
  { key: "style", label: "Style", dataType: "string", displayPriority: 20 },
  { key: "age_years", label: "Age", dataType: "number", unit: "yr", displayPriority: 25 },
  { key: "abv_pct", label: "ABV", dataType: "number", unit: "%", displayPriority: 30 },
  { key: "country", label: "Country / Region", dataType: "string", displayPriority: 40 },
  { key: "bottle_size_ml", label: "Bottle size", dataType: "number", unit: "ml", displayPriority: 60 },
];

// Shared fields at the Trading Card node — children refine with enum values.
const TCG_SHARED_FIELDS: readonly FieldSeed[] = [
  { key: "set_name", label: "Set name", dataType: "string", isSearchable: true, searchWeight: 3, isIdentifier: true, isRequired: true, displayPriority: 10 },
  { key: "card_number", label: "Card number", dataType: "string", isSearchable: true, searchWeight: 3, isIdentifier: true, isRequired: true, displayPriority: 20, extractHint: "e.g. 020/189" },
  { key: "rarity", label: "Rarity", dataType: "string", displayPriority: 30 },
  { key: "language", label: "Language", dataType: "string", displayPriority: 40 },
  { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5 },
  { key: "grade", label: "Grade", dataType: "number", isPricingAxis: true, minValue: 1, maxValue: 10, displayPriority: 6 },
  { key: "grading_company", label: "Grading company", dataType: "string", isPricingAxis: true, displayPriority: 7, enumValues: TCG_GRADING_COMPANY },
];

// ── Domain hierarchy (below GPT anchors) ──────────────────────────────

const DOMAIN: readonly NodeSeed[] = [
  // Beverages > Alcoholic Beverages > Liquor & Spirits > Whiskey > Bourbon
  {
    slug: "food_beverages_tobacco",
    label: "Food, Beverages & Tobacco",
    children: [
      {
        slug: "beverages",
        label: "Beverages",
        children: [
          {
            slug: "alcoholic_beverages",
            label: "Alcoholic Beverages",
            description: "Wine, beer, and distilled spirits. NOT non-alcoholic drinks.",
            children: [
              {
                slug: "wine",
                label: "Wine",
                description: "Grape-based fermented beverages. Split by style (still red/white/rosé, sparkling, fortified, dessert) and by regional appellation deeper down.",
                fields: SHARED_WINE_FIELDS,
                children: [
                  {
                    slug: "red_wine",
                    label: "Red Wine",
                    description: "Still red wines. Subcategorized by region/appellation (Bordeaux, Burgundy, Barolo, Chianti, Napa Cab, etc.) and varietal.",
                  },
                  {
                    slug: "white_wine",
                    label: "White Wine",
                    description: "Still white wines. Subcategorized by region/appellation (Burgundy, Sancerre, Mosel, Rias Baixas, etc.) and varietal.",
                  },
                  {
                    slug: "rose_wine",
                    label: "Rosé Wine",
                    description: "Still rosé wines — Provence, Tavel, and other pink still wines.",
                  },
                  {
                    slug: "sparkling_wine",
                    label: "Sparkling Wine",
                    description: "Wines with significant effervescence. Champagne is the prestige regional subcategory; see also crémant, prosecco, cava, English sparkling.",
                    children: [
                      {
                        slug: "champagne",
                        label: "Champagne",
                        description: "Sparkling wine from the Champagne region of France. Protected appellation — only sparkling wine produced there may use the name.",
                      },
                      {
                        slug: "cremant",
                        label: "Crémant",
                        description: "French sparkling wine made by the traditional method but produced OUTSIDE Champagne (Crémant de Bourgogne, de Loire, d'Alsace, etc.).",
                      },
                      {
                        slug: "prosecco",
                        label: "Prosecco",
                        description: "Italian sparkling wine (primarily Glera grape) from the Veneto/Friuli regions, typically made by the tank/Charmat method.",
                      },
                      {
                        slug: "cava",
                        label: "Cava",
                        description: "Spanish sparkling wine, traditional method, primarily from Catalonia.",
                      },
                      {
                        slug: "franciacorta",
                        label: "Franciacorta",
                        description: "Italian traditional-method sparkling wine from Lombardy. Comparable to Champagne in method and prestige.",
                      },
                    ],
                  },
                  {
                    slug: "fortified_wine",
                    label: "Fortified Wine",
                    description: "Wines fortified with distilled spirit. Distinct subcategories: sherry, port, madeira, marsala, vermouth.",
                    children: [
                      {
                        slug: "sherry",
                        label: "Sherry",
                        description: "Fortified wine from Jerez, Spain. Styles include Fino, Manzanilla, Amontillado, Oloroso, Palo Cortado, Pedro Ximénez.",
                      },
                      {
                        slug: "port",
                        label: "Port",
                        description: "Fortified wine from the Douro Valley, Portugal. Styles include Ruby, Tawny, LBV, Vintage, Colheita, White Port.",
                      },
                      {
                        slug: "madeira",
                        label: "Madeira",
                        description: "Fortified wine from the Portuguese island of Madeira. Named by grape: Sercial, Verdelho, Bual, Malmsey; also Rainwater.",
                      },
                      {
                        slug: "marsala",
                        label: "Marsala",
                        description: "Italian fortified wine from Sicily.",
                      },
                      {
                        slug: "vermouth",
                        label: "Vermouth",
                        description: "Aromatized fortified wine — dry (French) and sweet (Italian) styles. Also Chinato, Americano.",
                      },
                    ],
                  },
                  {
                    slug: "dessert_wine",
                    label: "Dessert Wine",
                    description: "Sweet unfortified wines — Sauternes, Tokaji, ice wine, late-harvest, straw wines, Passito.",
                  },
                  {
                    slug: "sake",
                    label: "Sake",
                    description: "Japanese rice wine. Categorized by polishing ratio: Junmai, Ginjo, Daiginjo. Also Nigori, Sparkling, Koshu, aged.",
                  },
                ],
              },
              {
                slug: "liquor_spirits",
                label: "Liquor & Spirits",
                description: "Distilled alcoholic beverages. Whiskey, rum, tequila/mezcal, gin, vodka, brandy, liqueurs, etc. NOT wine or beer.",
                children: [
                  {
                    slug: "whiskey",
                    label: "Whiskey",
                    description: "Distilled spirit aged in wood, made from fermented grain mash. Major regional styles: bourbon, rye, Tennessee (US); scotch (Scotland); Irish; Japanese; Canadian.",
                    fields: SHARED_WHISKEY_FIELDS,
                    children: [
                      {
                        slug: "bourbon",
                        label: "Bourbon",
                        description: "American whiskey, min 51% corn, aged in new charred oak, distilled to max 160 proof. Must be made in the US.",
                        productTypeMapping: "bourbon",
                      },
                      {
                        slug: "rye",
                        label: "Rye Whiskey",
                        description: "American whiskey, min 51% rye grain. Spicier, drier than bourbon.",
                      },
                      {
                        slug: "tennessee_whiskey",
                        label: "Tennessee Whiskey",
                        description: "Made in Tennessee, US; meets bourbon criteria PLUS the Lincoln County Process (charcoal filtration before aging). Jack Daniel's, George Dickel.",
                      },
                      {
                        slug: "scotch",
                        label: "Scotch Whisky",
                        description: "Whisky made and aged in Scotland, min 3 years in oak. The Scotch Whisky Association recognizes five categories: single malt, single grain, blended malt, blended grain, and blended scotch. Regional origin within single malt is the key pricing axis.",
                        children: [
                          {
                            slug: "single_malt_scotch",
                            label: "Single Malt Scotch",
                            description: "Scotch from ONE distillery, made entirely from malted barley in pot stills. Regional origin is the primary pricing axis — Islay peat-forward styles price very differently from Speyside sherry-bomb styles. Never contains whisky from other distilleries. Examples: Macallan, Laphroaig, Glenfiddich, Springbank.",
                            children: [
                              {
                                slug: "islay_scotch",
                                label: "Islay Single Malt",
                                description: "Peat-smoke-forward single malts from the island of Islay. Distilleries: Laphroaig, Lagavulin, Ardbeg, Bowmore, Bruichladdich, Bunnahabhain, Caol Ila, Kilchoman, Port Charlotte, Port Ellen (closed — high collector value).",
                              },
                              {
                                slug: "speyside_scotch",
                                label: "Speyside Single Malt",
                                description: "Single malts from Speyside, often sherry-matured, elegant and fruit-forward. The largest producing region. Distilleries: Macallan, Glenfiddich, The Glenlivet, Glenfarclas, Mortlach, Aberlour, Balvenie, Cragganmore, Craigellachie, BenRiach, GlenDronach, Strathisla.",
                              },
                              {
                                slug: "highland_scotch",
                                label: "Highland Single Malt",
                                description: "Single malts from the Highlands — a large and stylistically diverse region. Distilleries: Dalmore, Glenmorangie, Oban, Balblair, Clynelish, Old Pulteney, Tomatin, Tullibardine, Deanston, Edradour, Glenturret, Ben Nevis, Dalwhinnie.",
                              },
                              {
                                slug: "campbeltown_scotch",
                                label: "Campbeltown Single Malt",
                                description: "Small region on the Kintyre peninsula. Tiny output, heavy collector interest — especially Springbank. Active distilleries: Springbank (Springbank, Longrow, Hazelburn), Glen Scotia, Glengyle (Kilkerran).",
                              },
                              {
                                slug: "island_scotch",
                                label: "Island Single Malt (non-Islay)",
                                description: "Single malts from Scottish islands OTHER than Islay — Orkney, Skye, Jura, Mull, Arran, Lewis. Distilleries: Highland Park, Scapa (Orkney); Talisker, Torabhaig (Skye); Jura; Tobermory, Ledaig (Mull); Arran, Lagg; Abhainn Dearg (Lewis).",
                              },
                              {
                                slug: "lowland_scotch",
                                label: "Lowland Single Malt",
                                description: "Single malts from south of the Highland Line. Smallest production region. Distilleries: Auchentoshan, Bladnoch, Glenkinchie, Daftmill, Ailsa Bay, Kingsbarns, Annandale, Lindores Abbey.",
                              },
                            ],
                          },
                          {
                            slug: "blended_malt_scotch",
                            label: "Blended Malt Scotch",
                            description: "A blend of single malts from MULTIPLE distilleries, containing NO grain whisky. Also called vatted malt or pure malt historically. Examples: Compass Box (Peat Monster, Spice Tree, Great King Street), Monkey Shoulder, Johnnie Walker Green Label, Big Peat (Douglas Laing).",
                          },
                          {
                            slug: "single_grain_scotch",
                            label: "Single Grain Scotch",
                            description: "Scotch from ONE distillery, made primarily from grain (wheat, corn) other than malted barley, typically in column stills. Distilleries: Cameronbridge, North British, Girvan, Strathclyde, Invergordon, Loch Lomond (grain side), and closed Port Dundas, Caledonian. Independent bottlings of single-grain scotch are a collector niche.",
                          },
                          {
                            slug: "blended_grain_scotch",
                            label: "Blended Grain Scotch",
                            description: "Blend of grain whiskies from MULTIPLE distilleries, no malt. Rare retail category; seen occasionally in independent bottler releases (Compass Box Hedonism, Douglas Laing Clan Denny Grain).",
                          },
                          {
                            slug: "blended_scotch",
                            label: "Blended Scotch",
                            description: "A blend of malt AND grain whiskies from MULTIPLE distilleries. Historically the dominant category by volume. Examples: Johnnie Walker (Red/Black/Double Black/Gold/Blue), Chivas Regal, Famous Grouse, Ballantine's, Dewar's, J&B, Teacher's, Grant's, Cutty Sark, Bells.",
                          },
                        ],
                      },
                      {
                        slug: "irish_whiskey",
                        label: "Irish Whiskey",
                        description: "Whiskey made and aged in Ireland, min 3 years in wood. Includes single pot still, single malt, single grain, blended.",
                      },
                      {
                        slug: "japanese_whisky",
                        label: "Japanese Whisky",
                        description: "Whisky made in Japan, style inspired by scotch. Suntory, Nikka, Chichibu, etc.",
                      },
                      {
                        slug: "canadian_whisky",
                        label: "Canadian Whisky",
                        description: "Whisky distilled and aged in Canada, min 3 years in wood. Often called 'rye' in Canada regardless of grain bill.",
                      },
                    ],
                  },
                  {
                    slug: "rum",
                    label: "Rum",
                    description: "Spirit distilled from sugarcane products. Primary split is by origin/process: molasses-based rums are further split by country of origin (distinct styles and collectibility); cane-juice rums are rhum agricole (French Caribbean) or clairin (Haiti).",
                    fields: SHARED_SPIRIT_FIELDS,
                    children: [
                      {
                        slug: "rhum_agricole",
                        label: "Rhum Agricole",
                        description: "French-style rum distilled from fresh sugarcane juice (not molasses). AOC Martinique Rhum Agricole and Rhum Agricole de Guadeloupe. Grassy, vegetal profile. Vintage-dated bottlings common and highly collectible (Neisson, Rhum JM, Clément, HSE, Damoiseau).",
                      },
                      {
                        slug: "clairin",
                        label: "Clairin",
                        description: "Haitian artisanal rum, typically from fresh cane juice, pot-distilled, unaged. Single-village, single-terroir bottlings (Sajous, Casimir, Vaval, Le Rocher). Collector category.",
                      },
                      {
                        slug: "jamaican_rum",
                        label: "Jamaican Rum",
                        description: "High-ester, pot-still molasses rum with distinctive 'funk' from long dunder/muck fermentation. Distilleries: Appleton Estate, Hampden Estate, Long Pond, Worthy Park, Monymusk, Clarendon, New Yarmouth. Mark classifications (e.g. DOK, HLCF, LROK) matter to collectors.",
                      },
                      {
                        slug: "barbadian_rum",
                        label: "Barbadian Rum",
                        description: "Column + pot blended molasses rum from Barbados. Distilleries: Mount Gay, Foursquare (Richard Seale), St. Nicholas Abbey, West Indies. Foursquare Exceptional Cask Selection highly collectible.",
                      },
                      {
                        slug: "demerara_rum",
                        label: "Demerara Rum (Guyana)",
                        description: "Guyanese molasses rum, produced at DDL (Diamond Distillers). Famed for heritage wooden stills each producing distinct marques: Port Mourant double wooden pot, Versailles single wooden pot, Enmore wooden coffey, Uitvlugt. El Dorado is the principal label.",
                      },
                      {
                        slug: "trinidadian_rum",
                        label: "Trinidadian Rum",
                        description: "Trinidad & Tobago rum. Angostura (active), Caroni (closed 2002 — highly collectible and speculative market, independent bottlers).",
                      },
                      {
                        slug: "cuban_style_rum",
                        label: "Cuban-style Rum",
                        description: "Light, column-still molasses rum. Cuban origin (Havana Club) or Cuban-style diaspora (Bacardi in Puerto Rico, Matusalem, Santiago de Cuba).",
                      },
                      {
                        slug: "puerto_rican_rum",
                        label: "Puerto Rican Rum",
                        description: "Column-still molasses rum from Puerto Rico, typically lighter profile. Bacardi, Don Q, Ron del Barrilito, Serrallés.",
                      },
                      {
                        slug: "venezuelan_rum",
                        label: "Venezuelan Rum",
                        description: "DOC Ron de Venezuela — aged molasses rum, solera-style blending common. Diplomático, Santa Teresa, Pampero, Cacique.",
                      },
                      {
                        slug: "central_american_rum",
                        label: "Central American Rum",
                        description: "Rum from Guatemala (Zacapa, Botran), Nicaragua (Flor de Caña), Panama (Ron Abuelo, Selvarey), Honduras, Belize. Often solera-aged.",
                      },
                      {
                        slug: "navy_rum",
                        label: "Navy Rum",
                        description: "Traditional British Navy-strength blended rum (min 54.5% ABV). Pusser's is the canonical modern expression; historical bottlings (Black Tot, naval rations) are highly collectible.",
                      },
                      {
                        slug: "overproof_rum",
                        label: "Overproof Rum",
                        description: "Rum bottled above 57.15% ABV (100 British proof). Wray & Nephew, Rum Fire, Sunset Very Strong, Clarke's Court Pure White.",
                      },
                      {
                        slug: "spiced_rum",
                        label: "Spiced Rum",
                        description: "Rum infused with spices, botanicals, or caramel. Typically mass-market (Captain Morgan, Kraken, Sailor Jerry).",
                      },
                    ],
                  },
                  {
                    slug: "agave_spirits",
                    label: "Agave Spirits",
                    description: "Spirits distilled from agave. Tequila (only from blue agave in designated Mexican regions) and mezcal (broader agave category, other regions) are distinct.",
                    children: [
                      {
                        slug: "tequila",
                        label: "Tequila",
                        description: "Agave spirit from designated regions of Mexico (Jalisco primarily), from blue Weber agave. Styles: Blanco/Silver, Reposado (2–12mo oak), Añejo (1–3yr), Extra Añejo (3+yr), Cristalino.",
                        fields: SHARED_SPIRIT_FIELDS,
                      },
                      {
                        slug: "mezcal",
                        label: "Mezcal",
                        description: "Agave spirit from Mexico (Oaxaca and 8 other states). Unlike tequila, any agave species may be used; smoke character from pit-roasting. Includes raicilla, bacanora, sotol (related).",
                        fields: SHARED_SPIRIT_FIELDS,
                      },
                    ],
                  },
                  {
                    slug: "gin",
                    label: "Gin",
                    description: "Juniper-flavored distilled spirit. Styles: London Dry, Plymouth, Old Tom, New Western/Contemporary, Genever (malt-based Dutch/Belgian predecessor).",
                  },
                  {
                    slug: "vodka",
                    label: "Vodka",
                    description: "Neutral distilled spirit, typically unaged, filtered for smoothness. Grain, potato, and other bases.",
                  },
                  {
                    slug: "brandy",
                    label: "Brandy",
                    description: "Spirit distilled from wine or fermented fruit. Regional/stylistic subcategories (cognac, armagnac, calvados, grappa, pisco) each have distinct origin rules.",
                    children: [
                      {
                        slug: "cognac",
                        label: "Cognac",
                        description: "Brandy from the Cognac region of France. Protected appellation — only grape brandy distilled and aged there may be labeled Cognac. Age grades: VS, VSOP, Napoléon, XO, XXO, Hors d'âge.",
                      },
                      {
                        slug: "armagnac",
                        label: "Armagnac",
                        description: "Brandy from the Armagnac region of Gascony, France. DISTINCT from Cognac: different grapes, column-still distillation (traditionally), often longer aging, vintage-dated bottlings common.",
                      },
                      {
                        slug: "calvados",
                        label: "Calvados",
                        description: "Apple (and sometimes pear) brandy from Normandy, France. Appellations include Calvados AOC, Calvados Pays d'Auge AOC, Calvados Domfrontais AOC.",
                      },
                      {
                        slug: "grappa",
                        label: "Grappa",
                        description: "Italian pomace brandy distilled from grape skins, seeds, and stems left after winemaking. Single-varietal grappas are common.",
                      },
                      {
                        slug: "pisco",
                        label: "Pisco",
                        description: "Grape brandy from Peru and Chile. Peruvian and Chilean piscos have distinct production rules (aging, water addition, grape varieties).",
                      },
                      {
                        slug: "american_brandy",
                        label: "American Brandy",
                        description: "Grape brandies produced in the United States — California in particular.",
                      },
                      {
                        slug: "fruit_brandy",
                        label: "Fruit Brandy / Eau de Vie",
                        description: "Unaged or lightly aged distillates from fermented fruit other than grapes: kirsch (cherry), poire Williams (pear), framboise (raspberry), slivovitz (plum), mirabelle (yellow plum).",
                      },
                    ],
                  },
                  {
                    slug: "liqueurs",
                    label: "Liqueurs & Cordials",
                    description: "Sweetened flavored spirits. Broad categories: herbal/digestif, amari (Italian bitter), fruit liqueurs, cream liqueurs, coffee, aperitifs.",
                  },
                  {
                    slug: "absinthe",
                    label: "Absinthe",
                    description: "High-proof anise/wormwood/fennel spirit. Traditionally louches with water.",
                  },
                ],
              },
              {
                slug: "beer",
                label: "Beer",
                description: "Fermented grain beverages. Primary collector-relevant splits: Trappist and abbey beers, lambic/spontaneous wild ales, barrel-aged stouts, barleywines/vintage ales, and mainline styles (ales, lagers, IPAs). Vintage dating, bottle-conditioning, and single-release scarcity drive secondary-market pricing.",
                fields: [
                  { key: "brewery", label: "Brewery", dataType: "string", isSearchable: true, searchWeight: 3, isRequired: true, isIdentifier: true, displayPriority: 10 },
                  { key: "label_name", label: "Label / Release", dataType: "string", isSearchable: true, searchWeight: 3, isIdentifier: true, displayPriority: 15 },
                  { key: "vintage", label: "Vintage year", dataType: "number", isInteger: true, format: "year", isPricingAxis: true, displayPriority: 20 },
                  { key: "abv_pct", label: "ABV", dataType: "number", unit: "%", displayPriority: 30 },
                  { key: "bottle_size_ml", label: "Bottle size", dataType: "number", unit: "ml", displayPriority: 40 },
                ],
                children: [
                  {
                    slug: "trappist_beer",
                    label: "Trappist Beer",
                    description: "Beer brewed at Cistercian Trappist monasteries under ATP (Authentic Trappist Product) designation. Fewer than a dozen abbeys qualify. Westvleteren 12 is the marquee whale; Rochefort 10, Chimay Bleue, Orval, Achel, Westmalle, La Trappe, Spencer (US), Tre Fontane, Mont des Cats, Cardeña, Engelszell.",
                  },
                  {
                    slug: "abbey_strong_belgian",
                    label: "Abbey & Strong Belgian",
                    description: "Non-Trappist abbey-style and strong Belgian ales: St. Bernardus (closely related to Westvleteren), Duvel, Kasteel, Gouden Carolus, Maredsous, Leffe, Affligem, Grimbergen. Quads and tripels cellar well.",
                  },
                  {
                    slug: "lambic_wild_ale",
                    label: "Lambic & Wild Ale",
                    description: "Spontaneously fermented sour beer from the Pajottenland region of Belgium, and kindred wild/spontaneous ales elsewhere. Cantillon, 3 Fonteinen, Boon, Girardin, Oud Beersel, De Cam, Tilquin, Lindemans, Hanssens, Mort Subite. Independent blenders: Bokkereyder, Vanberg & DeWulf, Fonteinen Armand & Gaston series. Gueuze, kriek, framboise, faro subtypes; vintage bottles appreciate; single-cask and blender bottlings are high-value.",
                  },
                  {
                    slug: "barrel_aged_stout",
                    label: "Barrel-Aged Stout",
                    description: "Imperial stouts aged in spirit barrels (primarily bourbon). Annual limited releases drive a heavy secondary market. Goose Island Bourbon County Brand Stout + variants (Proprietor's, Vanilla Rye, Backyard, Reserve, etc.); Founders KBS/CBS; 3 Floyds Dark Lord; The Bruery Black Tuesday/Mélange; Toppling Goliath KBBS / Mornin' Delight / Assassin; Side Project; Hill Farmstead; Fremont B-Bomb / Abominable; Bottle Logic Fundamental Observation; Angry Chair; Great Notion.",
                  },
                  {
                    slug: "barleywine_old_ale",
                    label: "Barleywine & Old Ale",
                    description: "High-ABV cellaring styles. English: Fuller's Vintage Ale, Thomas Hardy's Ale, Gale's Prize Old Ale, J.W. Lees Harvest Ale, North Coast Old Stock Ale. American: Sierra Nevada Bigfoot, Anchor Old Foghorn, Firestone Walker Abacus/Sucaba/Parabola. Vintage-dated.",
                  },
                  {
                    slug: "hazy_ipa_ne_ipa",
                    label: "Hazy / New England IPA",
                    description: "Whale-market IPA releases traded fresh. Tree House, Trillium, The Alchemist (Heady Topper, Focal Banger), Monkish, Other Half, Tired Hands, Hill Farmstead (Edward, Susan). Shelf-life-sensitive — buyers care about can date.",
                  },
                  {
                    slug: "rauchbier",
                    label: "Rauchbier & Smoked",
                    description: "Smoked malt beers, principally from Bamberg. Schlenkerla (Märzen, Urbock, Fastenbier, Eiche), Spezial, Herrnbräu Rauchbock.",
                  },
                  {
                    slug: "eisbock_concentrated",
                    label: "Eisbock & Concentrated",
                    description: "Beers concentrated by freeze-distillation. Kulmbacher Eisbock, Schorschbräu, Brewmeister Snake Venom. Extreme-ABV category.",
                  },
                  {
                    slug: "lager",
                    label: "Lager",
                    description: "Bottom-fermented beers: Pilsner, Helles, Dunkel, Bock, Doppelbock (Salvator, Celebrator, Ayinger Celebrator), Märzen/Oktoberfest, Schwarzbier, Vienna.",
                  },
                  {
                    slug: "ale_general",
                    label: "Ale (General)",
                    description: "Top-fermented ales not otherwise categorized: pale ale, amber, brown, porter (non-BA), stout (non-BA), mild, bitter, saison (non-wild), wheat/weissbier, altbier, kölsch.",
                  },
                ],
              },
              {
                slug: "cider",
                label: "Cider",
                description: "Fermented apple (and sometimes pear/perry) beverages. French (Normandy/Brittany — Dupont, Eric Bordelet), English (Oliver's, Ross-on-Wye, Tom Oliver), Spanish Basque sidra. Keeving, ice cider, pét-nat. Distinct from apple brandy (calvados).",
              },
              {
                slug: "mead",
                label: "Mead",
                description: "Fermented honey. Traditional (show mead), melomel (fruit), metheglin (spice), pyment (grape), braggot (with grain). Schramm's, Superstition, B. Nektar, Redstone.",
              },
            ],
          },
        ],
      },
    ],
  },

  // Collectibles > Trading Cards, Figures > Funko Pop, Comic Books, Coins
  {
    slug: "collectibles",
    label: "Collectibles",
    children: [
      {
        slug: "trading_cards",
        label: "Trading Cards",
        fields: TCG_SHARED_FIELDS,
        children: [
          {
            slug: "pokemon",
            label: "Pokemon Trading Card Game",
            productTypeMapping: "pokemon_card",
            fields: [
              {
                key: "set_name",
                label: "Set name",
                dataType: "string",
                isSearchable: true,
                searchWeight: 3,
                isIdentifier: true,
                isRequired: true,
                displayPriority: 10,
                enumValues: [
                  { value: "crown_zenith", label: "Crown Zenith", displayOrder: 10 },
                  { value: "darkness_ablaze", label: "Darkness Ablaze", displayOrder: 20 },
                  { value: "evolving_skies", label: "Evolving Skies", displayOrder: 30 },
                  { value: "hidden_fates", label: "Hidden Fates", displayOrder: 40 },
                  { value: "base_set", label: "Base Set", displayOrder: 50 },
                ],
              },
              {
                key: "condition",
                label: "Condition",
                dataType: "string",
                isPricingAxis: true,
                displayPriority: 5,
                enumValues: POKEMON_CONDITION,
              },
            ],
          },
          {
            slug: "mtg",
            label: "Magic: The Gathering",
            productTypeMapping: "mtg_card",
            fields: [
              {
                key: "set_name",
                label: "Set name",
                dataType: "string",
                isSearchable: true,
                searchWeight: 3,
                isIdentifier: true,
                isRequired: true,
                displayPriority: 10,
                enumValues: [
                  { value: "modern_horizons_3", label: "Modern Horizons 3", displayOrder: 10 },
                  { value: "lord_of_the_rings", label: "Lord of the Rings", displayOrder: 20 },
                  { value: "wilds_of_eldraine", label: "Wilds of Eldraine", displayOrder: 30 },
                ],
              },
              {
                key: "condition",
                label: "Condition",
                dataType: "string",
                isPricingAxis: true,
                displayPriority: 5,
                enumValues: MTG_CONDITION,
              },
              { key: "set_code", label: "Set code", dataType: "string", isSearchable: true, searchWeight: 3, isIdentifier: true, displayPriority: 11 },
              { key: "finish", label: "Finish", dataType: "string", displayPriority: 31, enumValues: [
                { value: "nonfoil", label: "Non-foil" },
                { value: "foil", label: "Foil" },
                { value: "etched", label: "Etched foil" },
              ] },
            ],
          },
          {
            slug: "yugioh",
            label: "Yu-Gi-Oh!",
            productTypeMapping: "yugioh_card",
            fields: [
              { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: MTG_CONDITION },
            ],
          },
          {
            slug: "one_piece",
            label: "One Piece Card Game",
            productTypeMapping: "onepiece_card",
            fields: [
              { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: MTG_CONDITION },
            ],
          },
          {
            slug: "sports_cards",
            label: "Sports Cards",
            productTypeMapping: "sports_card",
            fields: [
              { key: "player", label: "Player", dataType: "string", isSearchable: true, searchWeight: 3, isRequired: true, displayPriority: 10 },
              { key: "year", label: "Year", dataType: "number", isInteger: true, format: "year", isIdentifier: true, displayPriority: 20 },
              { key: "brand", label: "Brand", dataType: "string", isSearchable: true, searchWeight: 2, displayPriority: 30 },
              { key: "rookie", label: "Rookie", dataType: "boolean", displayPriority: 50 },
              { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: [
                { value: "raw", label: "Raw / ungraded", displayOrder: 10 },
                { value: "graded", label: "Graded", displayOrder: 20 },
              ] },
            ],
          },
        ],
      },
      {
        slug: "figures",
        label: "Collectible Figures",
        children: [
          {
            slug: "funko_pop",
            label: "Funko Pop",
            productTypeMapping: "funko_pop",
            fields: [
              { key: "series", label: "Series", dataType: "string", isSearchable: true, searchWeight: 2, displayPriority: 10 },
              { key: "number", label: "Number", dataType: "string", isIdentifier: true, displayPriority: 20 },
              { key: "exclusive", label: "Exclusive", dataType: "boolean", displayPriority: 30 },
              { key: "chase", label: "Chase", dataType: "boolean", displayPriority: 40 },
              { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: [
                { value: "loose", label: "Loose / out of box", displayOrder: 10 },
                { value: "in_box", label: "In box", displayOrder: 20 },
                { value: "graded", label: "Graded", displayOrder: 30 },
              ] },
            ],
          },
        ],
      },
      {
        slug: "comic_books",
        label: "Comic Books",
        productTypeMapping: "comic",
        fields: [
          { key: "publisher", label: "Publisher", dataType: "string", isSearchable: true, searchWeight: 2, displayPriority: 10 },
          { key: "issue", label: "Issue", dataType: "string", isIdentifier: true, displayPriority: 20 },
          { key: "year", label: "Year", dataType: "number", isInteger: true, format: "year", displayPriority: 30 },
          { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: [
            { value: "raw", label: "Raw / ungraded", displayOrder: 10 },
            { value: "graded", label: "Graded (slabbed)", displayOrder: 20 },
          ] },
          { key: "grade", label: "Grade", dataType: "number", isPricingAxis: true, minValue: 0.5, maxValue: 10, displayPriority: 6 },
          { key: "grading_company", label: "Grading company", dataType: "string", isPricingAxis: true, displayPriority: 7 },
        ],
      },
      {
        slug: "coins",
        label: "Coins",
        productTypeMapping: "coin",
        fields: [
          { key: "year", label: "Year", dataType: "number", isInteger: true, format: "year", displayPriority: 10 },
          { key: "mint", label: "Mint mark", dataType: "string", displayPriority: 20 },
          { key: "denomination", label: "Denomination", dataType: "string", displayPriority: 30 },
          { key: "grade", label: "Grade", dataType: "number", isPricingAxis: true, minValue: 1, maxValue: 70, displayPriority: 5 },
          { key: "grading_company", label: "Grading company", dataType: "string", isPricingAxis: true, displayPriority: 6 },
        ],
      },
    ],
  },

  // Electronics > Video Games > Physical Game Media (retro games)
  {
    slug: "electronics",
    label: "Electronics",
    children: [
      {
        slug: "video_games",
        label: "Video Games",
        children: [
          {
            slug: "physical_game_media",
            label: "Physical Game Media",
            description: "Cartridge/disc-based console video games.",
            productTypeMapping: "retro_game",
            fields: [
              { key: "title", label: "Title", dataType: "string", isSearchable: true, searchWeight: 3, isRequired: true, displayPriority: 10, extractHint: "canonical product name" },
              { key: "platform", label: "Platform", dataType: "string", isSearchable: true, searchWeight: 2, displayPriority: 20, enumValues: [
                { value: "nintendo_64", label: "Nintendo 64", displayOrder: 10 },
                { value: "snes", label: "Super Nintendo", displayOrder: 20 },
                { value: "nes", label: "NES", displayOrder: 30 },
                { value: "gamecube", label: "GameCube", displayOrder: 40 },
                { value: "game_boy", label: "Game Boy", displayOrder: 50 },
                { value: "game_boy_advance", label: "Game Boy Advance", displayOrder: 60 },
                { value: "playstation", label: "PlayStation", displayOrder: 70 },
                { value: "genesis", label: "Sega Genesis", displayOrder: 80 },
                { value: "dreamcast", label: "Dreamcast", displayOrder: 90 },
              ] },
              { key: "release_date", label: "Release date", dataType: "string", format: "date", displayPriority: 30 },
              { key: "genre", label: "Genre", dataType: "string", displayPriority: 40 },
              { key: "region", label: "Region", dataType: "string", displayPriority: 50 },
              { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: GAME_CONDITION },
            ],
          },
        ],
      },
    ],
  },

  // Toys & Games > Building Sets > LEGO
  {
    slug: "toys_games",
    label: "Toys & Games",
    children: [
      {
        slug: "building_sets",
        label: "Building Sets",
        children: [
          {
            slug: "lego",
            label: "LEGO",
            productTypeMapping: "lego_set",
            fields: [
              { key: "theme", label: "Theme", dataType: "string", isSearchable: true, searchWeight: 2, displayPriority: 10 },
              { key: "set_number", label: "Set number", dataType: "string", isIdentifier: true, isSearchable: true, searchWeight: 3, displayPriority: 20 },
              { key: "piece_count", label: "Piece count", dataType: "number", isInteger: true, displayPriority: 30 },
              { key: "year", label: "Year", dataType: "number", isInteger: true, format: "year", displayPriority: 40 },
              { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: [
                { value: "loose", label: "Loose / built", displayOrder: 10 },
                { value: "cib", label: "Complete in box", displayOrder: 20 },
                { value: "new_sealed", label: "New / sealed", displayOrder: 30 },
              ] },
            ],
          },
        ],
      },
    ],
  },
];

export interface SeedResult {
  readonly nodes: number;
  readonly fields: number;
  readonly enumValues: number;
  readonly productsLinked: number;
}

export async function seedTaxonomy(): Promise<SeedResult> {
  let nodeCount = 0;
  let fieldCount = 0;
  let enumCount = 0;

  // 1. Ensure root.
  let root = await db.query.taxonomyNodes.findFirst({
    where: (t, { isNull }) => isNull(t.parentId),
  });
  if (!root) {
    const now = new Date().toISOString();
    const [row] = await db
      .insert(taxonomyNodes)
      .values({
        parentId: null,
        slug: "root",
        label: "Root",
        description: "Top of the taxonomy tree.",
        pathCache: "/root",
        createdAt: now,
        createdBy: "seed",
        canonical: true,
        observationCount: 0,
      })
      .returning();
    root = row;
    nodeCount++;
  }

  const rootId = root.id;

  // 2. GPT anchors — mount directly under root.
  const anchorIds = new Map<string, number>();
  for (const top of GPT_TOP) {
    const id = await ensureNode({
      parentId: rootId,
      slug: top.slug,
      label: top.label,
      description: top.description,
      gptId: top.gptId,
    });
    anchorIds.set(top.slug, id);
    nodeCount++;
  }

  // 3. Domain hierarchy — each DOMAIN entry's slug is an anchor slug.
  const legacyTypeMappings = new Map<string, number>();

  async function walk(parentId: number, node: NodeSeed): Promise<number> {
    const id = await ensureNode({
      parentId,
      slug: node.slug,
      label: node.label,
      description: node.description,
      gptId: node.gptId,
    });
    nodeCount++;

    if (node.fields) {
      for (const f of node.fields) {
        const { field, created } = await ensureField(id, f);
        if (created) fieldCount++;
        if (f.enumValues?.length) {
          for (const [i, ev] of f.enumValues.entries()) {
            const inserted = await ensureEnumValue(field.id, ev, i);
            if (inserted) enumCount++;
          }
        }
      }
    }

    if (node.productTypeMapping) {
      legacyTypeMappings.set(node.productTypeMapping, id);
    }

    if (node.children) {
      for (const child of node.children) {
        await walk(id, child);
      }
    }

    return id;
  }

  for (const top of DOMAIN) {
    const anchorId = anchorIds.get(top.slug);
    if (!anchorId) {
      throw new Error(`seed-taxonomy: no GPT anchor for ${top.slug}`);
    }
    if (top.children) {
      for (const child of top.children) {
        await walk(anchorId, child);
      }
    }
    if (top.fields) {
      for (const f of top.fields) {
        const { field, created } = await ensureField(anchorId, f);
        if (created) fieldCount++;
        if (f.enumValues?.length) {
          for (const [i, ev] of f.enumValues.entries()) {
            const inserted = await ensureEnumValue(field.id, ev, i);
            if (inserted) enumCount++;
          }
        }
      }
    }
  }

  // 4. Migrate existing products: set taxonomyNodeId based on productTypeId.
  let productsLinked = 0;
  for (const [productTypeId, nodeId] of legacyTypeMappings) {
    const res = await db
      .update(products)
      .set({ taxonomyNodeId: nodeId })
      .where(
        sql`${products.productTypeId} = ${productTypeId} AND (${products.taxonomyNodeId} IS NULL)`,
      );
    // better-sqlite3 doesn't return affected on update via drizzle — do a
    // count query to report progress.
    void res;
    const [{ cnt }] = await db
      .select({ cnt: sql<number>`count(*)` })
      .from(products)
      .where(eq(products.productTypeId, productTypeId));
    productsLinked += cnt;
  }

  log(
    "seed-taxonomy",
    `nodes: ${nodeCount} | fields: ${fieldCount} | enum values: ${enumCount} | products linked: ${productsLinked}`,
  );
  return { nodes: nodeCount, fields: fieldCount, enumValues: enumCount, productsLinked };
}

// ── Helpers ───────────────────────────────────────────────────────────

async function ensureNode(params: {
  readonly parentId: number;
  readonly slug: string;
  readonly label: string;
  readonly description?: string;
  readonly gptId?: string;
}): Promise<number> {
  const existing = await db.query.taxonomyNodes.findFirst({
    where: (t, { and, eq }) =>
      and(eq(t.parentId, params.parentId), eq(t.slug, params.slug)),
  });
  if (existing) {
    // Keep label/description in sync with seed source of truth.
    if (
      existing.label !== params.label ||
      (existing.description ?? null) !== (params.description ?? null) ||
      (existing.gptId ?? null) !== (params.gptId ?? null)
    ) {
      await db
        .update(taxonomyNodes)
        .set({
          label: params.label,
          description: params.description,
          gptId: params.gptId,
        })
        .where(eq(taxonomyNodes.id, existing.id));
    }
    return existing.id;
  }

  const node = await taxonomyRepo.createNode(
    {
      parentId: params.parentId,
      slug: params.slug,
      label: params.label,
      description: params.description,
      gptId: params.gptId,
      canonical: true,
    },
    "seed",
  );
  return node.id;
}

async function ensureField(
  nodeId: number,
  f: FieldSeed,
): Promise<{ field: { id: number }; created: boolean }> {
  const existing = await db.query.taxonomyNodeFields.findFirst({
    where: (t, { and, eq }) => and(eq(t.nodeId, nodeId), eq(t.key, f.key)),
  });
  if (existing) {
    // Sync mutable properties.
    await db
      .update(taxonomyNodeFields)
      .set({
        label: f.label,
        dataType: f.dataType,
        pattern: f.pattern,
        minValue: f.minValue,
        maxValue: f.maxValue,
        isInteger: f.isInteger ?? false,
        format: f.format,
        unit: f.unit,
        extractHint: f.extractHint,
        isRequired: f.isRequired ?? false,
        isSearchable: f.isSearchable ?? false,
        searchWeight: f.searchWeight ?? 1,
        isIdentifier: f.isIdentifier ?? false,
        isPricingAxis: f.isPricingAxis ?? false,
        displayPriority: f.displayPriority ?? 100,
        isHidden: f.isHidden ?? false,
        canonical: true,
      })
      .where(eq(taxonomyNodeFields.id, existing.id));
    return { field: { id: existing.id }, created: false };
  }
  const field = await taxonomyRepo.createField(
    {
      nodeId,
      key: f.key,
      label: f.label,
      dataType: f.dataType,
      pattern: f.pattern,
      minValue: f.minValue,
      maxValue: f.maxValue,
      isInteger: f.isInteger,
      format: f.format,
      unit: f.unit,
      extractHint: f.extractHint,
      isRequired: f.isRequired,
      isSearchable: f.isSearchable,
      searchWeight: f.searchWeight,
      isIdentifier: f.isIdentifier,
      isPricingAxis: f.isPricingAxis,
      displayPriority: f.displayPriority,
      isHidden: f.isHidden,
      canonical: true,
    },
    "seed",
  );
  return { field: { id: field.id }, created: true };
}

async function ensureEnumValue(
  fieldId: number,
  ev: EnumSeed,
  index: number,
): Promise<boolean> {
  const existing = await db.query.taxonomyNodeFieldEnumValues.findFirst({
    where: (t, { and, eq }) =>
      and(eq(t.fieldId, fieldId), eq(t.value, ev.value)),
  });
  if (existing) {
    if (
      existing.label !== ev.label ||
      (existing.description ?? null) !== (ev.description ?? null)
    ) {
      await db
        .update(taxonomyNodeFieldEnumValues)
        .set({
          label: ev.label,
          description: ev.description,
          displayOrder: ev.displayOrder ?? (index + 1) * 10,
        })
        .where(eq(taxonomyNodeFieldEnumValues.id, existing.id));
    }
    return false;
  }
  await db.insert(taxonomyNodeFieldEnumValues).values({
    fieldId,
    value: ev.value,
    label: ev.label,
    description: ev.description,
    displayOrder: ev.displayOrder ?? (index + 1) * 10,
  });
  return true;
}
