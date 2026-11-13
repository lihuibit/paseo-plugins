import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PROVIDERS } from "../shared/core/providers";
import type { ProviderStatus } from "../shared/core/types";

const execute = promisify(execFile);

async function installed(binary: string | null): Promise<boolean> {
  if (!binary) return false;
  try {
    const result = await execute("which", [binary], { timeout: 2000 });
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function listProviderStatuses(): Promise<ProviderStatus[]> {
  return await Promise.all(
    PROVIDERS.map(async (provider) => ({
      id: provider.id,
      label: provider.label,
      binary: provider.binary,
      installed: await installed(provider.binary),
      skillRoot: provider.skillRoot,
      userSkillRoot: provider.userSkillRoot,
      instructionEntrypoint: provider.instructionEntrypoint,
      skillVerified: provider.skillVerified,
      instructionVerified: provider.instructionVerified,
      note: provider.note,
    })),
  );
}
