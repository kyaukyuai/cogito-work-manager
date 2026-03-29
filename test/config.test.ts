import { describe, expect, it } from "vitest";
import { ConfigValidationError, DEFAULT_BOT_MODEL, loadConfig } from "../src/lib/config.js";

const baseEnv = {
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_ALLOWED_CHANNEL_IDS: "C0ALAMDRB9V",
  LINEAR_API_KEY: "lin_api_test",
  LINEAR_WORKSPACE: "kyaukyuai",
  LINEAR_TEAM_KEY: "AIC",
};

describe("loadConfig", () => {
  it("defaults webhook config to disabled", () => {
    const config = loadConfig(baseEnv);

    expect(config.linearWebhookEnabled).toBe(false);
    expect(config.linearWebhookPort).toBe(8787);
    expect(config.linearWebhookPath).toBe("/hooks/linear");
    expect(config.botModel).toBe(DEFAULT_BOT_MODEL);
    expect(config.botThinkingLevel).toBe("minimal");
    expect(config.botMaxOutputTokens).toBeUndefined();
    expect(config.botRetryMaxRetries).toBe(1);
  });

  it("requires public URL and secret when webhook automation is enabled", () => {
    expect(() => loadConfig({
      ...baseEnv,
      LINEAR_WEBHOOK_ENABLED: "true",
    })).toThrow();

    const config = loadConfig({
      ...baseEnv,
      LINEAR_WEBHOOK_ENABLED: "true",
      LINEAR_WEBHOOK_PUBLIC_URL: "https://example.com",
      LINEAR_WEBHOOK_SECRET: "secret-1",
    });

    expect(config.linearWebhookEnabled).toBe(true);
    expect(config.linearWebhookPublicUrl).toBe("https://example.com");
    expect(config.linearWebhookSecret).toBe("secret-1");
  });

  it("accepts env-style boolean strings for webhook automation", () => {
    const enabledConfig = loadConfig({
      ...baseEnv,
      LINEAR_WEBHOOK_ENABLED: "yes",
      LINEAR_WEBHOOK_PUBLIC_URL: "https://example.com",
      LINEAR_WEBHOOK_SECRET: "secret-1",
    });
    const disabledConfig = loadConfig({
      ...baseEnv,
      LINEAR_WEBHOOK_ENABLED: "off",
    });

    expect(enabledConfig.linearWebhookEnabled).toBe(true);
    expect(disabledConfig.linearWebhookEnabled).toBe(false);
  });

  it("parses llm runtime overrides", () => {
    const config = loadConfig({
      ...baseEnv,
      BOT_THINKING_LEVEL: "high",
      BOT_MAX_OUTPUT_TOKENS: "4096",
      BOT_RETRY_MAX_RETRIES: "0",
    });

    expect(config.botThinkingLevel).toBe("high");
    expect(config.botMaxOutputTokens).toBe(4096);
    expect(config.botRetryMaxRetries).toBe(0);
  });

  it("rejects invalid llm runtime overrides", () => {
    expect(() => loadConfig({
      ...baseEnv,
      BOT_THINKING_LEVEL: "invalid",
    })).toThrow();

    expect(() => loadConfig({
      ...baseEnv,
      BOT_MAX_OUTPUT_TOKENS: "0",
    })).toThrow();

    expect(() => loadConfig({
      ...baseEnv,
      BOT_RETRY_MAX_RETRIES: "-1",
    })).toThrow();
  });

  it("throws a prettified config validation error", () => {
    try {
      loadConfig({
        ...baseEnv,
        LINEAR_WEBHOOK_ENABLED: "maybe",
      });
      throw new Error("expected config validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as Error).message).toContain("Invalid environment configuration.");
      expect((error as Error).message).toContain("LINEAR_WEBHOOK_ENABLED");
      expect((error as Error).stack).toBeUndefined();
    }
  });
});
