import { describe, it, expect } from "vitest";

/**
 * Import the sequenceRatio function.
 * It's not exported, so we test it indirectly or extract it.
 * For now, replicate the fixed algorithm and test it directly.
 */
function sequenceRatio(a: string, b: string): number {
  const shorter = a.length <= b.length ? a.toLowerCase() : b.toLowerCase();
  const longer = a.length <= b.length ? b.toLowerCase() : a.toLowerCase();
  const used = new Array(longer.length).fill(false);
  let matches = 0;

  for (const ch of shorter) {
    let idx = -1;
    for (let j = 0; j < longer.length; j++) {
      if (longer[j] === ch && !used[j]) {
        idx = j;
        break;
      }
    }
    if (idx >= 0) {
      used[idx] = true;
      matches++;
    }
  }

  return (2.0 * matches) / (shorter.length + longer.length);
}

describe("sequenceRatio", () => {
  it("returns 1.0 for identical strings", () => {
    expect(sequenceRatio("Super Mario 64", "Super Mario 64")).toBeCloseTo(1.0);
  });

  it("returns 1.0 for case-insensitive match", () => {
    expect(sequenceRatio("SUPER MARIO 64", "super mario 64")).toBeCloseTo(1.0);
  });

  it("returns high score for similar strings", () => {
    const score = sequenceRatio("Super Mario 64", "Super Mario 64 N64");
    expect(score).toBeGreaterThan(0.8);
  });

  it("returns low score for dissimilar strings", () => {
    const score = sequenceRatio("Super Mario 64", "Wi-Fi Booster");
    expect(score).toBeLessThan(0.5);
  });

  it("handles repeated characters correctly", () => {
    // "aaaa" vs "aabb" — should match 2 a's, not 4
    const score = sequenceRatio("aaaa", "aabb");
    // 2 matches out of (4+4)/2 = 4 → 2*2/8 = 0.5
    expect(score).toBeCloseTo(0.5);
  });

  it("handles empty strings", () => {
    expect(sequenceRatio("", "test")).toBe(0);
    expect(sequenceRatio("", "")).toBeNaN(); // 0/0
  });
});

describe("custom card detection", () => {
  const customKeywords = [
    "custom", "fan made", "proxy", "replica", "reprint", "fake",
    "gold plated", "gold custom",
  ];

  function isCustomCard(title: string): boolean {
    const lower = title.toLowerCase();
    return customKeywords.some((kw) => lower.includes(kw));
  }

  it("detects custom Pokemon cards", () => {
    expect(isCustomCard("Pokemon Gold Custom Pikachu Card")).toBe(true);
    expect(isCustomCard("Custom Fan Made Charizard Gold Card Replica")).toBe(true);
    expect(isCustomCard("Proxy MTG Black Lotus Reprint")).toBe(true);
    expect(isCustomCard("Gold Plated Pikachu Card")).toBe(true);
  });

  it("passes real cards", () => {
    expect(isCustomCard("Charizard VMAX 020/189 Darkness Ablaze")).toBe(false);
    expect(isCustomCard("Pikachu V SWSH145 Celebrations")).toBe(false);
    expect(isCustomCard("Super Mario 64 N64 CIB")).toBe(false);
  });
});
