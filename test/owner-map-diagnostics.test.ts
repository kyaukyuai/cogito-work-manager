import { describe, expect, it } from "vitest";
import { analyzeOwnerMap } from "../src/lib/owner-map-diagnostics.js";

describe("owner map diagnostics", () => {
  it("reports entries missing slackUserId and duplicate Slack mappings", () => {
    const diagnostics = analyzeOwnerMap({
      defaultOwner: "kyaukyuai",
      entries: [
        {
          id: "kyaukyuai",
          domains: ["default"],
          keywords: [],
          linearAssignee: "y.kakui",
          slackUserId: "U1",
          primary: true,
        },
        {
          id: "opt",
          domains: ["sales"],
          keywords: ["OPT"],
          linearAssignee: "t.tahira",
          primary: false,
        },
        {
          id: "backup-opt",
          domains: ["sales"],
          keywords: [],
          linearAssignee: "t.tahira",
          slackUserId: "U1",
          primary: false,
        },
      ],
    });

    expect(diagnostics.totalEntries).toBe(3);
    expect(diagnostics.mappedSlackEntries).toBe(2);
    expect(diagnostics.unmappedSlackEntries.map((entry) => entry.id)).toEqual(["opt"]);
    expect(diagnostics.duplicateSlackUserIds).toEqual([
      {
        slackUserId: "U1",
        entryIds: ["kyaukyuai", "backup-opt"],
      },
    ]);
  });
});
