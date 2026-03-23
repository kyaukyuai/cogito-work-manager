const SLACK_SECTION_TEXT_LIMIT = 3000;

export interface SlackMessagePayload {
  text: string;
  blocks: Array<{
    type: "section";
    text: {
      type: "mrkdwn";
      text: string;
    };
  }>;
}

function normalizeInlineBullets(text: string): string {
  return text
    .replace(/([。!！?？])\s*-\s+/g, "$1\n- ")
    .replace(/([。!！?？])\s*•\s+/g, "$1\n- ")
    .replace(/\n?•\s+/g, "\n- ");
}

function splitLongLine(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const breakAt = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "), slice.lastIndexOf("、"));
    const cut = breakAt >= Math.floor(maxLength * 0.6) ? breakAt : maxLength;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function splitSlackMrkdwnSections(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const sections: string[] = [];
  let current = "";

  const pushPart = (part: string) => {
    if (!part) return;
    if (!current) {
      current = part;
      return;
    }
    const candidate = `${current}\n\n${part}`;
    if (candidate.length <= SLACK_SECTION_TEXT_LIMIT) {
      current = candidate;
      return;
    }
    sections.push(current);
    current = part;
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length <= SLACK_SECTION_TEXT_LIMIT) {
      pushPart(paragraph);
      continue;
    }
    const lines = paragraph.split("\n").flatMap((line) => splitLongLine(line, SLACK_SECTION_TEXT_LIMIT));
    for (const line of lines) {
      pushPart(line);
    }
  }

  if (current) {
    sections.push(current);
  }

  return sections;
}

function formatSlackPlainText(mrkdwn: string): string {
  return mrkdwn
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/^[>]\s?/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatSlackMessageText(markdown: string): string {
  let text = markdown;
  const boldPlaceholders: string[] = [];

  text = text.replace(/[\u200B-\u200D\uFEFF]/g, "");
  text = text.replace(/```[a-zA-Z0-9_-]+\n/g, "```\n");
  text = text.replace(/^(#{1,6})\s+(.+)$/gm, (_match, _hashes, content: string) => {
    const index = boldPlaceholders.push(content.trim()) - 1;
    return `@@BOLD_${index}@@`;
  });
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>");
  text = text.replace(/\*\*([^*]+?)\*\*/g, (_match, content: string) => {
    const index = boldPlaceholders.push(content) - 1;
    return `@@BOLD_${index}@@`;
  });
  text = text.replace(/__([^_]+?)__/g, (_match, content: string) => {
    const index = boldPlaceholders.push(content) - 1;
    return `@@BOLD_${index}@@`;
  });
  text = text.replace(/~~([^~]+?)~~/g, "~$1~");
  text = text.replace(/@@BOLD_(\d+)@@/g, (_match, index: string) => `*${boldPlaceholders[Number(index)]}*`);
  text = normalizeInlineBullets(text);
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export function buildSlackMessagePayload(markdown: string): SlackMessagePayload {
  const mrkdwn = formatSlackMessageText(markdown);
  const blocks = splitSlackMrkdwnSections(mrkdwn).map((section) => ({
    type: "section" as const,
    text: {
      type: "mrkdwn" as const,
      text: section,
    },
  }));

  return {
    text: formatSlackPlainText(mrkdwn),
    blocks,
  };
}
