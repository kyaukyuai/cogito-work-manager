import { describe, expect, it } from "vitest";
import {
  buildSlackVisibleLlmFailureNotice,
  findAssistantLlmFailure,
  LlmTurnTimeoutError,
  normalizeLlmFailure,
} from "../src/lib/llm-failure.js";

describe("llm failure normalization", () => {
  it("extracts Anthropic provider failures from assistant error messages", () => {
    const failure = findAssistantLlmFailure([
      {
        role: "assistant",
        provider: "anthropic",
        stopReason: "error",
        errorMessage: "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"This request would exceed your account's rate limit. Please try again later.\"},\"request_id\":\"req_011CZRuiaqp7Vtjhgja6Da4n\"}",
      },
    ]);

    expect(failure).toEqual({
      kind: "provider",
      provider: "anthropic",
      statusCode: 429,
      providerErrorType: "rate_limit_error",
      publicSummary: "Anthropic 429 rate_limit_error",
      technicalMessage: "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"This request would exceed your account's rate limit. Please try again later.\"},\"request_id\":\"req_011CZRuiaqp7Vtjhgja6Da4n\"}",
      requestId: "req_011CZRuiaqp7Vtjhgja6Da4n",
    });
  });

  it("builds a Slack-visible summary without exposing the request id", () => {
    const error = new Error("429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"This request would exceed your account's rate limit. Please try again later.\"},\"request_id\":\"req_011CZRuiaqp7Vtjhgja6Da4n\"}");

    expect(normalizeLlmFailure(error)).toMatchObject({
      provider: "anthropic",
      statusCode: 429,
      providerErrorType: "rate_limit_error",
      requestId: "req_011CZRuiaqp7Vtjhgja6Da4n",
    });
    expect(buildSlackVisibleLlmFailureNotice(error)).toBe("LLM 側のエラーです。Anthropic 429 rate_limit_error が発生しました。");
  });

  it("returns undefined for non-provider failures", () => {
    expect(buildSlackVisibleLlmFailureNotice(new Error("timeout while reading tool output"))).toBeUndefined();
  });

  it("builds a Slack-visible summary for LLM turn timeouts", () => {
    const error = new LlmTurnTimeoutError(90_000);

    expect(normalizeLlmFailure(error)).toMatchObject({
      kind: "timeout",
      timeoutMs: 90_000,
      publicSummary: "LLM turn timeout",
    });
    expect(buildSlackVisibleLlmFailureNotice(error)).toBe("LLM 応答待ちがタイムアウトしました。少し置いてから再試行してください。");
  });
});
