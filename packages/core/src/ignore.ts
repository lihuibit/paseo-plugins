import type { AssetKind } from "./types";

export type IgnoreRule =
  | { type: "path"; value: string }
  | { type: "kind"; value: AssetKind }
  | { type: "asset"; value: string };

export interface IgnoreRuleParseResult {
  rules: IgnoreRule[];
  errors: Array<{ line: number; message: string }>;
}

const KINDS: readonly AssetKind[] = ["skill", "prompt", "knowledge", "doc"];

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(character)) {
      source += `\\${character}`;
    } else {
      source += character;
    }
  }
  return new RegExp(`${source}$`);
}

interface FileRule {
  pattern: string;
  directoryOnly: boolean;
  anchored: boolean;
  negated: boolean;
}

/**
 * Parses one path rule with gitignore semantics. `**` has no equivalent in the
 * file matcher, so such a rule is dropped rather than approximated.
 */
function parseFileRule(value: string): FileRule | null {
  let body = value.trim();
  const negated = body.startsWith("!");
  if (negated) body = body.slice(1);
  if (!body || body.includes("**")) return null;

  const directoryOnly = body.endsWith("/");
  if (directoryOnly) body = body.slice(0, -1);
  const anchored = body.startsWith("/");
  if (anchored) body = body.slice(1);
  const pattern = body.replace(/^\.\//, "");
  if (!pattern) return null;

  return { pattern, directoryOnly, anchored, negated };
}

function matchesSegment(pattern: string, value: string): boolean {
  if (!/[*?[]/.test(pattern)) return pattern === value;
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === "*") {
      source += "[^/]*";
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    if (character === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close > index + 1) {
        source += pattern.slice(index, close + 1);
        index = close;
        continue;
      }
    }
    source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`).test(value);
}

function fileRuleMatches(
  rule: FileRule,
  relativePath: string,
  isDirectory: boolean,
): boolean {
  if (rule.directoryOnly && !isDirectory) return false;
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length === 0) return false;

  if (rule.anchored) {
    const depth = rule.pattern.split("/").length;
    if (segments.length < depth) return false;
    return matchesSegment(rule.pattern, segments.slice(0, depth).join("/"));
  }

  // Unanchored patterns match at any depth: `*.pyc` catches `a.pyc` and
  // `scripts/lib/a.pyc` alike.
  for (let start = segments.length - 1; start >= 0; start -= 1) {
    if (matchesSegment(rule.pattern, segments.slice(start).join("/")))
      return true;
  }
  return false;
}

/**
 * Applies gitignore-style path rules to one or more relative paths.
 *
 * Rules are evaluated in file order and the last matching rule wins, which is
 * what makes `!keep.pyc` able to re-include a file excluded by `*.pyc`.
 */
export function matchesFileIgnoreRules(
  relativePaths: string | string[],
  rules: IgnoreRule[],
): boolean {
  const candidates = (
    Array.isArray(relativePaths) ? relativePaths : [relativePaths]
  )
    .map((path) => path.replace(/\\/g, "/").replace(/^\/+/, ""))
    .filter(Boolean);
  if (candidates.length === 0) return false;

  let ignored = false;
  for (const rule of rules) {
    if (rule.type !== "path") continue;
    const fileRule = parseFileRule(rule.value);
    if (!fileRule) continue;
    const matched = candidates.some((candidate) => {
      const segments = candidate.split("/");
      const directoryMatch = segments.some((_, index) =>
        index < segments.length - 1
          ? fileRuleMatches(
              fileRule,
              segments.slice(0, index + 1).join("/"),
              true,
            )
          : false,
      );
      return directoryMatch || fileRuleMatches(fileRule, candidate, false);
    });
    if (matched) ignored = !fileRule.negated;
  }
  return ignored;
}

/**
 * Parses the shared `ignore-rules` file. Blank lines and `#` comments are
 * ignored; unknown prefixes are reported instead of silently dropped.
 */
export function parseIgnoreRules(text: string): IgnoreRuleParseResult {
  const rules: IgnoreRule[] = [];
  const errors: Array<{ line: number; message: string }> = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const separator = line.indexOf(":");
    const prefix = separator > 0 ? line.slice(0, separator) : "";
    if (prefix === "path") {
      const value = line.slice(separator + 1).trim();
      if (!value || value.includes("..")) {
        errors.push({ line: index + 1, message: "invalid path rule" });
      } else rules.push({ type: "path", value });
      return;
    }
    if (prefix === "kind") {
      const value = line.slice(separator + 1).trim() as AssetKind;
      if (!KINDS.includes(value)) {
        errors.push({
          line: index + 1,
          message: `unknown asset kind: ${value}`,
        });
      } else rules.push({ type: "kind", value });
      return;
    }
    if (prefix === "asset") {
      const value = line.slice(separator + 1).trim();
      if (!value) {
        errors.push({ line: index + 1, message: "invalid asset rule" });
      } else rules.push({ type: "asset", value });
      return;
    }
    if (line.includes(":")) {
      errors.push({ line: index + 1, message: `unknown rule type: ${prefix}` });
      return;
    }
    if (line.includes("..")) {
      errors.push({ line: index + 1, message: "invalid path rule" });
      return;
    }
    rules.push({ type: "path", value: line });
  });
  return { rules, errors };
}

export function formatIgnoreRules(rules: IgnoreRule[]): string {
  const lines = rules.map((rule) => `${rule.type}:${rule.value}`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function matchesPath(pattern: string, target: string): boolean {
  if (globToRegExp(pattern).test(target)) return true;
  return target === pattern || target.startsWith(`${pattern}/`);
}

export function matchesIgnoreRules(
  asset: { assetId: string; kind: AssetKind; path: string },
  rules: IgnoreRule[],
): boolean {
  return rules.some((rule) => {
    if (rule.type === "asset") return asset.assetId === rule.value;
    if (rule.type === "kind") return asset.kind === rule.value;
    if (rule.value.startsWith("!")) return false;
    return matchesPath(rule.value, asset.path);
  });
}
