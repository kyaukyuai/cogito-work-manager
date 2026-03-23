import { describe, expect, it } from "vitest";
import { buildGetNotionPageArgs, buildSearchNotionArgs } from "../src/lib/notion.js";

describe("notion command builders", () => {
  it("builds search args for page-only Notion queries", () => {
    const args = buildSearchNotionArgs({
      query: "仕様書",
      pageSize: 5,
    });

    expect(args[0]).toBe("api");
    expect(args[1]).toBe("/v1/search");
    expect(args[2]).toBe("--data");
    expect(JSON.parse(args[3] ?? "")).toEqual({
      query: "仕様書",
      page_size: 5,
      filter: {
        property: "object",
        value: "page",
      },
    });
  });

  it("builds page facts args for one page id", () => {
    expect(buildGetNotionPageArgs("abcd-1234")).toEqual(["api", "/v1/pages/abcd-1234"]);
  });

  it("rejects empty search query or page id", () => {
    expect(() => buildSearchNotionArgs({ query: "   " })).toThrow("Search query is required");
    expect(() => buildGetNotionPageArgs("   ")).toThrow("Notion page ID is required");
  });
});
