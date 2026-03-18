import type { TaskPlanningInput } from "./contract.js";

export function buildTaskPlanningPrompt(input: TaskPlanningInput): string {
  return [
    "Plan how to register the following Slack request as Linear work.",
    "Reply with a single JSON object only.",
    'Use one of these schemas exactly:',
    '{"action":"clarify","clarificationQuestion":string,"clarificationReasons":["scope"|"due_date"|"execution_plan"]}',
    '{"action":"create","planningReason":"single-issue"|"complex-request"|"research-first","parentTitle":string|null,"parentDueDate":"YYYY-MM-DD"|null,"children":[{"title":string,"kind":"execution"|"research","dueDate":"YYYY-MM-DD"|null,"assigneeHint":string|null}]}',
    "Keep all strings in Japanese.",
    "Use clarify only when the request still lacks enough information to create reliable Linear work.",
    "clarificationQuestion must be exactly one concise follow-up question.",
    "For single-issue, set parentTitle to null and return exactly one child.",
    "For complex-request, return a concise parent title and execution-sized child tasks.",
    "For research-first, return a non-research parent title and at least one child with kind research.",
    "Normalize status-like phrases into actionable titles.",
    'Example normalization: "契約書のドラフト版の作成依頼済み" -> "ドラフト作成".',
    'Example normalization: "ドラフト版作成後、OPT 田平さんに確認依頼する必要あり" -> "OPT 田平さんへ契約書確認依頼".',
    "Preserve explicit assignee names in assigneeHint when they are given.",
    "Do not invent due dates or assignees. Use null or omit when unknown.",
    `Current date in Asia/Tokyo: ${input.currentDate}`,
    "",
    "Context:",
    `- originalRequest: ${input.originalRequest}`,
    `- latestUserMessage: ${input.latestUserMessage}`,
    `- combinedRequest: ${input.combinedRequest}`,
    `- previousClarificationQuestion: ${input.clarificationQuestion ?? "(none)"}`,
  ].join("\n");
}
