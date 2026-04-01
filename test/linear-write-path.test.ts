import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

function mockExecFileSuccess(handler: (args: string[]) => Promise<{ stdout: string; stderr?: string }>) {
  execFileMock.mockImplementation((_: string, args: string[], __: unknown, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
    void handler(args)
      .then((result) => callback(null, { stdout: result.stdout, stderr: result.stderr ?? "" }))
      .catch((error) => callback(error as Error));
    return {} as never;
  });
}

function mockExecFileFailure(handler: (args: string[]) => Promise<Error>) {
  execFileMock.mockImplementation((_: string, args: string[], __: unknown, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
    void handler(args).then((error) => callback(error));
    return {} as never;
  });
}

async function assertFileRemoved(filePath: string) {
  await expect(access(filePath, constants.F_OK)).rejects.toThrow();
}

afterEach(() => {
  execFileMock.mockReset();
  vi.resetModules();
  vi.useRealTimers();
});

describe("linear write path hardening", () => {
  it("rejects linear-cli versions below 2.12.3", async () => {
    mockExecFileSuccess(async () => ({ stdout: "linear-cli v2.8.0" }));
    const { verifyLinearCli } = await import("../src/lib/linear.js");

    await expect(verifyLinearCli("AIC")).rejects.toThrow("linear-cli v2.12.3 or newer is required");
  });

  it("verifies runtime capabilities via linear capabilities --json", async () => {
    mockExecFileSuccess(async (args) => {
      if (args[0] === "--version") {
        return { stdout: "linear-cli v2.12.3" };
      }
      if (args[0] === "auth" && args[1] === "whoami") {
        return { stdout: "diagnostics-user" };
      }
      if (args[0] === "capabilities") {
        return {
          stdout: JSON.stringify({
            schemaVersion: "v2",
            cli: { version: "2.12.3" },
            contractVersions: {
              automation: { latest: "v5" },
            },
            commands: [
              { path: "linear capabilities", json: { supported: true, contractVersion: null }, dryRun: { supported: false, contractVersion: null } },
              { path: "linear issue list", json: { supported: true, contractVersion: "v1" }, dryRun: { supported: false, contractVersion: null } },
              { path: "linear issue view", json: { supported: true, contractVersion: "v1" }, dryRun: { supported: false, contractVersion: null } },
              { path: "linear issue create", json: { supported: true, contractVersion: "v1" }, dryRun: { supported: true, contractVersion: "v1" } },
              { path: "linear issue update", json: { supported: true, contractVersion: "v1" }, dryRun: { supported: true, contractVersion: "v1" } },
              { path: "linear issue comment add", json: { supported: true, contractVersion: "v1" }, dryRun: { supported: true, contractVersion: "v1" } },
              { path: "linear issue relation add", json: { supported: true, contractVersion: "v1" }, dryRun: { supported: true, contractVersion: "v1" } },
              { path: "linear issue relation list", json: { supported: true, contractVersion: "v1" }, dryRun: { supported: false, contractVersion: null } },
              { path: "linear issue parent", json: { supported: true, contractVersion: "v1" }, dryRun: { supported: false, contractVersion: null } },
              { path: "linear issue children", json: { supported: true, contractVersion: "v1" }, dryRun: { supported: false, contractVersion: null } },
              { path: "linear issue create-batch", json: { supported: true, contractVersion: "v1" }, dryRun: { supported: true, contractVersion: "v1" } },
              { path: "linear team members", json: { supported: true, contractVersion: "v1" }, dryRun: { supported: false, contractVersion: null } },
              { path: "linear project list", json: { supported: true, contractVersion: "v2" }, dryRun: { supported: false, contractVersion: null } },
              { path: "linear project view", json: { supported: true, contractVersion: "v2" }, dryRun: { supported: false, contractVersion: null } },
              { path: "linear project create", json: { supported: true, contractVersion: null }, dryRun: { supported: true, contractVersion: "v1" } },
              { path: "linear project update", json: { supported: false, contractVersion: null }, dryRun: { supported: true, contractVersion: "v1" } },
              { path: "linear webhook list", json: { supported: true, contractVersion: "v3" }, dryRun: { supported: false, contractVersion: null } },
              { path: "linear webhook create", json: { supported: true, contractVersion: null }, dryRun: { supported: true, contractVersion: "v1" } },
              { path: "linear webhook update", json: { supported: true, contractVersion: null }, dryRun: { supported: true, contractVersion: "v1" } },
              { path: "linear label list", json: { supported: true, contractVersion: "v4" }, dryRun: { supported: false, contractVersion: null } },
              { path: "linear user list", json: { supported: true, contractVersion: "v4" }, dryRun: { supported: false, contractVersion: null } },
              { path: "linear workflow-state list", json: { supported: true, contractVersion: "v4" }, dryRun: { supported: false, contractVersion: null } },
            ],
          }),
        };
      }
      if (args[0] === "team" && args[1] === "list") {
        return { stdout: "AIC Alpha Team\nOPS Ops Team" };
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    });
    const { verifyLinearCli } = await import("../src/lib/linear.js");

    await expect(verifyLinearCli("AIC")).resolves.toBeUndefined();
  });

  it("uses --description-file for multiline managed issue creation and cleans the temp file", async () => {
    let descriptionFilePath = "";
    mockExecFileSuccess(async (args) => {
      const flagIndex = args.indexOf("--description-file");
      expect(flagIndex).toBeGreaterThan(-1);
      expect(args).not.toContain("--description");
      descriptionFilePath = args[flagIndex + 1] ?? "";
      expect(await readFile(descriptionFilePath, "utf8")).toBe("# Summary\n- markdown");
      return {
        stdout: JSON.stringify({ id: "issue-1", identifier: "AIC-1", title: "Smoke test" }),
      };
    });
    const { createManagedLinearIssue } = await import("../src/lib/linear.js");

    await createManagedLinearIssue(
      {
        title: "Smoke test",
        description: "# Summary\n- markdown",
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "AIC",
      },
    );

    expect(descriptionFilePath).toBeTruthy();
    await assertFileRemoved(descriptionFilePath);
  });

  it("uses --description-file for multiline managed issue updates and cleans the temp file", async () => {
    let descriptionFilePath = "";
    mockExecFileSuccess(async (args) => {
      const flagIndex = args.indexOf("--description-file");
      expect(flagIndex).toBeGreaterThan(-1);
      expect(args).not.toContain("--description");
      descriptionFilePath = args[flagIndex + 1] ?? "";
      expect(await readFile(descriptionFilePath, "utf8")).toBe("line 1\nline 2");
      return {
        stdout: JSON.stringify({ id: "issue-1", identifier: "AIC-1", title: "Updated issue" }),
      };
    });
    const { updateManagedLinearIssue } = await import("../src/lib/linear.js");

    await updateManagedLinearIssue(
      {
        issueId: "AIC-1",
        description: "line 1\nline 2",
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "AIC",
      },
    );

    expect(descriptionFilePath).toBeTruthy();
    await assertFileRemoved(descriptionFilePath);
  });

  it("keeps single-line update descriptions inline", async () => {
    mockExecFileSuccess(async (args) => {
      expect(args).toContain("--description");
      expect(args).toContain("single line");
      expect(args).not.toContain("--description-file");
      return {
        stdout: JSON.stringify({ id: "issue-1", identifier: "AIC-1", title: "Updated issue" }),
      };
    });
    const { updateManagedLinearIssue } = await import("../src/lib/linear.js");

    await updateManagedLinearIssue(
      {
        issueId: "AIC-1",
        description: "single line",
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "AIC",
      },
    );
  });

  it("uses --body-file for multiline comments and cleans the temp file on failure", async () => {
    let commentFilePath = "";
    mockExecFileFailure(async (args) => {
      const flagIndex = args.indexOf("--body-file");
      expect(flagIndex).toBeGreaterThan(-1);
      expect(args).not.toContain("--body");
      commentFilePath = args[flagIndex + 1] ?? "";
      expect(await readFile(commentFilePath, "utf8")).toBe("first line\nsecond line");
      const error = new Error("comment failed") as Error & { stdout: string; stderr: string };
      error.stdout = "";
      error.stderr = "";
      return error;
    });
    const { addLinearComment } = await import("../src/lib/linear.js");

    await expect(
      addLinearComment(
        "AIC-1",
        "first line\nsecond line",
        {
          LINEAR_API_KEY: "lin_api_test",
          LINEAR_TEAM_KEY: "AIC",
        },
      ),
    ).rejects.toThrow("comment failed");

    expect(commentFilePath).toBeTruthy();
    await assertFileRemoved(commentFilePath);
  });

  it("splits managed updates with comments into update and comment commands", async () => {
    const commands: string[][] = [];
    mockExecFileSuccess(async (args) => {
      commands.push(args);
      if (args[0] === "issue" && args[1] === "update") {
        expect(args).not.toContain("--comment");
        return {
          stdout: JSON.stringify({ id: "issue-1", identifier: "AIC-1", title: "Updated issue" }),
        };
      }
      expect(args.slice(0, 3)).toEqual(["issue", "comment", "add"]);
      return {
        stdout: JSON.stringify({ id: "comment-1", body: "done" }),
      };
    });
    const { updateManagedLinearIssue } = await import("../src/lib/linear.js");

    await updateManagedLinearIssue(
      {
        issueId: "AIC-1",
        state: "Done",
        comment: "完了しました",
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "AIC",
      },
    );

    expect(commands).toHaveLength(2);
    expect(commands[0]?.slice(0, 2)).toEqual(["issue", "update"]);
    expect(commands[1]?.slice(0, 3)).toEqual(["issue", "comment", "add"]);
  });

  it("passes a shorter LINEAR_WRITE_TIMEOUT_MS to issue writes when not configured", async () => {
    execFileMock.mockImplementation((_: string, args: string[], options: { env?: NodeJS.ProcessEnv }, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      expect(args.slice(0, 2)).toEqual(["issue", "update"]);
      expect(options.env?.LINEAR_WRITE_TIMEOUT_MS).toBe("25000");
      callback(null, {
        stdout: JSON.stringify({ id: "issue-1", identifier: "AIC-1", title: "Updated issue" }),
        stderr: "",
      });
      return {} as never;
    });
    const { updateManagedLinearIssue } = await import("../src/lib/linear.js");

    await expect(updateManagedLinearIssue(
      {
        issueId: "AIC-1",
        state: "Done",
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "AIC",
      },
    )).resolves.toMatchObject({ identifier: "AIC-1" });
  });

  it("times out hung linear commands instead of waiting forever", async () => {
    vi.useFakeTimers();
    execFileMock.mockImplementation((_: string, __: string[], options: { signal?: AbortSignal }, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      options.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        callback(error);
      }, { once: true });
      return {} as never;
    });
    const { LINEAR_COMMAND_TIMEOUT_MS, updateManagedLinearIssue } = await import("../src/lib/linear.js");

    const promise = updateManagedLinearIssue(
      {
        issueId: "AIC-1",
        state: "Done",
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "AIC",
      },
    );

    const expectation = expect(promise).rejects.toThrow(`timed out after ${LINEAR_COMMAND_TIMEOUT_MS}ms`);
    await vi.advanceTimersByTimeAsync(LINEAR_COMMAND_TIMEOUT_MS);
    await expectation;
  });

  it("treats linear-cli timeout_error envelopes as timeout failures", async () => {
    mockExecFileFailure(async () => {
      const error = new Error("write timeout") as Error & { stdout: string; stderr: string };
      error.stdout = JSON.stringify({
        success: false,
        error: {
          type: "timeout_error",
          message: "Timed out waiting for issue.update confirmation after 25000ms. The write may still have been accepted by Linear.",
          suggestion: "Check Linear before retrying.",
          details: {
            failureMode: "timeout_waiting_for_confirmation",
            timeoutMs: 25000,
            operation: "issue.update",
            outcome: "unknown",
            appliedState: "uncertain",
            callerGuidance: {
              nextAction: "reconcile_read_before_retry",
              retrySafe: false,
            },
          },
        },
      });
      error.stderr = "";
      return error;
    });
    const { updateManagedLinearIssue } = await import("../src/lib/linear.js");

    await expect(updateManagedLinearIssue(
      {
        issueId: "AIC-1",
        state: "Done",
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "AIC",
      },
    )).rejects.toMatchObject({
      name: "LinearCommandTimeoutError",
      timeoutMs: 25000,
      appliedState: "uncertain",
      callerGuidance: {
        nextAction: "reconcile_read_before_retry",
        retrySafe: false,
      },
    });
  });

  it("keeps repeated relation add calls as successful no-op capable operations", async () => {
    mockExecFileSuccess(async (args) => {
      expect(args.slice(0, 4)).toEqual(["issue", "relation", "add", "AIC-1"]);
      return {
        stdout: JSON.stringify({ success: true, noop: true }),
      };
    });
    const { addLinearRelation } = await import("../src/lib/linear.js");

    await expect(addLinearRelation("AIC-1", "blocks", "AIC-2", { LINEAR_API_KEY: "lin_api_test" })).resolves.toBeUndefined();
    await expect(addLinearRelation("AIC-1", "blocks", "AIC-2", { LINEAR_API_KEY: "lin_api_test" })).resolves.toBeUndefined();
  });
});
