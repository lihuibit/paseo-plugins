import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { PluginError } from "../shared/core/errors";

const GIT_TIMEOUT_MS = 45_000;
const OUTPUT_LIMIT = 4 * 1024 * 1024;

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function runGit(
  cwd: string | null,
  args: string[],
  options: { allowFailure?: boolean; timeoutMs?: number } = {},
): Promise<GitResult> {
  return await new Promise<GitResult>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: cwd ?? undefined,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/true",
        LC_ALL: "C",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(
        new PluginError(
          "E_INTERNAL",
          `git ${args[0] ?? ""} timed out after ${GIT_TIMEOUT_MS}ms`,
        ),
      );
    }, options.timeoutMs ?? GIT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new PluginError("E_INTERNAL", `cannot run git: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        code: code ?? 1,
      };
      if (result.code !== 0 && !options.allowFailure)
        reject(gitFailure(args, result));
      else resolve(result);
    });
  });
}

function gitFailure(args: string[], result: GitResult): PluginError {
  const output = `${result.stderr}\n${result.stdout}`.trim();
  const lower = output.toLowerCase();
  if (
    lower.includes("authentication failed") ||
    lower.includes("could not read username") ||
    lower.includes("permission denied (publickey)") ||
    lower.includes("access denied")
  ) {
    return new PluginError("E_REPO_AUTH", "Git authentication failed", {
      output,
    });
  }
  if (
    lower.includes("repository not found") ||
    lower.includes("does not appear to be a git repository") ||
    lower.includes("could not read from remote repository")
  ) {
    return new PluginError(
      "E_REPO_NOT_FOUND",
      "Git repository is not reachable",
      { output },
    );
  }
  if (lower.includes("remote branch") && lower.includes("not found")) {
    return new PluginError("E_BRANCH_NOT_FOUND", "Git branch does not exist", {
      output,
    });
  }
  return new PluginError("E_INTERNAL", `git ${args.join(" ")} failed`, {
    exitCode: result.code,
    output: output.slice(-2000),
  });
}

export async function cloneRepository(
  repoUrl: string,
  target: string,
  branch: string | null,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  const args = ["clone", "--quiet", "--no-tags", "--", repoUrl, target];
  try {
    await runGit(null, args);
    if (branch) {
      const checkout = await runGit(target, ["checkout", "--quiet", branch], {
        allowFailure: true,
      });
      if (checkout.code !== 0) {
        throw new PluginError(
          "E_BRANCH_NOT_FOUND",
          `Branch "${branch}" does not exist`,
          {
            output: checkout.stderr,
          },
        );
      }
    }
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

/** Replaces a checkout with a freshly cloned one, restoring the old copy on failure. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const result = await runGit(
    cwd,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    {
      allowFailure: true,
    },
  );
  return result.code === 0 && result.stdout ? result.stdout : null;
}

export async function headRevision(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, ["rev-parse", "HEAD"], {
    allowFailure: true,
  });
  return result.code === 0 ? result.stdout : null;
}

export async function remoteRevision(
  cwd: string,
  branch: string,
): Promise<string | null> {
  const result = await runGit(cwd, ["rev-parse", `origin/${branch}`], {
    allowFailure: true,
  });
  return result.code === 0 ? result.stdout : null;
}

export async function isDirty(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, [
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);
  return result.stdout.length > 0;
}

export async function aheadBehind(
  cwd: string,
  branch: string,
): Promise<{ ahead: number; behind: number }> {
  const result = await runGit(
    cwd,
    ["rev-list", "--left-right", "--count", `HEAD...origin/${branch}`],
    {
      allowFailure: true,
    },
  );
  if (result.code !== 0) return { ahead: 0, behind: 0 };
  const [ahead, behind] = result.stdout
    .split(/\s+/)
    .map((value) => Number(value) || 0);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
}

export async function assertGitIdentity(cwd: string): Promise<void> {
  const name = await runGit(cwd, ["config", "--get", "user.name"], {
    allowFailure: true,
  });
  const email = await runGit(cwd, ["config", "--get", "user.email"], {
    allowFailure: true,
  });
  if (!name.stdout || !email.stdout) {
    throw new PluginError(
      "E_GIT_IDENTITY_MISSING",
      "Git author identity is not configured; run git config --global user.name/user.email",
    );
  }
}
