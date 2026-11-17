import type { SkillScope } from "./types";

export const PROJECT_DIR = ".paseo";

const CREDENTIAL_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_ed25519",
  "id_dsa",
  "id_ecdsa",
  "credentials",
  "credentials.json",
  "secrets.json",
]);

const CREDENTIAL_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".keystore"];

/**
 * Returns a normalized repository-relative path, or null when the path is
 * absolute, escapes the repository, or contains a Windows separator.
 */
export function normalizeRepositoryPath(input: string): string | null {
  if (
    !input ||
    input.startsWith("/") ||
    input.includes("\\") ||
    input.includes("\0")
  ) {
    return null;
  }
  const parts = input.split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") return null;
    normalized.push(part);
  }
  return normalized.join("/");
}

/** True when `target` is inside `root` after pure segment comparison. */
export function isContainedPath(root: string, target: string): boolean {
  const normalizedRoot = root.replace(/\/+$/, "");
  return target === normalizedRoot || target.startsWith(`${normalizedRoot}/`);
}

export function isCredentialPath(path: string): boolean {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (CREDENTIAL_NAMES.has(name)) return true;
  if (name.startsWith(".env.")) return true;
  return CREDENTIAL_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export function isValidSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-_]*$/.test(name);
}

export function assetIdForSkill(scope: SkillScope, name: string): string {
  return `skill:${scope}/${name}`;
}

export function parseSkillAssetId(
  assetId: string,
): { scope: SkillScope; name: string } | null {
  const match = /^skill:project\/([^/]+)$/.exec(assetId);
  if (!match) return null;
  return { scope: "project", name: match[1] as string };
}

export function knowledgeAssetId(name: string): string {
  return `knowledge/${name}`;
}

export function docAssetId(name: string): string {
  return `doc/${name}`;
}

export function parseKnowledgeAssetId(assetId: string): string | null {
  const match = /^knowledge\/([^/]+)\.md$/.exec(assetId);
  return match ? (match[1] as string) : null;
}

export function parseDocAssetId(assetId: string): string | null {
  const match = /^doc\/([^/]+)$/.exec(assetId);
  return match ? (match[1] as string) : null;
}
