import { spawn } from "node:child_process";

export interface NotionCommandEnv {
  NOTION_API_TOKEN?: string;
  NOTION_API_VERSION?: string;
  [key: string]: string | undefined;
}

export interface SearchNotionInput {
  query: string;
  pageSize?: number;
}

export interface NotionPageSummary {
  id: string;
  object: string;
  url?: string | null;
  title?: string;
  lastEditedTime?: string | null;
  parent?: unknown;
  icon?: unknown;
}

export interface NotionPageFacts extends NotionPageSummary {
  createdTime?: string | null;
  createdBy?: unknown;
  lastEditedBy?: unknown;
  inTrash?: boolean;
  archived?: boolean;
  isLocked?: boolean;
  properties?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface NotionPageContentLine {
  type: string;
  text: string;
  depth: number;
}

export interface NotionPageContent extends NotionPageSummary {
  lines: NotionPageContentLine[];
  excerpt: string;
}

function ensureNotionAuthConfigured(env: NotionCommandEnv = process.env): void {
  if (!env.NOTION_API_TOKEN?.trim()) {
    throw new Error("NOTION_API_TOKEN is required for Notion API access");
  }
}

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function buildNotionShellCommand(args: string[]): string {
  return ["ntn", ...args].map((part) => shellEscape(part)).join(" ");
}

async function execNotionJson<T>(
  args: string[],
  env: NotionCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<T> {
  ensureNotionAuthConfigured(env);
  const command = buildNotionShellCommand(args);
  const child = spawn("sh", ["-lc", command], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    signal,
  });

  const raw = await new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").trim();
      if (code !== 0) {
        reject(new Error(combined || `ntn ${args.join(" ")} failed with exit code ${code ?? "unknown"}`));
        return;
      }
      resolve(combined);
    });
  });

  if (!raw) {
    throw new Error("ntn returned empty output");
  }
  return JSON.parse(raw) as T;
}

function firstRichTextPlainText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const texts = value
    .map((item) => {
      if (item && typeof item === "object" && "plain_text" in item) {
        return String(item.plain_text);
      }
      return "";
    })
    .filter(Boolean);
  return texts.length > 0 ? texts.join("") : undefined;
}

function extractPageTitle(properties: unknown): string | undefined {
  if (!properties || typeof properties !== "object") return undefined;
  for (const property of Object.values(properties as Record<string, unknown>)) {
    if (!property || typeof property !== "object") continue;
    const record = property as Record<string, unknown>;
    if (record.type === "title") {
      const title = firstRichTextPlainText(record.title);
      if (title) return title;
    }
  }
  return undefined;
}

function normalizePageSummary(raw: Record<string, unknown>): NotionPageSummary {
  return {
    id: String(raw.id ?? ""),
    object: String(raw.object ?? "unknown"),
    url: typeof raw.url === "string" ? raw.url : null,
    title: extractPageTitle(raw.properties),
    lastEditedTime: typeof raw.last_edited_time === "string" ? raw.last_edited_time : null,
    parent: raw.parent,
    icon: raw.icon,
  };
}

function getBlockData(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const type = typeof raw.type === "string" ? raw.type : undefined;
  if (!type) return undefined;
  const value = raw[type];
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function formatBlockPlainText(raw: Record<string, unknown>): string | undefined {
  const type = typeof raw.type === "string" ? raw.type : undefined;
  if (!type) return undefined;
  const block = getBlockData(raw);
  if (!block) return undefined;

  if (type === "child_page" && typeof block.title === "string" && block.title.trim()) {
    return block.title.trim();
  }

  if (type === "to_do") {
    const text = firstRichTextPlainText(block.rich_text);
    if (!text) return undefined;
    return `${block.checked ? "[x]" : "[ ]"} ${text}`;
  }

  if (type === "bookmark") {
    const caption = firstRichTextPlainText(block.caption);
    const url = typeof block.url === "string" ? block.url : undefined;
    return caption || url;
  }

  if (type === "link_preview") {
    return typeof block.url === "string" ? block.url : undefined;
  }

  const richText = firstRichTextPlainText(block.rich_text);
  if (richText) return richText;

  if (Array.isArray(block.title)) {
    return firstRichTextPlainText(block.title);
  }

  return undefined;
}

function buildExcerpt(lines: NotionPageContentLine[], maxLines = 4, maxLength = 280): string {
  const joined = lines
    .map((line) => line.text.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .join(" / ");
  if (joined.length <= maxLength) return joined;
  return `${joined.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function buildSearchNotionArgs(input: SearchNotionInput): string[] {
  const query = input.query.trim();
  if (!query) throw new Error("Search query is required");

  const payload = {
    query,
    page_size: input.pageSize ?? 10,
    filter: {
      property: "object",
      value: "page",
    },
  };

  return ["api", "/v1/search", "--data", JSON.stringify(payload)];
}

export function buildGetNotionPageArgs(pageId: string): string[] {
  const trimmed = pageId.trim();
  if (!trimmed) throw new Error("Notion page ID is required");
  return ["api", `/v1/pages/${trimmed}`];
}

export function buildListNotionBlockChildrenArgs(pageId: string, startCursor?: string): string[] {
  const trimmed = pageId.trim();
  if (!trimmed) throw new Error("Notion page ID is required");
  const search = new URLSearchParams({ page_size: "100" });
  if (startCursor?.trim()) {
    search.set("start_cursor", startCursor.trim());
  }
  return ["api", `/v1/blocks/${trimmed}/children?${search.toString()}`];
}

export async function searchNotionPages(
  input: SearchNotionInput,
  env: NotionCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<NotionPageSummary[]> {
  const payload = await execNotionJson<{ results?: Array<Record<string, unknown>> }>(
    buildSearchNotionArgs(input),
    env,
    signal,
  );
  return (payload.results ?? [])
    .filter((item) => item.object === "page")
    .map((item) => normalizePageSummary(item));
}

export async function getNotionPageFacts(
  pageId: string,
  env: NotionCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<NotionPageFacts> {
  const payload = await execNotionJson<Record<string, unknown>>(
    buildGetNotionPageArgs(pageId),
    env,
    signal,
  );
  const summary = normalizePageSummary(payload);
  return {
    ...summary,
    createdTime: typeof payload.created_time === "string" ? payload.created_time : null,
    createdBy: payload.created_by,
    lastEditedBy: payload.last_edited_by,
    inTrash: Boolean(payload.in_trash),
    archived: Boolean(payload.is_archived),
    isLocked: Boolean(payload.is_locked),
    properties: (payload.properties as Record<string, unknown> | undefined) ?? undefined,
    raw: payload,
  };
}

async function listNotionBlockChildren(
  blockId: string,
  env: NotionCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
  const results: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;

  while (true) {
    const payload = await execNotionJson<{
      results?: Array<Record<string, unknown>>;
      has_more?: boolean;
      next_cursor?: string | null;
    }>(
      buildListNotionBlockChildrenArgs(blockId, cursor),
      env,
      signal,
    );
    results.push(...(payload.results ?? []));
    if (!payload.has_more || !payload.next_cursor) {
      break;
    }
    cursor = payload.next_cursor;
  }

  return results;
}

async function collectNotionPageContentLines(
  blockId: string,
  env: NotionCommandEnv,
  signal: AbortSignal | undefined,
  depth = 0,
  options?: { maxDepth?: number; maxLines?: number },
): Promise<NotionPageContentLine[]> {
  const maxDepth = options?.maxDepth ?? 2;
  const maxLines = options?.maxLines ?? 80;
  if (depth > maxDepth || maxLines <= 0) return [];

  const blocks = await listNotionBlockChildren(blockId, env, signal);
  const lines: NotionPageContentLine[] = [];

  for (const block of blocks) {
    const type = typeof block.type === "string" ? block.type : "unknown";
    const text = formatBlockPlainText(block);
    if (text) {
      lines.push({ type, text, depth });
      if (lines.length >= maxLines) break;
    }
    if (block.has_children && depth < maxDepth && lines.length < maxLines) {
      const childLines = await collectNotionPageContentLines(
        String(block.id ?? ""),
        env,
        signal,
        depth + 1,
        { maxDepth, maxLines: maxLines - lines.length },
      );
      lines.push(...childLines);
      if (lines.length >= maxLines) break;
    }
  }

  return lines;
}

export async function getNotionPageContent(
  pageId: string,
  env: NotionCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<NotionPageContent> {
  const facts = await getNotionPageFacts(pageId, env, signal);
  const lines = await collectNotionPageContentLines(pageId, env, signal);
  return {
    id: facts.id,
    object: facts.object,
    url: facts.url,
    title: facts.title,
    lastEditedTime: facts.lastEditedTime,
    parent: facts.parent,
    icon: facts.icon,
    lines,
    excerpt: buildExcerpt(lines),
  };
}
