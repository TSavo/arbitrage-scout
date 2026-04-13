/**
 * Seed taxonomy subtrees + field schemas for new categories:
 *   Apple (MacBook, iPhone, iPad, Watch, AirPods) — dense identity fields
 *   Watches (general)
 *   Pens + ink
 *   Spirits expansion (mezcal, vermouth, japanese whisky, shochu, cordials)
 *
 * Idempotent: walks each path, creating any missing node; registers any
 * missing field definition per leaf. Skips nodes/fields that already exist.
 *
 * Safe to run while the pipeline is live. SQLite WAL permits concurrent
 * writers, and we rely on the UNIQUE(parent_id, slug) constraint for the
 * race-safety property classify already depends on.
 */

import { taxonomyRepo } from "@/db/repos/TaxonomyRepo";

type DataType = "string" | "number" | "boolean";

interface FieldSpec {
  readonly key: string;
  readonly label: string;
  readonly dataType: DataType;
  readonly isIdentifier?: boolean;
  readonly isPricingAxis?: boolean;
  readonly isSearchable?: boolean;
  readonly searchWeight?: number;
  readonly unit?: string;
  readonly extractHint?: string;
}

interface LeafSpec {
  readonly path: string;
  readonly label: string;
  readonly description?: string;
  readonly fields: ReadonlyArray<FieldSpec>;
}

// ── Field presets ──────────────────────────────────────────────────────────

const APPLE_COMMON: FieldSpec[] = [
  { key: "apple_model_number", label: "Apple Model Number (A####)",
    dataType: "string", isIdentifier: true, isSearchable: true, searchWeight: 5,
    extractHint: 'Apple marketing model ID, e.g. "A3185". Usually etched on the device or shown in About.' },
  { key: "color", label: "Color", dataType: "string", isIdentifier: true,
    extractHint: 'Factory color, e.g. "Space Black", "Midnight", "Silver"' },
  { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true,
    extractHint: "One of: new_sealed, like_new, good, fair, parts, refurbished" },
  { key: "activation_lock_status", label: "Activation Lock / iCloud Lock",
    dataType: "string", isPricingAxis: true,
    extractHint: "clean / locked / unknown — locked devices are unusable" },
  { key: "applecare_months_remaining", label: "AppleCare+ Months Remaining",
    dataType: "number", isPricingAxis: true, unit: "months" },
];

// Shared computer fields — attached at /electronics/computers so every
// laptop, desktop, and tablet inherits them via accumulatedSchema.
const COMPUTER_BASE: FieldSpec[] = [
  { key: "brand", label: "Brand", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 5,
    extractHint: 'e.g. "Apple", "Dell", "HP", "Lenovo", "ASUS", "Razer"' },
  { key: "model_family", label: "Model Family / Line", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 4,
    extractHint: 'e.g. "ThinkPad X1 Carbon", "XPS 15", "ROG Zephyrus G14"' },
  { key: "model_year", label: "Model Year", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 4 },
  { key: "cpu", label: "CPU", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 4,
    extractHint: 'CPU model, e.g. "Intel i7-13700H", "AMD Ryzen 9 7940HS", "Apple M3 Pro"' },
  { key: "ram_gb", label: "RAM (GB)", dataType: "number",
    isIdentifier: true, isPricingAxis: true, unit: "GB" },
  { key: "storage_gb", label: "Storage (GB)", dataType: "number",
    isIdentifier: true, isPricingAxis: true, unit: "GB" },
  { key: "storage_type", label: "Storage Type", dataType: "string",
    extractHint: "ssd_nvme / ssd_sata / hdd / emmc / hybrid" },
  { key: "gpu", label: "GPU / Graphics", dataType: "string",
    isIdentifier: true, isPricingAxis: true,
    extractHint: 'Discrete or integrated — "RTX 4070", "Radeon 780M", "Iris Xe", or M-series GPU core count' },
  { key: "color", label: "Color", dataType: "string" },
  { key: "condition", label: "Condition", dataType: "string",
    isPricingAxis: true,
    extractHint: "new_sealed / like_new / good / fair / parts / refurbished" },
];

// Laptops add screen + battery
const LAPTOP_BASE: FieldSpec[] = [
  { key: "screen_size_in", label: "Screen Size (inches)", dataType: "number",
    isIdentifier: true, unit: "in" },
  { key: "screen_resolution", label: "Screen Resolution", dataType: "string",
    extractHint: '"1920x1200", "2880x1800", "3024x1964"' },
  { key: "screen_refresh_hz", label: "Screen Refresh Rate (Hz)", dataType: "number",
    unit: "Hz", isPricingAxis: true,
    extractHint: "60, 90, 120, 144, 165, 240 — matters for gaming laptops" },
  { key: "touchscreen", label: "Touchscreen", dataType: "boolean" },
  { key: "battery_health_pct", label: "Battery Health %", dataType: "number",
    isPricingAxis: true, unit: "%",
    extractHint: "0-100, estimated from cycles + age if not reported directly" },
];

// Apple-specific adds on top of COMPUTER_BASE — activation lock etc.
const APPLE_MAC_OVERLAY: FieldSpec[] = [
  { key: "apple_model_number", label: "Apple Model Number (A####)",
    dataType: "string", isIdentifier: true, isSearchable: true, searchWeight: 5 },
  { key: "apple_chip_family", label: "Apple Silicon Family",
    dataType: "string", isIdentifier: true, isSearchable: true, searchWeight: 4,
    extractHint: "m1 / m1_pro / m1_max / m1_ultra / m2 / m2_pro / m2_max / m2_ultra / m3 / m3_pro / m3_max / m4 / m4_pro / m4_max / m4_ultra — duplicate of cpu but normalized" },
  { key: "activation_lock_status", label: "Activation Lock / iCloud Lock",
    dataType: "string", isPricingAxis: true,
    extractHint: "clean / locked / unknown — locked = paperweight" },
  { key: "applecare_months_remaining", label: "AppleCare+ Months Remaining",
    dataType: "number", isPricingAxis: true, unit: "months" },
];

// MacBook-specific: battery cycle count (System Report exposes this)
const MACBOOK_OVERLAY: FieldSpec[] = [
  { key: "battery_cycles", label: "Battery Cycle Count", dataType: "number",
    isPricingAxis: true,
    extractHint: "About This Mac → System Report → Power" },
];

// Chromebooks: Google's auto-update policy is THE critical pricing axis.
const CHROMEBOOK_OVERLAY: FieldSpec[] = [
  { key: "auto_update_expiry", label: "Auto Update Expiry (AUE) Date",
    dataType: "string", isIdentifier: true, isPricingAxis: true,
    extractHint: 'ChromeOS AUE date, e.g. "June 2028". Past AUE = steep discount' },
  { key: "chrome_os_ready", label: "ChromeOS Status", dataType: "string",
    extractHint: "factory_reset / enrolled / managed / dev_mode" },
];

// Gaming laptops: sometimes worth breaking out thermals / tier
const GAMING_LAPTOP_OVERLAY: FieldSpec[] = [
  { key: "tgp_watts", label: "GPU TGP (W)", dataType: "number", unit: "W",
    isPricingAxis: true,
    extractHint: 'Max sustained GPU wattage — huge perf delta (90W vs 150W 4070)' },
];

// Mobile workstations
const WORKSTATION_OVERLAY: FieldSpec[] = [
  { key: "iso_certified_gpu", label: "ISV-Certified GPU", dataType: "boolean" },
];

const IPHONE_FIELDS: FieldSpec[] = [
  { key: "model_family", label: "iPhone Model Family", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 5,
    extractHint: 'e.g. "iPhone 15 Pro Max", "iPhone 14", "iPhone SE (3rd Gen)"' },
  { key: "storage_gb", label: "Storage (GB)", dataType: "number",
    isIdentifier: true, isPricingAxis: true, unit: "GB" },
  { key: "carrier_lock", label: "Carrier Lock Status", dataType: "string",
    isIdentifier: true, isPricingAxis: true,
    extractHint: "unlocked / att / verizon / tmobile / sprint / other" },
  { key: "battery_health_pct", label: "Battery Health %", dataType: "number",
    isPricingAxis: true, unit: "%",
    extractHint: "iOS Settings → Battery → Battery Health, 0-100" },
  ...APPLE_COMMON,
];

const IPAD_FIELDS: FieldSpec[] = [
  { key: "model_family", label: "iPad Model Family", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 5,
    extractHint: 'iPad / iPad Air / iPad Pro / iPad Mini' },
  { key: "generation", label: "Generation", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 4 },
  { key: "screen_size_in", label: "Screen Size (inches)", dataType: "number",
    isIdentifier: true, unit: "in" },
  { key: "storage_gb", label: "Storage (GB)", dataType: "number",
    isIdentifier: true, isPricingAxis: true, unit: "GB" },
  { key: "connectivity", label: "Connectivity", dataType: "string",
    isIdentifier: true, isPricingAxis: true,
    extractHint: "wifi / wifi_cellular" },
  { key: "carrier_lock", label: "Carrier Lock Status", dataType: "string",
    isPricingAxis: true },
  { key: "battery_health_pct", label: "Battery Health %", dataType: "number",
    isPricingAxis: true, unit: "%" },
  ...APPLE_COMMON,
];

const APPLE_WATCH_FIELDS: FieldSpec[] = [
  { key: "series", label: "Series", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 5,
    extractHint: 'e.g. "Series 10", "Ultra 2", "SE (2nd Gen)"' },
  { key: "case_size_mm", label: "Case Size (mm)", dataType: "number",
    isIdentifier: true, unit: "mm",
    extractHint: "38, 40, 41, 42, 44, 45, 46, 49" },
  { key: "case_material", label: "Case Material", dataType: "string",
    isIdentifier: true, isPricingAxis: true,
    extractHint: "aluminum / stainless_steel / titanium" },
  { key: "connectivity", label: "Connectivity", dataType: "string",
    isIdentifier: true, isPricingAxis: true,
    extractHint: "gps / gps_cellular" },
  { key: "battery_health_pct", label: "Battery Health %", dataType: "number",
    isPricingAxis: true, unit: "%" },
  ...APPLE_COMMON,
];

const AIRPODS_FIELDS: FieldSpec[] = [
  { key: "model_family", label: "AirPods Model", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 5,
    extractHint: 'e.g. "AirPods Pro 2", "AirPods Max", "AirPods 4th Gen"' },
  { key: "anc_variant", label: "ANC Variant", dataType: "string",
    isIdentifier: true, isPricingAxis: true,
    extractHint: "anc / non_anc (AirPods 4 has both SKUs)" },
  { key: "color", label: "Color", dataType: "string", isIdentifier: true },
  { key: "battery_health_pct", label: "Battery Health %", dataType: "number",
    isPricingAxis: true, unit: "%" },
  { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true },
];

const GENERAL_WATCH_FIELDS: FieldSpec[] = [
  { key: "brand", label: "Brand", dataType: "string", isIdentifier: true,
    isSearchable: true, searchWeight: 5,
    extractHint: 'e.g. "Rolex", "Omega", "Seiko", "Tudor"' },
  { key: "model_reference", label: "Model Reference", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 5,
    extractHint: 'Manufacturer reference number, e.g. "126610LN", "SBDC053"' },
  { key: "movement", label: "Movement", dataType: "string",
    isIdentifier: true, isPricingAxis: true,
    extractHint: "automatic / manual / quartz / solar / mechanical" },
  { key: "case_material", label: "Case Material", dataType: "string",
    isIdentifier: true, isPricingAxis: true,
    extractHint: "stainless_steel / gold / two_tone / titanium / ceramic / platinum" },
  { key: "case_diameter_mm", label: "Case Diameter (mm)", dataType: "number",
    isIdentifier: true, unit: "mm" },
  { key: "dial_color", label: "Dial Color", dataType: "string", isIdentifier: true },
  { key: "bracelet_type", label: "Bracelet / Strap", dataType: "string" },
  { key: "box_papers", label: "Box & Papers Included", dataType: "string",
    isPricingAxis: true,
    extractHint: "full_set / watch_only / box_only / papers_only" },
  { key: "year_of_production", label: "Year of Production", dataType: "string" },
  { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true },
];

const FOUNTAIN_PEN_FIELDS: FieldSpec[] = [
  { key: "brand", label: "Brand", dataType: "string", isIdentifier: true,
    isSearchable: true, searchWeight: 5,
    extractHint: 'e.g. "Sailor", "Pilot", "Montblanc", "Lamy", "Visconti"' },
  { key: "model", label: "Model", dataType: "string", isIdentifier: true,
    isSearchable: true, searchWeight: 4 },
  { key: "nib_size", label: "Nib Size", dataType: "string",
    isIdentifier: true, isPricingAxis: true,
    extractHint: "EF, F, M, B, BB, Stub, Italic, Music, custom grinds" },
  { key: "nib_material", label: "Nib Material", dataType: "string",
    isIdentifier: true, isPricingAxis: true,
    extractHint: "steel / 14k_gold / 18k_gold / 21k_gold / titanium" },
  { key: "body_material", label: "Body Material", dataType: "string" },
  { key: "color_finish", label: "Color / Finish", dataType: "string", isIdentifier: true },
  { key: "filling_system", label: "Filling System", dataType: "string",
    extractHint: "cartridge / converter / piston / vacuum / eyedropper" },
  { key: "limited_edition", label: "Limited Edition", dataType: "string",
    isPricingAxis: true,
    extractHint: "Y/N plus edition name+number if applicable" },
  { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true },
];

const INK_FIELDS: FieldSpec[] = [
  { key: "brand", label: "Brand", dataType: "string", isIdentifier: true,
    isSearchable: true, searchWeight: 4 },
  { key: "color_name", label: "Color Name", dataType: "string", isIdentifier: true,
    isSearchable: true, searchWeight: 4 },
  { key: "volume_ml", label: "Volume (mL)", dataType: "number",
    isIdentifier: true, isPricingAxis: true, unit: "mL" },
  { key: "ink_properties", label: "Ink Properties", dataType: "string",
    extractHint: "shimmer, sheen, waterproof, iron-gall, etc." },
  { key: "limited_edition", label: "Limited Edition", dataType: "string",
    isPricingAxis: true },
];

const SPIRITS_COMMON: FieldSpec[] = [
  { key: "brand", label: "Brand", dataType: "string", isIdentifier: true,
    isSearchable: true, searchWeight: 5 },
  { key: "expression", label: "Expression / Bottling", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 4 },
  { key: "age_statement_years", label: "Age Statement (years)", dataType: "number",
    isIdentifier: true, unit: "years" },
  { key: "volume_ml", label: "Volume (mL)", dataType: "number",
    isIdentifier: true, isPricingAxis: true, unit: "mL" },
  { key: "abv_pct", label: "ABV %", dataType: "number", unit: "%" },
  { key: "vintage_year", label: "Vintage / Bottling Year", dataType: "string" },
  { key: "fill_level", label: "Fill Level", dataType: "string",
    isPricingAxis: true,
    extractHint: "into_neck / high_shoulder / low_shoulder / mid_shoulder — sealed bottle level" },
  { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true },
];

// ── Path specs ─────────────────────────────────────────────────────────────

// Graphics card fields — the RTX scalper market is worth the detail.
const GPU_FIELDS: FieldSpec[] = [
  { key: "brand", label: "Brand", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 4,
    extractHint: 'AIB partner, e.g. "ASUS", "MSI", "Gigabyte", "EVGA", "Founders Edition"' },
  { key: "chipset", label: "GPU Chipset", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 5,
    extractHint: 'e.g. "RTX 4090", "RTX 4070 Ti Super", "RX 7900 XTX", "Arc A770"' },
  { key: "vram_gb", label: "VRAM (GB)", dataType: "number",
    isIdentifier: true, isPricingAxis: true, unit: "GB" },
  { key: "vram_type", label: "VRAM Type", dataType: "string",
    extractHint: "GDDR6 / GDDR6X / GDDR7 / HBM2 / HBM3" },
  { key: "tdp_w", label: "TDP / TGP (W)", dataType: "number", unit: "W" },
  { key: "pcie_interface", label: "PCIe Interface", dataType: "string",
    extractHint: "PCIe 4.0 x16 / PCIe 5.0 x16" },
  { key: "cooling", label: "Cooling Design", dataType: "string",
    extractHint: "blower / dual_fan / triple_fan / hybrid / aio" },
  { key: "power_connector", label: "Power Connector", dataType: "string",
    extractHint: "8-pin / 8+8 / 12vhpwr / 16-pin" },
  { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true },
  { key: "mining_used", label: "Previously Used for Mining", dataType: "string",
    isPricingAxis: true, extractHint: "yes / no / unknown — big discount if yes" },
];

const CPU_FIELDS: FieldSpec[] = [
  { key: "brand", label: "Brand", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 5 },
  { key: "model", label: "CPU Model", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 5,
    extractHint: 'e.g. "Core i9-14900K", "Ryzen 9 7950X3D", "Xeon Gold 6248"' },
  { key: "socket", label: "Socket", dataType: "string",
    isIdentifier: true, extractHint: "LGA1700 / AM5 / AM4 / LGA1200 / etc" },
  { key: "cores", label: "Cores", dataType: "number", isIdentifier: true },
  { key: "threads", label: "Threads", dataType: "number" },
  { key: "tdp_w", label: "TDP (W)", dataType: "number", unit: "W" },
  { key: "integrated_graphics", label: "Integrated Graphics", dataType: "string" },
  { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true },
];

const RAM_FIELDS: FieldSpec[] = [
  { key: "brand", label: "Brand", dataType: "string", isIdentifier: true, isSearchable: true },
  { key: "form_factor", label: "Form Factor", dataType: "string",
    isIdentifier: true, extractHint: "DIMM / SODIMM / CAMM2" },
  { key: "ddr_generation", label: "DDR Generation", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 3 },
  { key: "capacity_gb", label: "Capacity (GB)", dataType: "number",
    isIdentifier: true, isPricingAxis: true, unit: "GB" },
  { key: "speed_mhz", label: "Speed (MHz)", dataType: "number", unit: "MHz" },
  { key: "cas_latency", label: "CAS Latency", dataType: "string" },
  { key: "kit_count", label: "Kit Count", dataType: "number",
    extractHint: "1 / 2 / 4 (sticks in the kit)" },
  { key: "ecc", label: "ECC", dataType: "boolean", isPricingAxis: true },
  { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true },
];

const STORAGE_FIELDS: FieldSpec[] = [
  { key: "brand", label: "Brand", dataType: "string", isIdentifier: true, isSearchable: true },
  { key: "model", label: "Model", dataType: "string", isIdentifier: true },
  { key: "form_factor", label: "Form Factor", dataType: "string",
    isIdentifier: true, extractHint: "M.2 2280 / 2.5 / 3.5 / U.2 / mSATA" },
  { key: "interface", label: "Interface", dataType: "string",
    isIdentifier: true, extractHint: "NVMe PCIe 4.0 / NVMe PCIe 5.0 / SATA / SAS" },
  { key: "capacity_gb", label: "Capacity (GB)", dataType: "number",
    isIdentifier: true, isPricingAxis: true, unit: "GB" },
  { key: "endurance_tbw", label: "Endurance (TBW)", dataType: "number" },
  { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true },
];

const LEAVES: LeafSpec[] = [
  // Computers — shallow per Google; rich overlaid fields cover every
  // brand/model/chip variation as optional attributes.
  { path: "/electronics/computers",
    label: "Computers", fields: COMPUTER_BASE },
  { path: "/electronics/computers/laptops",
    label: "Laptops",
    fields: [...LAPTOP_BASE, ...APPLE_MAC_OVERLAY, ...MACBOOK_OVERLAY, ...CHROMEBOOK_OVERLAY, ...GAMING_LAPTOP_OVERLAY, ...WORKSTATION_OVERLAY] },
  { path: "/electronics/computers/desktops",
    label: "Desktops", fields: APPLE_MAC_OVERLAY },
  { path: "/electronics/mobile_phones",
    label: "Mobile Phones", fields: IPHONE_FIELDS },
  { path: "/electronics/tablets",
    label: "Tablets", fields: IPAD_FIELDS },
  { path: "/electronics/wearables",
    label: "Wearables", fields: APPLE_WATCH_FIELDS },
  { path: "/electronics/audio/headphones",
    label: "Headphones", fields: AIRPODS_FIELDS },

  // PC components — each leaf gets its own deep field schema.
  { path: "/electronics/computers/components/graphics_cards",
    label: "Graphics Cards / GPUs", fields: GPU_FIELDS },
  { path: "/electronics/computers/components/cpus",
    label: "CPUs / Processors", fields: CPU_FIELDS },
  { path: "/electronics/computers/components/memory_ram",
    label: "Memory / RAM Modules", fields: RAM_FIELDS },
  { path: "/electronics/computers/components/storage_drives",
    label: "Storage Drives (HDD / SSD)", fields: STORAGE_FIELDS },

  // Watches — single leaf per Google; brand/movement/ref go in fields.
  { path: "/apparel_accessories/jewelry/watches",
    label: "Watches", fields: GENERAL_WATCH_FIELDS },

  // Pens + ink — separate leaves (they ARE different product types).
  { path: "/office_products/writing_instruments/fountain_pens",
    label: "Fountain Pens", fields: FOUNTAIN_PEN_FIELDS },
  { path: "/office_products/writing_instruments/rollerball_pens",
    label: "Rollerball Pens", fields: FOUNTAIN_PEN_FIELDS },
  { path: "/office_products/writing_instruments/ballpoint_pens",
    label: "Ballpoint Pens", fields: FOUNTAIN_PEN_FIELDS },
  { path: "/office_products/writing_supplies/bottled_ink",
    label: "Bottled Ink", fields: INK_FIELDS },
  { path: "/office_products/writing_supplies/ink_samples",
    label: "Ink Samples", fields: INK_FIELDS },

  // Spirits expansion (legitimate market distinctions beyond GPT).
  { path: "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/mezcal",
    label: "Mezcal", fields: SPIRITS_COMMON },
  { path: "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/vermouth",
    label: "Vermouth", fields: SPIRITS_COMMON },
  { path: "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/cordials_liqueurs",
    label: "Cordials & Liqueurs", fields: SPIRITS_COMMON },
  { path: "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/japanese_whisky",
    label: "Japanese Whisky", fields: SPIRITS_COMMON },
  { path: "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/shochu",
    label: "Shochu", fields: SPIRITS_COMMON },
  { path: "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/umeshu",
    label: "Umeshu", fields: SPIRITS_COMMON },
  { path: "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/world_whisky",
    label: "World Whisky (non-Scotch/Irish/US/Japanese)", fields: SPIRITS_COMMON },
];

function humanize(slug: string): string {
  return slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function ensurePath(path: string, leafLabel: string): Promise<number> {
  const slugs = path.split("/").filter(Boolean);
  // Walk from root, creating missing nodes.
  const root = await taxonomyRepo.getRoot();
  let parentId: number = root.id;
  let currentPath = "";
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    currentPath += "/" + slug;
    const isLeaf = i === slugs.length - 1;
    const existing = await taxonomyRepo.getNodeBySlugPath(slugs.slice(0, i + 1));
    if (existing) {
      parentId = existing.id;
      continue;
    }
    const label = isLeaf ? leafLabel : humanize(slug);
    const created = await taxonomyRepo.createNode(
      { parentId, slug, label, canonical: true },
      "seed_expansion",
    );
    console.log(`  +node ${currentPath} (id=${created.id})`);
    parentId = created.id;
  }
  return parentId;
}

async function ensureFields(
  nodeId: number,
  fields: ReadonlyArray<FieldSpec>,
): Promise<void> {
  const existing = await taxonomyRepo.getFieldsForNode(nodeId);
  const existingKeys = new Set(existing.map((f) => f.key));
  for (const f of fields) {
    if (existingKeys.has(f.key)) continue;
    await taxonomyRepo.createField(
      {
        nodeId,
        key: f.key,
        label: f.label,
        dataType: f.dataType,
        unit: f.unit,
        extractHint: f.extractHint,
        isSearchable: f.isSearchable ?? false,
        searchWeight: f.searchWeight ?? 1,
        isIdentifier: f.isIdentifier ?? false,
        isPricingAxis: f.isPricingAxis ?? false,
        canonical: true,
      },
      "seed_expansion",
    );
    console.log(`    +field ${f.key} (${f.dataType}${f.isIdentifier ? ",id" : ""}${f.isPricingAxis ? ",px" : ""})`);
  }
}

async function main(): Promise<void> {
  console.log(`seeding ${LEAVES.length} leaf paths…\n`);
  for (const leaf of LEAVES) {
    console.log(`→ ${leaf.path}`);
    const leafId = await ensurePath(leaf.path, leaf.label);
    await ensureFields(leafId, leaf.fields);
  }
  console.log("\ndone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
