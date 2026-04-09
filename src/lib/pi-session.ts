import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentSession,
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import {
  runManagerReplyTurnWithExecutor,
  type ManagerReplyInput,
  type ManagerReplyResult,
} from "../planners/manager-reply/index.js";
import {
  runMessageRouterTurnWithExecutor,
  type MessageRouterInput,
  type MessageRouterResult,
} from "../planners/message-router/index.js";
import {
  runFollowupResolutionTurnWithExecutor,
  type FollowupResolutionInput,
  type FollowupResolutionResult,
} from "../planners/followup-resolution/index.js";
import {
  runResearchSynthesisTurnWithExecutor,
  type ResearchNextAction,
  type ResearchSynthesisInput,
  type ResearchSynthesisResult,
} from "../planners/research-synthesis/index.js";
import {
  runTaskPlanningTurnWithExecutor,
  type TaskPlanningInput,
  type TaskPlanningResult,
} from "../planners/task-intake/index.js";
import {
  runDuplicateRecallTurnWithExecutor,
  type DuplicateRecallInput,
  type DuplicateRecallResult,
} from "../planners/duplicate-recall/index.js";
import {
  runOtherDirectedMessageTurnWithExecutor,
  type OtherDirectedMessageInput,
  type OtherDirectedMessageResult,
} from "../planners/other-directed-message/index.js";
import {
  runPartialFollowupUnmatchedTurnWithExecutor,
  type PartialFollowupUnmatchedInput,
  type PartialFollowupUnmatchedResult,
} from "../planners/partial-followup-unmatched/index.js";
import {
  runPersonalizationExtractionTurnWithExecutor,
  type PersonalizationExtractionInput,
  type PersonalizationExtractionResult,
} from "../planners/personalization-extraction/index.js";
import { selectFinalAssistantText } from "../runtime/assistant-text.js";
import {
  buildManagerAgentPrompt,
  buildManagerAgentPromptInput,
  buildManagerSystemPromptContext,
  buildManagerSystemPromptInput,
  buildSystemPrompt,
  type ManagerAgentInput,
  type ManagerSystemInput,
} from "../runtime/manager-prompts.js";
import {
  findAssistantLlmFailure,
  LlmProviderFailureError,
  LlmTurnTimeoutError,
} from "./llm-failure.js";
import { createManagerAgentTools } from "./manager-agent-tools.js";
import { createFileBackedManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import type { ManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import type { AppConfig } from "./config.js";
import { createLinearCustomTools } from "./linear-tools.js";
import {
  extractDuplicateResolutionSummaries,
  extractIntentReport,
  extractManagerCommandProposals,
  extractPartialFollowupResolutionReport,
  extractPendingClarificationDecision,
  extractSystemThreadContextReport,
  extractTaskExecutionDecision,
  type ManagerAgentToolCall,
  type ManagerCommandProposal,
  type ManagerIntentReport,
  type PendingClarificationDecisionReport,
  type TaskExecutionDecisionReport,
} from "./manager-command-commit.js";
import type { SystemThreadContextReport } from "./system-thread-context.js";
import type { PartialFollowupResolutionReport } from "./partial-followup-resolution.js";
import type { LinearDuplicateResolutionSummary } from "./linear-duplicate-resolution.js";
import { buildSystemPaths, loadWorkspaceCustomization, type WorkspaceCustomizationContext } from "./system-workspace.js";
import type { ThreadPaths } from "./thread-workspace.js";
import {
  createLlmSettingsManager,
  resolveLlmRuntimeDependencies,
  type LlmRuntimeConfig,
  wrapStreamFnWithMaxOutputTokens,
} from "../runtime/llm-runtime-config.js";
export type { ManagerAgentInput, ManagerSystemInput } from "../runtime/manager-prompts.js";

export interface ManagerAgentTurnResult {
  reply: string;
  toolCalls: ManagerAgentToolCall[];
  proposals: ManagerCommandProposal[];
  invalidProposalCount: number;
  intentReport?: ManagerIntentReport;
  pendingClarificationDecision?: PendingClarificationDecisionReport;
  taskExecutionDecision?: TaskExecutionDecisionReport;
  duplicateResolutions?: LinearDuplicateResolutionSummary[];
  systemThreadContextReport?: SystemThreadContextReport;
  partialFollowupResolutionReport?: PartialFollowupResolutionReport;
}

export interface ManagerReplyStreamingPolicy {
  mode: "default" | "disabled";
  reason?: string;
}

export interface ManagerAgentTurnObserver {
  onIntentReport?: (report: ManagerIntentReport) => void;
  onTextDelta?: (delta: string) => void;
  onReplyStreamingPolicy?: (policy: ManagerReplyStreamingPolicy) => void;
}

export {
  buildManagerReplyPrompt,
  parseManagerReplyReply,
  type ManagerReplyInput,
  type ManagerReplyResult,
} from "../planners/manager-reply/index.js";

export {
  buildMessageRouterPrompt,
  parseMessageRouterReply,
  type MessageRouterInput,
  type MessageRouterResult,
} from "../planners/message-router/index.js";

export {
  buildFollowupResolutionPrompt,
  parseFollowupResolutionReply,
  type FollowupResolutionInput,
  type FollowupResolutionResult,
} from "../planners/followup-resolution/index.js";

export {
  buildResearchSynthesisPrompt,
  parseResearchSynthesisReply,
  type ResearchNextAction,
  type ResearchSynthesisInput,
  type ResearchSynthesisResult,
} from "../planners/research-synthesis/index.js";

export {
  buildTaskPlanningPrompt,
  parseTaskPlanningReply,
  type TaskPlanningChild,
  type TaskPlanningInput,
  type TaskPlanningResult,
  type TaskPlanningResultClarify,
  type TaskPlanningResultCreate,
} from "../planners/task-intake/index.js";

export {
  buildPartialFollowupUnmatchedPrompt,
  parsePartialFollowupUnmatchedReply,
  type PartialFollowupUnmatchedInput,
  type PartialFollowupUnmatchedIssueRef,
  type PartialFollowupUnmatchedResult,
} from "../planners/partial-followup-unmatched/index.js";

export {
  buildPersonalizationExtractionPrompt,
  parsePersonalizationExtractionReply,
  type PersonalizationExtractionInput,
  type PersonalizationExtractionResult,
  type PersonalizationObservation,
} from "../planners/personalization-extraction/index.js";

export {
  buildOtherDirectedMessagePrompt,
  parseOtherDirectedMessageReply,
  type OtherDirectedMessageInput,
  type OtherDirectedMessageOwnerEntry,
  type OtherDirectedMessageRecentThreadEntry,
  type OtherDirectedMessageResult,
} from "../planners/other-directed-message/index.js";

interface SharedRuntime {
  agentDir: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  model: Awaited<ReturnType<ModelRegistry["getAvailable"]>>[number];
  llmRuntimeConfig: LlmRuntimeConfig;
  managerRepositories: ManagerRepositories;
}

interface ThreadRuntime {
  session: AgentSession;
  lastUsedAt: number;
}

const DEFAULT_THREAD_IDLE_MS = 15 * 60 * 1000;
export const DEFAULT_LLM_TURN_TIMEOUT_MS = 90_000;
let sharedRuntimePromise: Promise<SharedRuntime> | undefined;
const threadRuntimePromises = new Map<string, Promise<ThreadRuntime>>();
function sanitizeSessionSuffix(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "default";
}

async function runIsolatedPromptTurn(
  config: AppConfig,
  paths: ThreadPaths,
  prompt: string,
  systemPrompt: string,
  sessionSuffix: string,
): Promise<string> {
  const shared = await getSharedRuntime(config);
  const settingsManager = createLlmSettingsManager(shared.llmRuntimeConfig);

  const loader = new DefaultResourceLoader({
    cwd: paths.rootDir,
    agentDir: shared.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => systemPrompt,
  });
  await loader.reload();

  const sessionFile = join(paths.scratchDir, `isolated-${sanitizeSessionSuffix(sessionSuffix)}.jsonl`);
  const sessionManager = SessionManager.open(sessionFile, paths.rootDir);
  const { session } = await createAgentSession({
    cwd: paths.rootDir,
    agentDir: shared.agentDir,
    model: shared.model,
    thinkingLevel: shared.llmRuntimeConfig.effectiveThinkingLevel,
    authStorage: shared.authStorage,
    modelRegistry: shared.modelRegistry,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    tools: [],
    customTools: [],
  });
  session.agent.streamFn = wrapStreamFnWithMaxOutputTokens(
    session.agent.streamFn,
    shared.llmRuntimeConfig.maxOutputTokens,
  );

  const deltas: string[] = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      deltas.push(event.assistantMessageEvent.delta);
    }
  });

  try {
    return await runWithLlmTurnTimeout(
      async () => {
        await session.prompt(prompt);
        await session.agent.waitForIdle();
        const messages = session.messages as unknown[];
        return resolveAssistantReplyOrThrow(messages, deltas);
      },
      {
        timeoutMs: config.botTurnTimeoutMs ?? DEFAULT_LLM_TURN_TIMEOUT_MS,
        label: `isolated planner turn (${sessionSuffix})`,
        onTimeout: () => {
          session.dispose();
        },
      },
    );
  } finally {
    unsubscribe();
    session.dispose();
  }
}

function buildThreadRuntimeKey(paths: ThreadPaths): string {
  return paths.sessionFile;
}

async function runWithLlmTurnTimeout<T>(
  operation: () => Promise<T>,
  args: {
    timeoutMs: number;
    label: string;
    onTimeout?: () => void;
  },
): Promise<T> {
  if (args.timeoutMs <= 0) {
    return operation();
  }

  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutError = new LlmTurnTimeoutError(
    args.timeoutMs,
    `Timed out waiting for ${args.label} after ${args.timeoutMs}ms`,
  );
  const operationPromise = operation().then((result) => {
    if (timedOut) {
      throw timeoutError;
    }
    return result;
  });
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        args.onTimeout?.();
      } catch {
        // Timeout handling must not mask the original timeout.
      }
      reject(timeoutError);
    }, args.timeoutMs);
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function getSharedRuntime(config: AppConfig): Promise<SharedRuntime> {
  if (!sharedRuntimePromise) {
    sharedRuntimePromise = (async () => {
      const resolved = await resolveLlmRuntimeDependencies(config);

      return {
        agentDir: resolved.agentDir,
        authStorage: resolved.authStorage,
        modelRegistry: resolved.modelRegistry,
        model: resolved.model,
        llmRuntimeConfig: resolved.runtimeConfig,
        managerRepositories: createFileBackedManagerRepositories(buildSystemPaths(config.workspaceDir)),
      };
    })().catch((error) => {
      sharedRuntimePromise = undefined;
      throw error;
    });
  }

  return sharedRuntimePromise;
}

async function createThreadRuntime(config: AppConfig, paths: ThreadPaths): Promise<ThreadRuntime> {
  const shared = await getSharedRuntime(config);
  const managerPolicy = await shared.managerRepositories.policy.load();
  const settingsManager = createLlmSettingsManager(shared.llmRuntimeConfig);

  const loader = new DefaultResourceLoader({
    cwd: paths.rootDir,
    agentDir: shared.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => buildSystemPrompt(config, managerPolicy.assistantName),
  });
  await loader.reload();

  const sessionManager = SessionManager.open(paths.sessionFile, paths.rootDir);
  const { session } = await createAgentSession({
    cwd: paths.rootDir,
    agentDir: shared.agentDir,
    model: shared.model,
    thinkingLevel: shared.llmRuntimeConfig.effectiveThinkingLevel,
    authStorage: shared.authStorage,
    modelRegistry: shared.modelRegistry,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    tools: [],
    customTools: createManagerAgentTools(config, shared.managerRepositories, {
      runDuplicateRecallTurn: async (input) => runDuplicateRecallTurn(config, paths, input),
    }),
  });
  session.agent.streamFn = wrapStreamFnWithMaxOutputTokens(
    session.agent.streamFn,
    shared.llmRuntimeConfig.maxOutputTokens,
  );

  return {
    session,
    lastUsedAt: Date.now(),
  };
}

async function getOrCreateThreadRuntime(config: AppConfig, paths: ThreadPaths): Promise<ThreadRuntime> {
  const key = buildThreadRuntimeKey(paths);
  const existing = threadRuntimePromises.get(key);

  if (existing) {
    const runtime = await existing;
    runtime.lastUsedAt = Date.now();
    return runtime;
  }

  const pending = createThreadRuntime(config, paths).catch((error) => {
    threadRuntimePromises.delete(key);
    throw error;
  });
  threadRuntimePromises.set(key, pending);

  const runtime = await pending;
  runtime.lastUsedAt = Date.now();
  return runtime;
}

async function disposeThreadRuntime(key: string): Promise<void> {
  const pending = threadRuntimePromises.get(key);
  if (!pending) return;

  threadRuntimePromises.delete(key);
  try {
    const runtime = await pending;
    runtime.session.dispose();
  } catch {
    // Ignore startup failures while cleaning up stale runtime entries.
  }
}

export async function disposeIdleThreadRuntimes(maxIdleMs = DEFAULT_THREAD_IDLE_MS): Promise<void> {
  const now = Date.now();
  const staleKeys: string[] = [];

  for (const [key, pending] of threadRuntimePromises.entries()) {
    try {
      const runtime = await pending;
      if (now - runtime.lastUsedAt >= maxIdleMs) {
        staleKeys.push(key);
      }
    } catch {
      staleKeys.push(key);
    }
  }

  await Promise.all(staleKeys.map((key) => disposeThreadRuntime(key)));
}

export async function disposeAllThreadRuntimes(): Promise<void> {
  await Promise.all(Array.from(threadRuntimePromises.keys()).map((key) => disposeThreadRuntime(key)));
}

async function loadPromptCustomization(config: AppConfig): Promise<WorkspaceCustomizationContext> {
  return loadWorkspaceCustomization(buildSystemPaths(config.workspaceDir));
}

type PlannerWorkspaceInput = {
  workspaceAgents?: string;
  workspaceMemory?: string;
};

type PlannerReplyExecutor = (
  prompt: string,
  systemPrompt: string,
  sessionSuffix: string,
) => Promise<string>;

type WorkspaceCustomizedPlannerRunner<TInput extends PlannerWorkspaceInput, TResult> = (
  executeReply: PlannerReplyExecutor,
  input: TInput,
) => Promise<TResult>;

function resolveAssistantReplyOrThrow(
  messages: unknown[],
  deltas: string[],
  emptyReplyMessage = "Agent finished without producing a reply",
): string {
  const reply = selectFinalAssistantText(messages, deltas);
  if (reply) {
    return reply;
  }

  const llmFailure = findAssistantLlmFailure(messages);
  if (llmFailure) {
    throw new LlmProviderFailureError(llmFailure);
  }

  throw new Error(emptyReplyMessage);
}

async function writeLastReply(paths: ThreadPaths, reply: string): Promise<void> {
  await writeFile(join(paths.scratchDir, "last-reply.txt"), `${reply}\n`, "utf8");
}

async function runWorkspaceCustomizedPlannerTurn<TInput extends PlannerWorkspaceInput, TResult>(
  config: AppConfig,
  paths: ThreadPaths,
  input: TInput,
  runner: WorkspaceCustomizedPlannerRunner<TInput, TResult>,
): Promise<TResult> {
  const { workspaceAgents, workspaceMemory } = await loadPromptCustomization(config);
  return runner(
    (prompt, systemPrompt, sessionSuffix) => runIsolatedPromptTurn(
      config,
      paths,
      prompt,
      systemPrompt,
      sessionSuffix,
    ),
    {
      ...input,
      workspaceAgents,
      workspaceMemory,
    } as TInput,
  );
}

async function executeThreadPromptTurn<TResult>(
  config: AppConfig,
  paths: ThreadPaths,
  prompt: string,
  options: {
    subscribe?: (event: unknown) => void;
    buildResult: (args: { reply: string; newMessages: unknown[]; deltas: string[] }) => Promise<TResult> | TResult;
    emptyReplyMessage?: string;
  },
): Promise<TResult> {
  const runtimeKey = buildThreadRuntimeKey(paths);
  const runtime = await getOrCreateThreadRuntime(config, paths);
  const messageCountBefore = runtime.session.messages.length;
  const deltas: string[] = [];
  const unsubscribe = runtime.session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      deltas.push(event.assistantMessageEvent.delta);
    }
    options.subscribe?.(event);
  });

  try {
    return await runWithLlmTurnTimeout(
      async () => {
        await runtime.session.prompt(prompt);
        await runtime.session.agent.waitForIdle();

        const newMessages = (runtime.session.messages as unknown[]).slice(messageCountBefore);
        const reply = resolveAssistantReplyOrThrow(newMessages, deltas, options.emptyReplyMessage);
        runtime.lastUsedAt = Date.now();
        await writeLastReply(paths, reply);
        return await options.buildResult({ reply, newMessages, deltas });
      },
      {
        timeoutMs: config.botTurnTimeoutMs ?? DEFAULT_LLM_TURN_TIMEOUT_MS,
        label: "manager thread turn",
        onTimeout: () => {
          threadRuntimePromises.delete(runtimeKey);
          runtime.session.dispose();
        },
      },
    );
  } catch (error) {
    await disposeThreadRuntime(runtimeKey);
    throw error;
  } finally {
    unsubscribe();
    runtime.lastUsedAt = Date.now();
  }
}

export async function runResearchSynthesisTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: ResearchSynthesisInput,
): Promise<ResearchSynthesisResult> {
  return runWorkspaceCustomizedPlannerTurn(
    config,
    paths,
    input,
    runResearchSynthesisTurnWithExecutor,
  );
}

export async function runMessageRouterTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: MessageRouterInput,
): Promise<MessageRouterResult> {
  return runWorkspaceCustomizedPlannerTurn(
    config,
    paths,
    input,
    runMessageRouterTurnWithExecutor,
  );
}

export async function runManagerReplyTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: ManagerReplyInput,
): Promise<ManagerReplyResult> {
  return runWorkspaceCustomizedPlannerTurn(
    config,
    paths,
    input,
    runManagerReplyTurnWithExecutor,
  );
}

export async function runTaskPlanningTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: TaskPlanningInput,
): Promise<TaskPlanningResult> {
  return runWorkspaceCustomizedPlannerTurn(
    config,
    paths,
    input,
    runTaskPlanningTurnWithExecutor,
  );
}

export async function runDuplicateRecallTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: DuplicateRecallInput,
): Promise<DuplicateRecallResult> {
  return runWorkspaceCustomizedPlannerTurn(
    config,
    paths,
    input,
    runDuplicateRecallTurnWithExecutor,
  );
}

export async function runOtherDirectedMessageTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: OtherDirectedMessageInput,
): Promise<OtherDirectedMessageResult> {
  return runWorkspaceCustomizedPlannerTurn(
    config,
    paths,
    input,
    runOtherDirectedMessageTurnWithExecutor,
  );
}

export async function runPartialFollowupUnmatchedTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: PartialFollowupUnmatchedInput,
): Promise<PartialFollowupUnmatchedResult> {
  return runWorkspaceCustomizedPlannerTurn(
    config,
    paths,
    input,
    runPartialFollowupUnmatchedTurnWithExecutor,
  );
}

export async function runFollowupResolutionTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: FollowupResolutionInput,
): Promise<FollowupResolutionResult> {
  return runWorkspaceCustomizedPlannerTurn(
    config,
    paths,
    input,
    runFollowupResolutionTurnWithExecutor,
  );
}

export async function runPersonalizationExtractionTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: PersonalizationExtractionInput,
): Promise<PersonalizationExtractionResult> {
  return runWorkspaceCustomizedPlannerTurn(
    config,
    paths,
    input,
    runPersonalizationExtractionTurnWithExecutor,
  );
}

async function runStructuredPromptTurn(
  config: AppConfig,
  paths: ThreadPaths,
  prompt: string,
  observer?: ManagerAgentTurnObserver,
): Promise<ManagerAgentTurnResult> {
  const toolCalls: ManagerAgentToolCall[] = [];
  let lastObservedIntentReportJson: string | undefined;
  return executeThreadPromptTurn(config, paths, prompt, {
    subscribe: (event) => {
      const sessionEvent = event as {
        type?: string;
        assistantMessageEvent?: { type?: string; delta?: string };
        result?: { details?: unknown };
        toolName?: string;
        isError?: boolean;
      };
      if (sessionEvent.type === "message_update" && sessionEvent.assistantMessageEvent?.type === "text_delta") {
        observer?.onTextDelta?.(sessionEvent.assistantMessageEvent.delta ?? "");
        return;
      }

      if (sessionEvent.type === "tool_execution_end") {
        toolCalls.push({
          toolName: sessionEvent.toolName ?? "unknown",
          details: sessionEvent.result?.details,
          isError: sessionEvent.isError ?? false,
        });
        const intentReport = extractIntentReport(toolCalls);
        if (!intentReport) {
          return;
        }
        const intentReportJson = JSON.stringify(intentReport);
        if (intentReportJson === lastObservedIntentReportJson) {
          return;
        }
        lastObservedIntentReportJson = intentReportJson;
        observer?.onIntentReport?.(intentReport);
      }
    },
    buildResult: ({ reply }) => {
      const { proposals, invalidProposalCount } = extractManagerCommandProposals(toolCalls);
      return {
        reply,
        toolCalls,
        proposals,
        invalidProposalCount,
        intentReport: extractIntentReport(toolCalls),
        pendingClarificationDecision: extractPendingClarificationDecision(toolCalls),
        taskExecutionDecision: extractTaskExecutionDecision(toolCalls),
        duplicateResolutions: extractDuplicateResolutionSummaries(toolCalls),
        systemThreadContextReport: extractSystemThreadContextReport(toolCalls),
        partialFollowupResolutionReport: extractPartialFollowupResolutionReport(toolCalls),
      };
    },
  });
}

export async function runManagerAgentTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: ManagerAgentInput,
  observer?: ManagerAgentTurnObserver,
): Promise<ManagerAgentTurnResult> {
  const customization = await loadPromptCustomization(config);
  return runStructuredPromptTurn(
    config,
    paths,
    buildManagerAgentPrompt(buildManagerAgentPromptInput(input, customization)),
    observer,
  );
}

export async function runManagerSystemTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: ManagerSystemInput,
): Promise<ManagerAgentTurnResult> {
  const customization = await loadPromptCustomization(config);
  return runStructuredPromptTurn(
    config,
    paths,
    buildManagerSystemPromptInput(buildManagerSystemPromptContext(input, customization)),
  );
}

async function runPromptTurn(config: AppConfig, paths: ThreadPaths, prompt: string): Promise<string> {
  return executeThreadPromptTurn(config, paths, prompt, {
    buildResult: ({ reply }) => reply,
  });
}
