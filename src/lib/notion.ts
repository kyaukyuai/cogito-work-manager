import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  try {
    const result = await execFileAsync("sh", ["-lc", buildNotionShellCommand(args)], { env, signal });
    const raw = String(result.stdout ?? result.stderr ?? "").trim();
    if (!raw) {
      throw new Error("ntn returned empty output");
    }
    return JSON.parse(raw) as T;
  } catch (error) {
    const stdout = String((error as { stdout?: string }).stdout ?? "").trim();
    const stderr = String((error as { stderr?: string }).stderr ?? "").trim();
    const message = error instanceof Error ? error.message : String(error);
    const combined = [stdout, stderr, message].filter(Boolean).join("\n").trim();
    throw new Error(combined || `ntn ${args.join(" ")} failed`);
  }
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
