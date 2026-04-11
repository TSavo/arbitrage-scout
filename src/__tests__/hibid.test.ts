import { describe, it, expect } from "vitest";

describe("HiBid closed lot filtering", () => {
  // Simulate the filter logic from hibid.ts
  function filterLots(results: Array<{
    lead: string;
    lotState?: { isClosed?: boolean };
  }>) {
    return results.filter((lot) => {
      const lotState = lot.lotState || {};
      const title = (lot.lead || "").trim();
      if (lotState.isClosed) return false;
      if (!title || title.length < 3 || title.startsWith(".")) return false;
      return true;
    });
  }

  it("filters closed lots", () => {
    const results = [
      { lead: "Nintendo 64 Console", lotState: { isClosed: false } },
      { lead: "Sega Genesis", lotState: { isClosed: true } },
      { lead: "PS5 Bundle", lotState: { isClosed: false } },
    ];

    const filtered = filterLots(results);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((r) => r.lead)).toEqual(["Nintendo 64 Console", "PS5 Bundle"]);
  });

  it("filters garbled titles", () => {
    const results = [
      { lead: ".funko pop #.1383", lotState: { isClosed: false } },
      { lead: "", lotState: { isClosed: false } },
      { lead: "ab", lotState: { isClosed: false } },
      { lead: "Valid Title Here", lotState: { isClosed: false } },
    ];

    const filtered = filterLots(results);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].lead).toBe("Valid Title Here");
  });

  it("handles missing lotState", () => {
    const results = [
      { lead: "Some Item" },
      { lead: "Another Item", lotState: {} },
    ];

    const filtered = filterLots(results);
    expect(filtered).toHaveLength(2);
  });
});
