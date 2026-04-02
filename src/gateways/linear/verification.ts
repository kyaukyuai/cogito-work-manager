import {
  compareLinearCliVersions,
  extractLinearCliVersion,
  parseLinearCliCapabilitiesPayload,
  REQUIRED_LINEAR_CLI_VERSION,
  validateLinearCliCapabilities,
} from "./capabilities.js";
import { execLinear } from "./command-runner.js";

export async function verifyLinearCli(teamKey: string): Promise<void> {
  const versionResult = await execLinear(["--version"], process.env);
  const version = versionResult.stdout || versionResult.stderr;
  const normalizedVersion = extractLinearCliVersion(version) ?? version;
  if (compareLinearCliVersions(normalizedVersion, REQUIRED_LINEAR_CLI_VERSION) < 0) {
    throw new Error(`linear-cli v${REQUIRED_LINEAR_CLI_VERSION} or newer is required. Current version: ${version || "unknown"}`);
  }

  const whoami = await execLinear(["auth", "whoami"], process.env);
  if (!(whoami.stdout || whoami.stderr).trim()) {
    throw new Error("linear auth whoami returned empty output");
  }

  const capabilities = await execLinear(["capabilities", "--json"], process.env);
  const parsedCapabilities = parseLinearCliCapabilitiesPayload(capabilities.stdout || capabilities.stderr);
  if (!parsedCapabilities) {
    throw new Error("linear capabilities --json returned an invalid payload");
  }

  const capabilityErrors = validateLinearCliCapabilities(parsedCapabilities);
  if (capabilityErrors.length > 0) {
    throw new Error(`linear capabilities --json is missing required runtime surface: ${capabilityErrors.join(" | ")}`);
  }

  const teamList = await execLinear(["team", "list"], process.env);
  const lines = teamList.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const hasTeam = lines.some((line) => line.startsWith(`${teamKey} `) || line === teamKey);
  if (!hasTeam) {
    throw new Error(`LINEAR_TEAM_KEY "${teamKey}" was not found in linear team list output`);
  }
}
