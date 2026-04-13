/**
 * Seed taxonomy v2 — expand coverage for the second Shopify probe batch:
 * home audio (turntables/speakers/phonostages), musical instruments
 * (guitars/amps/pedals), EDC knives, footwear/sneakers, watch accessories.
 *
 * Same pattern as seed_expansion.ts. Idempotent — safe to re-run.
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
  readonly fields: ReadonlyArray<FieldSpec>;
}

// ── Shared helpers ─────────────────────────────────────────────────────────

const BRAND_MODEL_YEAR: FieldSpec[] = [
  { key: "brand", label: "Brand", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 5 },
  { key: "model", label: "Model", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 5 },
  { key: "model_year", label: "Model Year", dataType: "string",
    isIdentifier: true },
  { key: "color_finish", label: "Color / Finish", dataType: "string",
    isIdentifier: true },
  { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true,
    extractHint: "new_sealed / like_new / good / fair / parts" },
];

// ── Home Audio ────────────────────────────────────────────────────────────

const AMPLIFIER_FIELDS: FieldSpec[] = [
  ...BRAND_MODEL_YEAR,
  { key: "circuit_type", label: "Circuit Type", dataType: "string",
    isIdentifier: true, isPricingAxis: true,
    extractHint: "tube / solid_state / hybrid / class_d" },
  { key: "watts_per_channel", label: "Watts per Channel (8Ω)",
    dataType: "number", unit: "W", isPricingAxis: true },
  { key: "channels", label: "Channels", dataType: "number",
    extractHint: "2 (stereo) / 5.1 / 7.1 / monoblock" },
  { key: "phono_stage", label: "Built-in Phono Stage", dataType: "boolean" },
  { key: "dac_included", label: "Built-in DAC", dataType: "boolean" },
  { key: "balanced_inputs", label: "Balanced (XLR) Inputs", dataType: "boolean",
    isPricingAxis: true },
];

const SPEAKER_FIELDS: FieldSpec[] = [
  ...BRAND_MODEL_YEAR,
  { key: "driver_config", label: "Driver Configuration", dataType: "string",
    isIdentifier: true,
    extractHint: '2-way / 3-way / 4-way; woofer sizes, e.g. "2x8in + 1in tweeter"' },
  { key: "sensitivity_db", label: "Sensitivity (dB/W/m)", dataType: "number",
    unit: "dB" },
  { key: "impedance_ohms", label: "Impedance (Ω)", dataType: "number", unit: "Ω" },
  { key: "frequency_response", label: "Frequency Response", dataType: "string",
    extractHint: '"30Hz–20kHz (±3dB)" or similar' },
  { key: "cabinet_material", label: "Cabinet Material", dataType: "string" },
  { key: "pair_or_single", label: "Sold as Pair or Single", dataType: "string",
    isPricingAxis: true, extractHint: "pair / single" },
];

const TURNTABLE_FIELDS: FieldSpec[] = [
  ...BRAND_MODEL_YEAR,
  { key: "drive_type", label: "Drive Type", dataType: "string",
    isIdentifier: true, isPricingAxis: true,
    extractHint: "belt / direct / idler" },
  { key: "cartridge_included", label: "Cartridge Included", dataType: "string",
    isPricingAxis: true, extractHint: "model name if included, else 'none'" },
  { key: "phono_stage_included", label: "Built-in Phono Stage", dataType: "boolean" },
  { key: "auto_return", label: "Auto Return", dataType: "boolean" },
  { key: "speed_support", label: "Speed Support", dataType: "string",
    extractHint: "33/45 / 33/45/78" },
  { key: "tonearm_type", label: "Tonearm Type", dataType: "string",
    extractHint: "straight / s-shape / unipivot / linear_tracking" },
];

const CARTRIDGE_FIELDS: FieldSpec[] = [
  ...BRAND_MODEL_YEAR,
  { key: "cartridge_type", label: "Cartridge Type", dataType: "string",
    isIdentifier: true, isPricingAxis: true,
    extractHint: "mm (moving_magnet) / mc (moving_coil) / mi (moving_iron)" },
  { key: "stylus_shape", label: "Stylus Shape", dataType: "string",
    isPricingAxis: true,
    extractHint: "spherical / elliptical / shibata / line_contact / micro_ridge" },
  { key: "output_voltage_mv", label: "Output Voltage (mV)", dataType: "number",
    unit: "mV" },
  { key: "tracking_force_g", label: "Tracking Force (g)", dataType: "number",
    unit: "g" },
  { key: "stylus_replaceable", label: "Stylus Replaceable", dataType: "boolean" },
];

const PHONOSTAGE_FIELDS: FieldSpec[] = [
  ...BRAND_MODEL_YEAR,
  { key: "mm_mc_support", label: "MM / MC Support", dataType: "string",
    isIdentifier: true, isPricingAxis: true,
    extractHint: "mm_only / mc_only / both" },
  { key: "gain_db", label: "Gain (dB)", dataType: "number", unit: "dB" },
  { key: "circuit_type", label: "Circuit Type", dataType: "string",
    extractHint: "tube / solid_state / hybrid" },
  { key: "balanced_outputs", label: "Balanced Outputs", dataType: "boolean" },
];

const PREAMP_FIELDS: FieldSpec[] = [
  ...BRAND_MODEL_YEAR,
  { key: "circuit_type", label: "Circuit Type", dataType: "string",
    isIdentifier: true, isPricingAxis: true,
    extractHint: "tube / solid_state / hybrid" },
  { key: "remote_control", label: "Remote Control", dataType: "boolean" },
  { key: "balanced_io", label: "Balanced I/O", dataType: "boolean", isPricingAxis: true },
  { key: "phono_stage", label: "Built-in Phono Stage", dataType: "boolean" },
];

const DISC_PLAYER_FIELDS: FieldSpec[] = [
  ...BRAND_MODEL_YEAR,
  { key: "media", label: "Media Support", dataType: "string",
    isIdentifier: true,
    extractHint: "cd / sacd / cd_sacd / blu_ray / universal" },
  { key: "dac_type", label: "DAC Chipset", dataType: "string" },
];

// ── Musical Instruments ───────────────────────────────────────────────────

const ELECTRIC_GUITAR_FIELDS: FieldSpec[] = [
  ...BRAND_MODEL_YEAR,
  { key: "body_shape", label: "Body Shape", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 4,
    extractHint: '"Stratocaster", "Les Paul", "Telecaster", "SG", "Flying V", "Explorer"' },
  { key: "body_material", label: "Body Material", dataType: "string",
    extractHint: "alder / ash / mahogany / basswood / maple" },
  { key: "neck_material", label: "Neck Material", dataType: "string" },
  { key: "fretboard_material", label: "Fretboard Material", dataType: "string",
    extractHint: "rosewood / maple / ebony / pau_ferro" },
  { key: "pickup_config", label: "Pickup Configuration", dataType: "string",
    isIdentifier: true, isPricingAxis: true,
    extractHint: "SSS / HH / HSS / HSH / P90 / active_HH" },
  { key: "scale_length_in", label: "Scale Length (inches)", dataType: "number",
    unit: "in" },
  { key: "country_of_origin", label: "Country of Origin", dataType: "string",
    isPricingAxis: true,
    extractHint: "USA / Mexico / Japan / Korea / China / Indonesia" },
  { key: "case_included", label: "Case Included", dataType: "string",
    isPricingAxis: true, extractHint: "hardshell / gigbag / none" },
  { key: "serial_number", label: "Serial Number", dataType: "string", isIdentifier: true },
];

const ACOUSTIC_GUITAR_FIELDS: FieldSpec[] = [
  ...BRAND_MODEL_YEAR,
  { key: "body_shape", label: "Body Shape", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 4,
    extractHint: "dreadnought / concert / om / auditorium / jumbo / parlor / 000" },
  { key: "top_wood", label: "Top Wood", dataType: "string",
    isPricingAxis: true,
    extractHint: "solid_sitka / solid_adirondack / solid_cedar / laminate" },
  { key: "back_sides_wood", label: "Back & Sides Wood", dataType: "string",
    isPricingAxis: true,
    extractHint: "mahogany / rosewood / maple / koa / cocobolo" },
  { key: "electronics", label: "Electronics", dataType: "string",
    extractHint: "none / piezo / mic_piezo / active" },
  { key: "country_of_origin", label: "Country of Origin", dataType: "string",
    isPricingAxis: true },
  { key: "case_included", label: "Case Included", dataType: "string", isPricingAxis: true },
  { key: "serial_number", label: "Serial Number", dataType: "string", isIdentifier: true },
];

const BASS_GUITAR_FIELDS: FieldSpec[] = [
  ...BRAND_MODEL_YEAR,
  { key: "string_count", label: "String Count", dataType: "number",
    isIdentifier: true, extractHint: "4 / 5 / 6" },
  { key: "body_shape", label: "Body Shape", dataType: "string",
    isIdentifier: true, extractHint: "P-Bass / J-Bass / Stingray / Thunderbird" },
  { key: "pickup_config", label: "Pickup Configuration", dataType: "string" },
  { key: "scale_length", label: "Scale Length", dataType: "string",
    extractHint: "long / medium / short" },
  { key: "active_passive", label: "Active or Passive", dataType: "string",
    isPricingAxis: true },
];

const GUITAR_AMP_FIELDS: FieldSpec[] = [
  ...BRAND_MODEL_YEAR,
  { key: "configuration", label: "Configuration", dataType: "string",
    isIdentifier: true, isPricingAxis: true,
    extractHint: "combo / head / cabinet / rack" },
  { key: "wattage", label: "Wattage", dataType: "number", unit: "W",
    isPricingAxis: true },
  { key: "circuit_type", label: "Circuit Type", dataType: "string",
    isIdentifier: true, isPricingAxis: true,
    extractHint: "tube / solid_state / modeling / hybrid" },
  { key: "speaker_config", label: "Speaker Configuration", dataType: "string",
    extractHint: '"1x12", "2x12", "4x12", "1x15"' },
  { key: "channels", label: "Channels", dataType: "number" },
  { key: "effects", label: "Built-in Effects", dataType: "string",
    extractHint: "reverb / tremolo / delay / none" },
];

const EFFECTS_PEDAL_FIELDS: FieldSpec[] = [
  ...BRAND_MODEL_YEAR,
  { key: "effect_type", label: "Effect Type", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 4,
    extractHint: "overdrive / distortion / fuzz / delay / reverb / chorus / flanger / phaser / compressor / eq / looper / multi_effect" },
  { key: "true_bypass", label: "True Bypass", dataType: "boolean" },
  { key: "power", label: "Power", dataType: "string",
    extractHint: "9v_center_negative / 18v / battery / usb_c" },
  { key: "stereo", label: "Stereo I/O", dataType: "boolean" },
];

const DRUM_KIT_FIELDS: FieldSpec[] = [
  ...BRAND_MODEL_YEAR,
  { key: "shell_material", label: "Shell Material", dataType: "string",
    isIdentifier: true,
    extractHint: "maple / birch / mahogany / acrylic / steel" },
  { key: "piece_count", label: "Piece Count", dataType: "number",
    isIdentifier: true, extractHint: "4-pc / 5-pc / 7-pc" },
  { key: "cymbals_included", label: "Cymbals Included", dataType: "boolean" },
  { key: "hardware_included", label: "Hardware Included", dataType: "boolean" },
];

const KEYBOARD_FIELDS: FieldSpec[] = [
  ...BRAND_MODEL_YEAR,
  { key: "key_count", label: "Key Count", dataType: "number",
    isIdentifier: true, extractHint: "25 / 37 / 49 / 61 / 73 / 76 / 88" },
  { key: "weighted", label: "Weighted Keys", dataType: "string",
    isPricingAxis: true, extractHint: "fully_weighted / semi_weighted / synth_action" },
  { key: "keyboard_type", label: "Keyboard Type", dataType: "string",
    isIdentifier: true,
    extractHint: "synth / workstation / digital_piano / midi_controller / organ" },
  { key: "polyphony", label: "Polyphony", dataType: "number",
    extractHint: "max simultaneous voices" },
];

// ── Watch Accessories ─────────────────────────────────────────────────────

const WATCH_STRAP_FIELDS: FieldSpec[] = [
  { key: "brand", label: "Brand", dataType: "string", isIdentifier: true, isSearchable: true },
  { key: "material", label: "Material", dataType: "string",
    isIdentifier: true, isPricingAxis: true,
    extractHint: "leather / rubber / stainless_steel / titanium / nylon / fkm / silicone / fabric" },
  { key: "lug_width_mm", label: "Lug Width (mm)", dataType: "number",
    isIdentifier: true, unit: "mm",
    extractHint: "18 / 19 / 20 / 21 / 22 / 24" },
  { key: "color", label: "Color", dataType: "string", isIdentifier: true },
  { key: "strap_style", label: "Strap Style", dataType: "string",
    extractHint: "nato / zulu / bracelet / two_piece / jubilee / oyster" },
  { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true },
];

// ── Footwear / Sneakers ───────────────────────────────────────────────────

const SNEAKER_FIELDS: FieldSpec[] = [
  { key: "brand", label: "Brand", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 5 },
  { key: "silhouette", label: "Silhouette / Model", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 5,
    extractHint: '"Air Jordan 1 High", "Dunk Low", "New Balance 550", "Yeezy Foam Runner"' },
  { key: "colorway", label: "Colorway", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 4,
    extractHint: '"Chicago", "Travis Scott", "Bred", "Panda"' },
  { key: "style_code", label: "Style Code / SKU", dataType: "string",
    isIdentifier: true, isSearchable: true, searchWeight: 5,
    extractHint: 'Manufacturer SKU like "DZ5485-612" or "555088-134"' },
  { key: "size_us", label: "Size (US)", dataType: "string",
    isIdentifier: true, isPricingAxis: true },
  { key: "gender", label: "Gender Cut", dataType: "string",
    isIdentifier: true, extractHint: "men / women / gs (grade_school) / ps / td (toddler) / unisex" },
  { key: "release_year", label: "Release Year", dataType: "string" },
  { key: "box_condition", label: "Box Condition", dataType: "string",
    isPricingAxis: true, extractHint: "original_box / replacement_box / no_box" },
  { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true,
    extractHint: "deadstock / used_excellent / used_good / used_fair" },
];

// ── EDC Knives ────────────────────────────────────────────────────────────

const FOLDING_KNIFE_FIELDS: FieldSpec[] = [
  ...BRAND_MODEL_YEAR,
  { key: "blade_length_in", label: "Blade Length (inches)", dataType: "number",
    isIdentifier: true, unit: "in" },
  { key: "blade_steel", label: "Blade Steel", dataType: "string",
    isIdentifier: true, isPricingAxis: true, isSearchable: true, searchWeight: 4,
    extractHint: 'e.g. "S30V", "M390", "Magnacut", "S35VN", "D2", "154CM", "VG-10"' },
  { key: "blade_shape", label: "Blade Shape", dataType: "string",
    extractHint: "drop_point / clip_point / tanto / sheepsfoot / wharncliffe / spear_point / hawkbill" },
  { key: "blade_finish", label: "Blade Finish", dataType: "string",
    extractHint: "stonewash / satin / black_dlc / coated / mirror" },
  { key: "handle_material", label: "Handle Material", dataType: "string",
    isIdentifier: true,
    extractHint: "g10 / micarta / titanium / carbon_fiber / fat_carbon / aluminum / g10_micarta" },
  { key: "lock_type", label: "Lock Type", dataType: "string",
    isIdentifier: true, isPricingAxis: true,
    extractHint: "liner / frame / axis / compression / slip_joint / button / crossbar" },
  { key: "opener_type", label: "Opener Type", dataType: "string",
    extractHint: "flipper / thumb_stud / thumb_hole / nail_nick / front_flipper" },
  { key: "pocket_clip", label: "Pocket Clip", dataType: "string",
    extractHint: "tip_up_right / tip_up_left / tip_down / deep_carry / none" },
  { key: "country_of_origin", label: "Country of Origin", dataType: "string",
    isPricingAxis: true, extractHint: "usa / japan / china / taiwan / italy / germany" },
];

const FIXED_BLADE_FIELDS: FieldSpec[] = [
  ...BRAND_MODEL_YEAR,
  { key: "blade_length_in", label: "Blade Length (inches)", dataType: "number",
    isIdentifier: true, unit: "in" },
  { key: "blade_steel", label: "Blade Steel", dataType: "string",
    isIdentifier: true, isPricingAxis: true, isSearchable: true, searchWeight: 4 },
  { key: "blade_shape", label: "Blade Shape", dataType: "string" },
  { key: "tang_type", label: "Tang Type", dataType: "string",
    extractHint: "full_tang / partial_tang / hidden_tang / skeletonized_tang" },
  { key: "handle_material", label: "Handle Material", dataType: "string", isIdentifier: true },
  { key: "sheath_type", label: "Sheath Type", dataType: "string",
    extractHint: "kydex / leather / molded / none" },
  { key: "country_of_origin", label: "Country of Origin", dataType: "string" },
];

const FLASHLIGHT_FIELDS: FieldSpec[] = [
  ...BRAND_MODEL_YEAR,
  { key: "max_lumens", label: "Max Lumens", dataType: "number", unit: "lm",
    isIdentifier: true, isPricingAxis: true },
  { key: "battery_type", label: "Battery Type", dataType: "string",
    isIdentifier: true, extractHint: "18650 / 21700 / 14500 / aa / aaa / cr123 / built_in" },
  { key: "tint_cct", label: "Tint / CCT", dataType: "string",
    extractHint: "3000k / 4500k / 5700k / 6500k / neutral_white / high_cri" },
  { key: "ip_rating", label: "IP Rating", dataType: "string" },
  { key: "form_factor", label: "Form Factor", dataType: "string",
    extractHint: "edc / tactical / headlamp / pocket / right_angle" },
];

// ── Leaves ────────────────────────────────────────────────────────────────

const LEAVES: LeafSpec[] = [
  // Home Audio — the HiFi market has deep resale value.
  { path: "/electronics/audio/home_audio/amplifiers_integrated",
    label: "Integrated Amplifiers", fields: AMPLIFIER_FIELDS },
  { path: "/electronics/audio/home_audio/amplifiers_power",
    label: "Power Amplifiers", fields: AMPLIFIER_FIELDS },
  { path: "/electronics/audio/home_audio/receivers",
    label: "Stereo / AV Receivers", fields: AMPLIFIER_FIELDS },
  { path: "/electronics/audio/home_audio/speakers_floorstanding",
    label: "Floorstanding Speakers", fields: SPEAKER_FIELDS },
  { path: "/electronics/audio/home_audio/speakers_bookshelf",
    label: "Bookshelf Speakers", fields: SPEAKER_FIELDS },
  { path: "/electronics/audio/home_audio/subwoofers",
    label: "Subwoofers", fields: SPEAKER_FIELDS },
  { path: "/electronics/audio/home_audio/turntables",
    label: "Turntables / Record Players", fields: TURNTABLE_FIELDS },
  { path: "/electronics/audio/home_audio/tonearms",
    label: "Tonearms", fields: BRAND_MODEL_YEAR },
  { path: "/electronics/audio/home_audio/cartridges",
    label: "Phono Cartridges", fields: CARTRIDGE_FIELDS },
  { path: "/electronics/audio/home_audio/phonostages",
    label: "Phono Preamplifiers (Phonostages)", fields: PHONOSTAGE_FIELDS },
  { path: "/electronics/audio/home_audio/preamplifiers",
    label: "Preamplifiers (Line-Level)", fields: PREAMP_FIELDS },
  { path: "/electronics/audio/home_audio/disc_players",
    label: "CD / SACD / Blu-Ray Players", fields: DISC_PLAYER_FIELDS },
  { path: "/electronics/audio/home_audio/dacs",
    label: "DACs (Digital-to-Analog Converters)", fields: BRAND_MODEL_YEAR },

  // Musical Instruments
  { path: "/arts_entertainment/hobbies_creative_arts/musical_instruments/electric_guitars",
    label: "Electric Guitars", fields: ELECTRIC_GUITAR_FIELDS },
  { path: "/arts_entertainment/hobbies_creative_arts/musical_instruments/acoustic_guitars",
    label: "Acoustic Guitars", fields: ACOUSTIC_GUITAR_FIELDS },
  { path: "/arts_entertainment/hobbies_creative_arts/musical_instruments/bass_guitars",
    label: "Bass Guitars", fields: BASS_GUITAR_FIELDS },
  { path: "/arts_entertainment/hobbies_creative_arts/musical_instruments/guitar_amps",
    label: "Guitar Amplifiers", fields: GUITAR_AMP_FIELDS },
  { path: "/arts_entertainment/hobbies_creative_arts/musical_instruments/effects_pedals",
    label: "Guitar Effects Pedals", fields: EFFECTS_PEDAL_FIELDS },
  { path: "/arts_entertainment/hobbies_creative_arts/musical_instruments/drum_kits",
    label: "Drum Kits", fields: DRUM_KIT_FIELDS },
  { path: "/arts_entertainment/hobbies_creative_arts/musical_instruments/keyboards_synths",
    label: "Keyboards / Synthesizers / Pianos", fields: KEYBOARD_FIELDS },
  { path: "/arts_entertainment/hobbies_creative_arts/musical_instruments/violins",
    label: "Violins / Fiddles", fields: BRAND_MODEL_YEAR },

  // Watch accessories
  { path: "/apparel_accessories/jewelry/watch_accessories/watch_straps",
    label: "Watch Straps / Bands", fields: WATCH_STRAP_FIELDS },
  { path: "/apparel_accessories/jewelry/watch_accessories/watch_tools",
    label: "Watch Tools & Buckles", fields: BRAND_MODEL_YEAR },

  // Footwear / Sneakers
  { path: "/apparel_accessories/footwear/sneakers",
    label: "Sneakers / Athletic Shoes", fields: SNEAKER_FIELDS },
  { path: "/apparel_accessories/footwear/boots",
    label: "Boots", fields: SNEAKER_FIELDS },
  { path: "/apparel_accessories/footwear/dress_shoes",
    label: "Dress Shoes", fields: SNEAKER_FIELDS },

  // EDC Knives (distinct from kitchen)
  { path: "/hardware/tools/hand_tools/knives/folding_knives",
    label: "Folding Knives", fields: FOLDING_KNIFE_FIELDS },
  { path: "/hardware/tools/hand_tools/knives/fixed_blade_knives",
    label: "Fixed Blade Knives", fields: FIXED_BLADE_FIELDS },
  { path: "/hardware/tools/hand_tools/knives/tactical_knives",
    label: "Tactical / Combat Knives", fields: FOLDING_KNIFE_FIELDS },
  { path: "/hardware/tools/hand_tools/knives/automatic_knives",
    label: "Automatic / OTF Knives", fields: FOLDING_KNIFE_FIELDS },
  { path: "/hardware/tools/flashlights_edc",
    label: "EDC Flashlights", fields: FLASHLIGHT_FIELDS },
];

function humanize(slug: string): string {
  return slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function ensurePath(path: string, leafLabel: string): Promise<number> {
  const slugs = path.split("/").filter(Boolean);
  const root = await taxonomyRepo.getRoot();
  let parentId: number = root.id;
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    const isLeaf = i === slugs.length - 1;
    const existing = await taxonomyRepo.getNodeBySlugPath(slugs.slice(0, i + 1));
    if (existing) { parentId = existing.id; continue; }
    const label = isLeaf ? leafLabel : humanize(slug);
    const created = await taxonomyRepo.createNode(
      { parentId, slug, label, canonical: true },
      "seed_expansion_v2",
    );
    console.log(`  +node /${slugs.slice(0, i + 1).join("/")} (id=${created.id})`);
    parentId = created.id;
  }
  return parentId;
}

async function ensureFields(nodeId: number, fields: ReadonlyArray<FieldSpec>): Promise<void> {
  const existing = await taxonomyRepo.getFieldsForNode(nodeId);
  const existingKeys = new Set(existing.map((f) => f.key));
  for (const f of fields) {
    if (existingKeys.has(f.key)) continue;
    await taxonomyRepo.createField(
      {
        nodeId, key: f.key, label: f.label, dataType: f.dataType,
        unit: f.unit, extractHint: f.extractHint,
        isSearchable: f.isSearchable ?? false,
        searchWeight: f.searchWeight ?? 1,
        isIdentifier: f.isIdentifier ?? false,
        isPricingAxis: f.isPricingAxis ?? false,
        canonical: true,
      },
      "seed_expansion_v2",
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

main().catch((e) => { console.error(e); process.exit(1); });
