import { describe, expect, it } from "vitest";
import {
  buildGetNotionPageArgs,
  buildListNotionBlockChildrenArgs,
  buildNotionShellCommand,
  buildSearchNotionArgs,
} from "../src/lib/notion.js";

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

  it("builds block children args for page content reads", () => {
    expect(buildListNotionBlockChildrenArgs("abcd-1234")).toEqual([
      "api",
      "/v1/blocks/abcd-1234/children?page_size=100",
    ]);
    expect(buildListNotionBlockChildrenArgs("abcd-1234", "cursor-1")).toEqual([
      "api",
      "/v1/blocks/abcd-1234/children?page_size=100&start_cursor=cursor-1",
    ]);
  });

  it("builds a shell-safe ntn command", () => {
    const command = buildNotionShellCommand(buildSearchNotionArgs({
      query: "AIC 仕様",
      pageSize: 3,
    }));

    expect(command).toContain("ntn api /v1/search --data");
    expect(command).toContain("'{\"query\":\"AIC 仕様\",\"page_size\":3,\"filter\":{\"property\":\"object\",\"value\":\"page\"}}'");
  });

  it("rejects empty search query or page id", () => {
    expect(() => buildSearchNotionArgs({ query: "   " })).toThrow("Search query is required");
    expect(() => buildGetNotionPageArgs("   ")).toThrow("Notion page ID is required");
    expect(() => buildListNotionBlockChildrenArgs("   ")).toThrow("Notion page ID is required");
  });
});
