import { describe, expect, it } from "vitest";
import { buildSlackMessagePayload, formatSlackMessageText } from "./slack-format.js";

describe("formatSlackMessageText", () => {
  it("converts standard markdown emphasis to Slack mrkdwn", () => {
    const result = formatSlackMessageText("**bold** *italic* ~~strike~~");

    expect(result).toContain("*bold*");
    expect(result).toContain("*italic*");
    expect(result).toContain("~strike~");
  });

  it("converts markdown links and headings", () => {
    const result = formatSlackMessageText("# Header\n[Google](https://google.com)");

    expect(result).toContain("*Header*");
    expect(result).toContain("<https://google.com|Google>");
  });

  it("keeps Slack-compatible emoji aliases while removing raw double-asterisk markup", () => {
    const result = formatSlackMessageText([
      "> URLのスレッドを確認しますね。少々お待ちください。申し訳ありません、そのSlackチャンネル（`C06KC7MA0G5`）のスレッドにはアクセス権がなく、内容を取得できませんでした。",
      "",
      ":clipboard: **次のいずれかをお知らせいただけますか？**",
      "",
      "- スレッドの内容や対応したいタスクの概要を、こちらのチャットに貼り付けていただく",
    ].join("\n"));

    expect(result).toContain(":clipboard:");
    expect(result).toContain("*次のいずれかをお知らせいただけますか？*");
    expect(result).not.toContain("**次のいずれかをお知らせいただけますか？**");
  });

  it("builds mrkdwn blocks and plain-text fallback for public posts", () => {
    const payload = buildSlackMessagePayload([
      "週次レビューの結果、注意が必要なissueが3件あります。- *AIC-38*「OPT社の社内チャネルへの招待依頼」— 3/19期限で*期限超過*。",
      "",
      "- *AIC-39*「AIマネージャーを実用レベルへ引き上げる」— 3/26期限。",
    ].join("\n"));

    expect(payload.text).not.toContain("*AIC-38*");
    expect(payload.blocks[0]?.text.text).toContain("あります。\n- *AIC-38*");
    expect(payload.blocks[0]?.text.text).toContain("- *AIC-39*");
  });
});
