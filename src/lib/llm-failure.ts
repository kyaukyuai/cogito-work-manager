type LlmFailureProvider = "anthropic";

export interface LlmProviderFailureInfo {
  kind: "provider";
  provider: LlmFailureProvider;
  statusCode?: number;
  providerErrorType?: string;
  publicSummary: string;
  technicalMessage: string;
  requestId?: string;
}

export interface LlmTurnTimeoutFailureInfo {
  kind: "timeout";
  publicSummary: string;
  technicalMessage: string;
  timeoutMs: number;
}

export type LlmFailureInfo = LlmProviderFailureInfo | LlmTurnTimeoutFailureInfo;

interface AssistantErrorCandidate {
  role?: unknown;
  provider?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatProviderLabel(provider: LlmFailureProvider): string {
  return provider === "anthropic" ? "Anthropic" : provider;
}

function inferAnthropicProvider(providerHint: string | undefined, body: Record<string, unknown> | undefined): boolean {
  if (providerHint?.trim().toLowerCase() === "anthropic") {
    return true;
  }
  return typeof body?.request_id === "string" && isRecord(body.error);
}

function buildPublicSummary(args: {
  provider: LlmFailureProvider;
  statusCode?: number;
  providerErrorType?: string;
}): string {
  return [
    formatProviderLabel(args.provider),
    typeof args.statusCode === "number" ? String(args.statusCode) : undefined,
    args.providerErrorType,
  ].filter(Boolean).join(" ");
}

function parseStatusCodePrefix(value: string): {
  statusCode?: number;
  bodyText: string;
} {
  const match = value.trim().match(/^(\d{3})\s+([\s\S]+)$/);
  if (!match) {
    return {
      bodyText: value.trim(),
    };
  }
  return {
    statusCode: Number(match[1]),
    bodyText: match[2] ?? "",
  };
}

function normalizeAnthropicProviderFailure(
  technicalMessage: string,
  providerHint?: string,
): LlmFailureInfo | undefined {
  const { statusCode, bodyText } = parseStatusCodePrefix(technicalMessage);

  let parsedBody: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(bodyText);
    parsedBody = isRecord(parsed) ? parsed : undefined;
  } catch {
    parsedBody = undefined;
  }

  if (!inferAnthropicProvider(providerHint, parsedBody)) {
    return undefined;
  }

  const errorRecord = parsedBody && isRecord(parsedBody.error)
    ? parsedBody.error
    : undefined;
  const providerErrorType = typeof errorRecord?.type === "string"
    ? errorRecord.type
    : (/\brate_limit_error\b/i.test(technicalMessage) ? "rate_limit_error" : undefined);
  const requestId = typeof parsedBody?.request_id === "string" ? parsedBody.request_id : undefined;

  if (typeof statusCode !== "number" && !providerErrorType) {
    return undefined;
  }

  return {
    kind: "provider",
    provider: "anthropic",
    statusCode,
    providerErrorType,
    publicSummary: buildPublicSummary({
      provider: "anthropic",
      statusCode,
      providerErrorType,
    }),
    technicalMessage,
    requestId,
  };
}

function normalizeProviderFailure(
  technicalMessage: string,
  providerHint?: string,
): LlmFailureInfo | undefined {
  return normalizeAnthropicProviderFailure(technicalMessage, providerHint);
}

export class LlmProviderFailureError extends Error {
  readonly failure: LlmFailureInfo;

  constructor(failure: LlmFailureInfo) {
    super(failure.technicalMessage);
    this.name = "LlmProviderFailureError";
    this.failure = failure;
  }
}

export class LlmTurnTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, message = `Timed out waiting for LLM turn after ${timeoutMs}ms`) {
    super(message);
    this.name = "LlmTurnTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function findAssistantLlmFailure(messages: unknown[]): LlmFailureInfo | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index] as AssistantErrorCandidate;
    if (candidate.role !== "assistant") {
      continue;
    }
    if (candidate.stopReason !== "error") {
      continue;
    }
    if (typeof candidate.errorMessage !== "string" || !candidate.errorMessage.trim()) {
      continue;
    }

    const normalized = normalizeProviderFailure(
      candidate.errorMessage,
      typeof candidate.provider === "string" ? candidate.provider : undefined,
    );
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

export function normalizeLlmFailure(error: unknown): LlmFailureInfo | undefined {
  if (error instanceof LlmProviderFailureError) {
    return error.failure;
  }
  if (error instanceof LlmTurnTimeoutError) {
    return {
      kind: "timeout",
      publicSummary: "LLM turn timeout",
      technicalMessage: error.message,
      timeoutMs: error.timeoutMs,
    };
  }

  const technicalMessage = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : undefined;
  if (!technicalMessage) {
    return undefined;
  }

  return normalizeProviderFailure(technicalMessage);
}

export function buildSlackVisibleLlmFailureNotice(error: unknown): string | undefined {
  const normalized = normalizeLlmFailure(error);
  if (!normalized) {
    return undefined;
  }
  if (normalized.kind === "timeout") {
    return "LLM 応答待ちがタイムアウトしました。少し置いてから再試行してください。";
  }
  return `LLM 側のエラーです。${normalized.publicSummary} が発生しました。`;
}
