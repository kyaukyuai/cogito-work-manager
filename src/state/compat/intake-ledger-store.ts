import type { SystemPaths } from "../../lib/system-workspace.js";
import { createFileBackedManagerRepositories } from "../repositories/file-backed-manager-repositories.js";
import type { CompatIntakeLedgerEntry } from "./intake-ledger-contract.js";

export async function loadCompatIntakeLedger(paths: SystemPaths): Promise<CompatIntakeLedgerEntry[]> {
  return createFileBackedManagerRepositories(paths).intake.load();
}

export async function saveCompatIntakeLedger(
  paths: SystemPaths,
  ledger: CompatIntakeLedgerEntry[],
): Promise<void> {
  await createFileBackedManagerRepositories(paths).intake.save(ledger);
}
