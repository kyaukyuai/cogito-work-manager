import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LINEAR_COMMAND_TIMEOUT_MS = 30_000;
export const LINEAR_CLI_WRITE_TIMEOUT_MS = 25_000;

export interface LinearCommandEnv {
  LINEAR_API_KEY?: string;
  LINEAR_WORKSPACE?: string;
  LINEAR_TEAM_KEY?: string;
  [key: string]: string | undefined;
}

interface CliJsonErrorEnvelope {
  success: false;
  error?: {
    type?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
}

export class LinearCommandError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly combined: string;
  readonly errorType?: string;
  readonly errorDetails?: Record<string, unknown>;

  constructor(
    message: string,
    stdout: string,
    stderr: string,
    combined: string,
    options?: {
      errorType?: string;
      errorDetails?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = "LinearCommandError";
    this.stdout = stdout;
    this.stderr = stderr;
    this.combined = combined;
    this.errorType = options?.errorType;
    this.errorDetails = options?.errorDetails;
  }
}

export class LinearCommandTimeoutError extends LinearCommandError {
  readonly timeoutMs: number;
  readonly appliedState?: string;
  readonly callerGuidance?: Record<string, unknown>;

  constructor(
    message: string,
    stdout: string,
    stderr: string,
    combined: string,
    timeoutMs: number,
    options?: {
      errorType?: string;
      errorDetails?: Record<string, unknown>;
      appliedState?: string;
      callerGuidance?: Record<string, unknown>;
    },
  ) {
    super(message, stdout, stderr, combined, options);
    this.name = "LinearCommandTimeoutError";
    this.timeoutMs = timeoutMs;
    this.appliedState = options?.appliedState;
    this.callerGuidance = options?.callerGuidance;
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isHighValueIssueWriteCommand(args: string[]): boolean {
  if (args[0] !== "issue") {
    return false;
  }

  if (args[1] === "create" || args[1] === "update" || args[1] === "create-batch") {
    return true;
  }

  if (args[1] === "comment" && args[2] === "add") {
    return true;
  }

  return args[1] === "relation" && (args[2] === "add" || args[2] === "delete");
}

function buildLinearChildEnv(env: LinearCommandEnv, args: string[]): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  if (!childEnv.LINEAR_WRITE_TIMEOUT_MS?.trim() && isHighValueIssueWriteCommand(args)) {
    childEnv.LINEAR_WRITE_TIMEOUT_MS = String(LINEAR_CLI_WRITE_TIMEOUT_MS);
  }
  return childEnv;
}

function parseCliJsonErrorEnvelope(raw: string): CliJsonErrorEnvelope | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.success !== false) {
      return undefined;
    }
    return parsed as unknown as CliJsonErrorEnvelope;
  } catch {
    return undefined;
  }
}

function resolveCliTimeoutMs(details: Record<string, unknown> | undefined): number | undefined {
  return typeof details?.timeoutMs === "number" && Number.isFinite(details.timeoutMs)
    ? details.timeoutMs
    : undefined;
}

function resolveCliAppliedState(details: Record<string, unknown> | undefined): string | undefined {
  return toStringOrUndefined(details?.appliedState) ?? toStringOrUndefined(details?.outcome);
}

function resolveCliCallerGuidance(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return isRecord(details?.callerGuidance) ? details.callerGuidance : undefined;
}

function buildLinearCommandErrorFromCliEnvelope(args: string[], stdout: string, stderr: string, combined: string): Error {
  const raw = stdout || stderr || combined;
  const envelope = raw ? parseCliJsonErrorEnvelope(raw) : undefined;
  const error = isRecord(envelope?.error) ? envelope.error : undefined;
  const details = isRecord(error?.details) ? error.details : undefined;
  const errorType = toStringOrUndefined(error?.type);
  const message = toStringOrUndefined(error?.message) ?? (combined || `linear ${args.join(" ")} failed`);

  if (
    errorType === "timeout_error"
    || toStringOrUndefined(details?.failureMode) === "timeout_waiting_for_confirmation"
  ) {
    return new LinearCommandTimeoutError(
      message,
      stdout,
      stderr,
      combined,
      resolveCliTimeoutMs(details) ?? LINEAR_CLI_WRITE_TIMEOUT_MS,
      {
        errorType,
        errorDetails: details,
        appliedState: resolveCliAppliedState(details),
        callerGuidance: resolveCliCallerGuidance(details),
      },
    );
  }

  return new LinearCommandError(message, stdout, stderr, combined, {
    errorType,
    errorDetails: details,
  });
}

function createLinearCommandAbortSignal(signal?: AbortSignal): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, LINEAR_COMMAND_TIMEOUT_MS);

  const handleAbort = () => {
    controller.abort(signal?.reason);
  };

  if (signal) {
    if (signal.aborted) {
      handleAbort();
    } else {
      signal.addEventListener("abort", handleAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cleanup: () => {
      clearTimeout(timeout);
      if (signal) {
        signal.removeEventListener("abort", handleAbort);
      }
    },
  };
}

export async function execLinear(
  args: string[],
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; combined: string }> {
  const abortContext = createLinearCommandAbortSignal(signal);
  const childEnv = buildLinearChildEnv(env, args);
  try {
    const result = await execFileAsync("linear", args, { env: childEnv, signal: abortContext.signal });
    const stdout = stripAnsi(result.stdout ?? "").trim();
    const stderr = stripAnsi(result.stderr ?? "").trim();
    const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
    return { stdout, stderr, combined };
  } catch (error) {
    const stdout = stripAnsi(String((error as { stdout?: string }).stdout ?? "")).trim();
    const stderr = stripAnsi(String((error as { stderr?: string }).stderr ?? "")).trim();
    const message = error instanceof Error ? error.message : String(error);
    const combined = [stdout, stderr, message].filter(Boolean).join("\n").trim();
    if (abortContext.timedOut() && !signal?.aborted) {
      throw new LinearCommandTimeoutError(
        `linear ${args.join(" ")} timed out after ${LINEAR_COMMAND_TIMEOUT_MS}ms`,
        stdout,
        stderr,
        combined,
        LINEAR_COMMAND_TIMEOUT_MS,
      );
    }
    throw buildLinearCommandErrorFromCliEnvelope(args, stdout, stderr, combined);
  } finally {
    abortContext.cleanup();
  }
}

export async function execLinearJson<T>(
  args: string[],
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<T> {
  const result = await execLinear(args, env, signal);
  const raw = result.stdout || result.stderr;
  if (!raw) {
    throw new Error("linear command returned empty JSON output");
  }
  return JSON.parse(raw) as T;
}
