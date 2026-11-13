import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { recordBaselineFromFile } from "./baseline";
import { resolveState } from "./asset-state";
import { atomicWriteFile, fileExists } from "./fs-utils";

export async function overwriteDrift(input: {
  projectId: string;
  workspaceDirectory: string;
  assetId: string;
  path?: string;
  provider?: string;
}): Promise<{ updatedFiles: string[]; keptFiles: string[] }> {
  const state = await resolveState(input);
  const updatedFiles: string[] = [];
  const keptFiles: string[] = [];
  for (const file of state.files) {
    if (!(await fileExists(file.file.remotePath))) {
      keptFiles.push(file.file.localPath);
      continue;
    }
    const buffer = await readFile(file.file.remotePath);
    await mkdir(dirname(file.file.localPath), { recursive: true });
    await atomicWriteFile(file.file.localPath, buffer);
    await recordBaselineFromFile({
      workspaceDirectory: input.workspaceDirectory,
      assetId: input.assetId,
      kind: state.resolved.asset.kind,
      provider: state.resolved.provider,
      relativePath: file.file.relativePath,
      sourcePath: file.file.remotePath,
    });
    updatedFiles.push(file.file.localPath);
  }
  return { updatedFiles, keptFiles };
}
