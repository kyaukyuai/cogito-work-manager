import { describe, expect, it } from "vitest";
import {
  buildAppendNotionBlockChildrenArgs,
  buildAppendNotionPageBlocksArgs,
  buildArchiveNotionBlockArgs,
  buildArchiveNotionPageArgs,
  buildCreateNotionAgendaArgs,
  buildGetNotionDatabaseArgs,
  buildGetNotionPageArgs,
  buildListNotionDatabasesArgs,
  buildListNotionBlockChildrenArgs,
  buildNotionShellCommand,
  buildQueryNotionDatabaseArgs,
  buildSearchNotionDatabasesArgs,
  buildSearchNotionArgs,
  buildUpdateNotionPageArgs,
  planNotionSectionReplacement,
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

  it("builds search args for database-only Notion queries", () => {
    const args = buildSearchNotionDatabasesArgs({
      query: "案件一覧",
      pageSize: 4,
    });

    expect(args[0]).toBe("api");
    expect(args[1]).toBe("/v1/search");
    expect(args[2]).toBe("--data");
    expect(JSON.parse(args[3] ?? "")).toEqual({
      query: "案件一覧",
      page_size: 4,
      filter: {
        property: "object",
        value: "data_source",
      },
    });
  });

  it("builds list args for keywordless database listing", () => {
    const args = buildListNotionDatabasesArgs({ pageSize: 7 });

    expect(args[0]).toBe("api");
    expect(args[1]).toBe("/v1/search");
    expect(args[2]).toBe("--data");
    expect(JSON.parse(args[3] ?? "")).toEqual({
      page_size: 7,
      filter: {
        property: "object",
        value: "data_source",
      },
    });
  });

  it("builds database args for one database id and a simple query", () => {
    expect(buildGetNotionDatabaseArgs("db-1234")).toEqual(["api", "/v1/data_sources/db-1234"]);
    expect(buildQueryNotionDatabaseArgs({ databaseId: "db-1234", pageSize: 3 })).toEqual([
      "api",
      "/v1/data_sources/db-1234/query",
      "--data",
      JSON.stringify({ page_size: 3 }),
    ]);
  });

  it("builds database query args with filter and sort using schema", () => {
    const args = buildQueryNotionDatabaseArgs(
      {
        databaseId: "db-1234",
        pageSize: 5,
        filterProperty: "Status",
        filterOperator: "equals",
        filterValue: "進行中",
        sortProperty: "期限",
        sortDirection: "ascending",
      },
      {
        Status: {
          name: "Status",
          type: "status",
          options: ["進行中", "完了"],
        },
        期限: {
          name: "期限",
          type: "date",
        },
      },
    );

    expect(args[0]).toBe("api");
    expect(args[1]).toBe("/v1/data_sources/db-1234/query");
    expect(args[2]).toBe("--data");
    expect(JSON.parse(args[3] ?? "")).toEqual({
      page_size: 5,
      filter: {
        property: "Status",
        status: {
          equals: "進行中",
        },
      },
      sorts: [
        {
          property: "期限",
          direction: "ascending",
        },
      ],
    });
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

  it("builds create args for a Notion agenda page", () => {
    const args = buildCreateNotionAgendaArgs({
      title: "AIクローン会議アジェンダ",
      parentPageId: "parent-page-1",
      summary: "キックオフ前に確認する論点をまとめます。",
      sections: [
        {
          heading: "議題",
          bullets: ["PoC 対象範囲", "役割分担"],
        },
        {
          heading: "確認事項",
          paragraph: "未確定事項を事前に洗い出します。",
        },
      ],
    });

    expect(args[0]).toBe("api");
    expect(args[1]).toBe("/v1/pages");
    expect(args[2]).toBe("--data");
    expect(JSON.parse(args[3] ?? "")).toEqual({
      parent: {
        type: "page_id",
        page_id: "parent-page-1",
      },
      properties: {
        title: {
          title: [
            {
              type: "text",
              text: {
                content: "AIクローン会議アジェンダ",
              },
            },
          ],
        },
      },
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: "キックオフ前に確認する論点をまとめます。",
                },
              },
            ],
          },
        },
        {
          object: "block",
          type: "heading_2",
          heading_2: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: "議題",
                },
              },
            ],
          },
        },
        {
          object: "block",
          type: "bulleted_list_item",
          bulleted_list_item: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: "PoC 対象範囲",
                },
              },
            ],
          },
        },
        {
          object: "block",
          type: "bulleted_list_item",
          bulleted_list_item: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: "役割分担",
                },
              },
            ],
          },
        },
        {
          object: "block",
          type: "heading_2",
          heading_2: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: "確認事項",
                },
              },
            ],
          },
        },
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: "未確定事項を事前に洗い出します。",
                },
              },
            ],
          },
        },
      ],
    });
  });

  it("builds page update args for a Notion title update", () => {
    const args = buildUpdateNotionPageArgs({
      pageId: "page-1234",
      title: "更新後タイトル",
    });

    expect(args).toEqual([
      "api",
      "/v1/pages/page-1234",
      "--method",
      "PATCH",
      "--data",
      JSON.stringify({
        properties: {
          title: {
            title: [
              {
                type: "text",
                text: {
                  content: "更新後タイトル",
                },
              },
            ],
          },
        },
      }),
    ]);
  });

  it("builds append args for a Notion page update", () => {
    const args = buildAppendNotionPageBlocksArgs({
      pageId: "page-1234",
      summary: "今回の追記です。",
      sections: [
        {
          heading: "決定事項",
          bullets: ["A案で進める", "来週確認する"],
        },
      ],
    });

    expect(args).toEqual([
      "api",
      "/v1/blocks/page-1234/children",
      "--method",
      "PATCH",
      "--data",
      JSON.stringify({
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [
                {
                  type: "text",
                  text: {
                    content: "今回の追記です。",
                  },
                },
              ],
            },
          },
          {
            object: "block",
            type: "heading_2",
            heading_2: {
              rich_text: [
                {
                  type: "text",
                  text: {
                    content: "決定事項",
                  },
                },
              ],
            },
          },
          {
            object: "block",
            type: "bulleted_list_item",
            bulleted_list_item: {
              rich_text: [
                {
                  type: "text",
                  text: {
                    content: "A案で進める",
                  },
                },
              ],
            },
          },
          {
            object: "block",
            type: "bulleted_list_item",
            bulleted_list_item: {
              rich_text: [
                {
                  type: "text",
                  text: {
                    content: "来週確認する",
                  },
                },
              ],
            },
          },
        ],
      }),
    ]);
  });

  it("builds append args for block children after a target block", () => {
    const args = buildAppendNotionBlockChildrenArgs(
      "page-1234",
      [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: "更新後の段落です。",
                },
              },
            ],
          },
        },
      ],
      "heading-2",
    );

    expect(args).toEqual([
      "api",
      "/v1/blocks/page-1234/children",
      "--method",
      "PATCH",
      "--data",
      JSON.stringify({
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [
                {
                  type: "text",
                  text: {
                    content: "更新後の段落です。",
                  },
                },
              ],
            },
          },
        ],
        after: "heading-2",
      }),
    ]);
  });

  it("builds archive args for a Notion block", () => {
    expect(buildArchiveNotionBlockArgs("block-1234")).toEqual([
      "api",
      "/v1/blocks/block-1234",
      "--method",
      "PATCH",
      "--data",
      JSON.stringify({ archived: true }),
    ]);
  });

  it("plans a top-level heading_2 section replacement", () => {
    const plan = planNotionSectionReplacement([
      {
        id: "heading-purpose",
        type: "heading_2",
        heading_2: {
          rich_text: [{ plain_text: "目的" }],
        },
      },
      {
        id: "purpose-body",
        type: "paragraph",
        paragraph: {
          rich_text: [{ plain_text: "背景" }],
        },
      },
      {
        id: "heading-agenda",
        type: "heading_2",
        heading_2: {
          rich_text: [{ plain_text: "議題" }],
        },
      },
      {
        id: "agenda-body",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: [{ plain_text: "確認事項" }],
        },
      },
      {
        id: "heading-next",
        type: "heading_2",
        heading_2: {
          rich_text: [{ plain_text: "次のアクション" }],
        },
      },
    ], "議題");

    expect(plan).toEqual({
      headingBlockId: "heading-agenda",
      archivedBlockIds: ["agenda-body"],
      availableHeadings: ["目的", "議題", "次のアクション"],
    });
  });

  it("rejects a missing heading_2 section with available candidates", () => {
    expect(() => planNotionSectionReplacement([
      {
        id: "heading-purpose",
        type: "heading_2",
        heading_2: {
          rich_text: [{ plain_text: "目的" }],
        },
      },
    ], "議題")).toThrow('Available headings: 目的');
  });

  it("builds archive args for a Notion page", () => {
    expect(buildArchiveNotionPageArgs("page-1234")).toEqual([
      "api",
      "/v1/pages/page-1234",
      "--method",
      "PATCH",
      "--data",
      JSON.stringify({ in_trash: true }),
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
    expect(() => buildSearchNotionDatabasesArgs({ query: "   " })).toThrow("Search query is required");
    expect(() => buildGetNotionPageArgs("   ")).toThrow("Notion page ID is required");
    expect(() => buildGetNotionDatabaseArgs("   ")).toThrow("Notion database ID is required");
    expect(() => buildListNotionBlockChildrenArgs("   ")).toThrow("Notion page ID is required");
    expect(() => buildQueryNotionDatabaseArgs({ databaseId: "   " })).toThrow("Notion database ID is required");
    expect(() => buildCreateNotionAgendaArgs({ title: "   ", parentPageId: "page-1" })).toThrow("Notion agenda title is required");
    expect(() => buildCreateNotionAgendaArgs({ title: "アジェンダ", parentPageId: "   " })).toThrow("Notion agenda parent page ID is required");
    expect(() => buildUpdateNotionPageArgs({ pageId: "   ", title: "更新" })).toThrow("Notion page ID is required");
    expect(() => buildAppendNotionPageBlocksArgs({ pageId: "page-1" })).toThrow("Notion page append content is required");
    expect(() => buildAppendNotionBlockChildrenArgs("   ", [])).toThrow("Notion block ID is required");
    expect(() => buildArchiveNotionBlockArgs("   ")).toThrow("Notion block ID is required");
    expect(() => buildArchiveNotionPageArgs("   ")).toThrow("Notion page ID is required");
  });
});
