import type { WebClient } from "@slack/web-api";
import { buildSlackMessagePayload } from "./slack-format.js";

const DEFAULT_PROCESSING_NOTICE = "考え中...";
export const SLACK_PROCESSING_NOTICE_DELAY_MS = 750;
export const SLACK_STREAM_APPEND_THROTTLE_MS = 250;

type SlackChatClient = Pick<WebClient, "chat">;

export interface SlackReplyStreamEvent {
  type: "stream_started" | "stream_stopped" | "stream_failed" | "stream_fallback";
  reason?: string;
  error?: string;
  ts?: string;
}

export interface SlackReplyStreamController {
  enableStreaming(): Promise<boolean>;
  disableStreaming(): void;
  pushTextDelta(delta: string): void;
  finalizeReply(reply: string): Promise<string>;
}

function messagePayloadText(reply: string, linearWorkspace: string): string {
  return buildSlackMessagePayload(reply, { linearWorkspace }).text;
}

function createDeferred<T>() {
  let resolved = false;
  let resolveRef: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolveRef = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };
  });
  return {
    promise,
    resolve: resolveRef,
    get resolved() {
      return resolved;
    },
  };
}

export function createSlackReplyStreamController(
  webClient: SlackChatClient,
  args: {
    channel: string;
    threadTs: string;
    recipientUserId: string;
    recipientTeamId?: string;
    linearWorkspace: string;
    processingNoticeDelayMs?: number;
    appendThrottleMs?: number;
    onEvent?: (event: SlackReplyStreamEvent) => void;
  },
): SlackReplyStreamController {
  const processingNoticeDelayMs = args.processingNoticeDelayMs ?? SLACK_PROCESSING_NOTICE_DELAY_MS;
  const appendThrottleMs = args.appendThrottleMs ?? SLACK_STREAM_APPEND_THROTTLE_MS;
  const placeholderDeferred = createDeferred<string | undefined>();
  let placeholderTimer: NodeJS.Timeout | undefined;
  let placeholderPostedTs: string | undefined;
  let placeholderPostingPromise: Promise<string | undefined> | undefined;
  let streamingEnabled = false;
  let streamingDisabled = false;
  let finalized = false;
  let streamTs: string | undefined;
  let streamFailed = false;
  let streamFailedReason: string | undefined;
  let bufferedRawText = "";
  let sentRenderedText = "";
  let flushTimer: NodeJS.Timeout | undefined;
  let flushPromise: Promise<void> | undefined;

  const emit = (event: SlackReplyStreamEvent) => {
    args.onEvent?.(event);
  };

  const clearPlaceholderTimer = () => {
    if (placeholderTimer) {
      clearTimeout(placeholderTimer);
      placeholderTimer = undefined;
    }
  };

  const resolvePlaceholder = (value: string | undefined) => {
    placeholderDeferred.resolve(value);
  };

  const ensurePlaceholderPosted = async (): Promise<string | undefined> => {
    if (placeholderPostedTs) {
      return placeholderPostedTs;
    }
    if (placeholderPostingPromise) {
      return placeholderPostingPromise;
    }
    clearPlaceholderTimer();
    placeholderPostingPromise = postSlackProcessingNotice(webClient, {
      channel: args.channel,
      threadTs: args.threadTs,
    }).then((ts) => {
      placeholderPostedTs = ts;
      resolvePlaceholder(ts);
      return ts;
    }).catch(() => {
      resolvePlaceholder(undefined);
      return undefined;
    });
    return placeholderPostingPromise;
  };

  placeholderTimer = setTimeout(() => {
    void ensurePlaceholderPosted();
  }, processingNoticeDelayMs);

  const cancelPlaceholder = () => {
    clearPlaceholderTimer();
    if (!placeholderDeferred.resolved) {
      resolvePlaceholder(undefined);
    }
  };

  const markStreamFailure = async (reason: string, error?: unknown): Promise<void> => {
    if (streamFailed) {
      return;
    }
    streamFailed = true;
    streamFailedReason = reason;
    emit({
      type: "stream_failed",
      reason,
      error: error instanceof Error ? error.message : (typeof error === "string" ? error : undefined),
      ts: streamTs,
    });
    if (!streamTs) {
      await ensurePlaceholderPosted();
    }
  };

  const clearFlushTimer = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  };

  const flushBufferedText = async (): Promise<void> => {
    if (!streamingEnabled || streamingDisabled || streamFailed || finalized) {
      return;
    }
    const renderedText = messagePayloadText(bufferedRawText, args.linearWorkspace);
    if (!renderedText.startsWith(sentRenderedText)) {
      await markStreamFailure("rendered prefix mismatch during streaming");
      return;
    }
    const appendText = renderedText.slice(sentRenderedText.length);
    if (!appendText) {
      return;
    }

    try {
      if (!streamTs) {
        const startResult = await webClient.chat.startStream({
          channel: args.channel,
          thread_ts: args.threadTs,
          recipient_user_id: args.recipientUserId,
          recipient_team_id: args.recipientTeamId,
          markdown_text: appendText,
        });
        streamTs = startResult.ts;
        emit({
          type: "stream_started",
          ts: startResult.ts,
        });
      } else {
        await webClient.chat.appendStream({
          channel: args.channel,
          ts: streamTs,
          markdown_text: appendText,
        });
      }
      sentRenderedText = renderedText;
    } catch (error) {
      await markStreamFailure("stream append failed", error);
    }
  };

  const flushNow = async (): Promise<void> => {
    clearFlushTimer();
    const next = (flushPromise ?? Promise.resolve()).then(flushBufferedText);
    flushPromise = next.finally(() => {
      if (flushPromise === next) {
        flushPromise = undefined;
      }
    });
    await next;
  };

  const scheduleFlush = () => {
    if (!streamingEnabled || streamingDisabled || streamFailed || finalized || flushTimer) {
      return;
    }
    flushTimer = setTimeout(() => {
      void flushNow();
    }, appendThrottleMs);
  };

  return {
    async enableStreaming(): Promise<boolean> {
      if (streamingDisabled || finalized || placeholderPostedTs) {
        emit({
          type: "stream_fallback",
          reason: placeholderPostedTs ? "processing notice already posted" : "streaming disabled",
          ts: placeholderPostedTs,
        });
        return false;
      }
      if (!args.recipientTeamId) {
        emit({
          type: "stream_fallback",
          reason: "missing recipient team id",
        });
        return false;
      }
      if (streamFailed) {
        emit({
          type: "stream_fallback",
          reason: streamFailedReason ?? "stream already failed",
          ts: streamTs,
        });
        return false;
      }
      if (streamingEnabled) {
        return true;
      }

      streamingEnabled = true;
      cancelPlaceholder();
      if (bufferedRawText) {
        await flushNow();
      }
      if (streamFailed) {
        emit({
          type: "stream_fallback",
          reason: streamFailedReason ?? "stream setup failed",
          ts: streamTs,
        });
        return false;
      }
      return true;
    },

    disableStreaming(): void {
      streamingDisabled = true;
      streamingEnabled = false;
      bufferedRawText = "";
      clearFlushTimer();
    },

    pushTextDelta(delta: string): void {
      if (!delta || streamingDisabled || finalized) {
        return;
      }
      bufferedRawText += delta;
      if (streamingEnabled && !streamFailed) {
        scheduleFlush();
      }
    },

    async finalizeReply(reply: string): Promise<string> {
      clearFlushTimer();
      const finalRenderedReply = messagePayloadText(reply, args.linearWorkspace);

      if (streamingEnabled && !streamingDisabled) {
        bufferedRawText = reply;
        if (!streamFailed) {
          await flushNow();
        }

        if (
          streamTs
          && !streamFailed
          && finalRenderedReply.startsWith(sentRenderedText)
        ) {
          const finalAppendText = finalRenderedReply.slice(sentRenderedText.length);
          try {
            await webClient.chat.stopStream({
              channel: args.channel,
              ts: streamTs,
              markdown_text: finalAppendText || undefined,
            });
            finalized = true;
            emit({
              type: "stream_stopped",
              ts: streamTs,
            });
            return finalRenderedReply;
          } catch (error) {
            await markStreamFailure("stream stop failed", error);
          }
        }

        emit({
          type: "stream_fallback",
          reason: streamFailedReason
            ?? (streamTs ? "final reply diverged from streamed content" : "stream never started"),
          ts: streamTs ?? placeholderPostedTs,
        });
      } else {
        cancelPlaceholder();
      }

      finalized = true;
      const updateTs = streamTs ?? placeholderPostedTs ?? await placeholderDeferred.promise;
      return sendSlackReply(webClient, {
        channel: args.channel,
        threadTs: args.threadTs,
        reply,
        linearWorkspace: args.linearWorkspace,
        updateTs,
      });
    },
  };
}

export async function postSlackProcessingNotice(
  webClient: SlackChatClient,
  args: {
    channel: string;
    threadTs?: string;
    text?: string;
  },
): Promise<string | undefined> {
  const result = await webClient.chat.postMessage({
    channel: args.channel,
    thread_ts: args.threadTs,
    text: args.text ?? DEFAULT_PROCESSING_NOTICE,
  });
  return result.ts;
}

export async function sendSlackReply(
  webClient: SlackChatClient,
  args: {
    channel: string;
    reply: string;
    threadTs?: string;
    linearWorkspace: string;
    updateTs?: string;
  },
): Promise<string> {
  const payload = buildSlackMessagePayload(args.reply, { linearWorkspace: args.linearWorkspace });
  if (args.updateTs) {
    try {
      await webClient.chat.update({
        channel: args.channel,
        ts: args.updateTs,
        text: payload.text,
        blocks: payload.blocks,
      });
      return payload.text;
    } catch {
      // Fall back to a fresh thread reply when the placeholder cannot be updated.
    }
  }

  await webClient.chat.postMessage({
    channel: args.channel,
    thread_ts: args.threadTs,
    text: payload.text,
    blocks: payload.blocks,
  });
  return payload.text;
}

export async function postSlackMentionMessage(
  webClient: SlackChatClient,
  args: {
    channel: string;
    mentionSlackUserId: string;
    messageText: string;
    linearWorkspace: string;
    threadTs?: string;
  },
): Promise<{ text: string; ts?: string }> {
  const reply = `<@${args.mentionSlackUserId}> ${args.messageText.trim()}`.trim();
  const payload = buildSlackMessagePayload(reply, { linearWorkspace: args.linearWorkspace });
  const result = await webClient.chat.postMessage({
    channel: args.channel,
    thread_ts: args.threadTs,
    text: payload.text,
    blocks: payload.blocks,
  });
  return {
    text: payload.text,
    ts: result.ts,
  };
}
