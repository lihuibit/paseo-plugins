import { describe, expect, it } from "vitest";
import { hasConflictMarkers, merge3 } from "../src/merge";
import {
  formatIgnoreRules,
  matchesFileIgnoreRules,
  matchesIgnoreRules,
  parseIgnoreRules,
} from "../src/ignore";

const BASE = ["# Guide", "", "one", "two", "three", ""].join("\n");

describe("three-way merge", () => {
  it("merges edits on different lines without conflicts", () => {
    const local = ["# Guide", "", "one local", "two", "three", ""].join("\n");
    const remote = ["# Guide", "", "one", "two", "three remote", ""].join("\n");
    const result = merge3(BASE, local, remote);
    expect(result.conflicts).toEqual([]);
    expect(result.merged).toContain("one local");
    expect(result.merged).toContain("three remote");
  });

  it("takes the shared change when only the remote changed", () => {
    const remote = ["# Guide", "", "one", "two remote", "three", ""].join("\n");
    const result = merge3(BASE, BASE, remote);
    expect(result.conflicts).toEqual([]);
    expect(result.merged).toBe(remote);
  });

  it("reports one conflict for overlapping edits and keeps both sides", () => {
    const local = ["# Guide", "", "one", "two local", "three", ""].join("\n");
    const remote = ["# Guide", "", "one", "two remote", "three", ""].join("\n");
    const result = merge3(BASE, local, remote);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.local).toBe("two local");
    expect(result.conflicts[0]?.remote).toBe("two remote");
    expect(hasConflictMarkers(result.merged)).toBe(true);
  });

  it("treats identical edits on both sides as merged", () => {
    const same = ["# Guide", "", "one", "two same", "three", ""].join("\n");
    const result = merge3(BASE, same, same);
    expect(result.conflicts).toEqual([]);
    expect(result.merged).toBe(same);
  });

  it("adds adjacent insertion and edit independently", () => {
    const local = ["# Guide", "", "one", "two", "inserted", "three", ""].join(
      "\n",
    );
    const remote = ["# Guide", "", "one", "two", "three changed", ""].join(
      "\n",
    );
    const result = merge3(BASE, local, remote);
    expect(result.conflicts).toEqual([]);
    expect(result.merged).toContain("inserted");
    expect(result.merged).toContain("three changed");
  });
});

describe("ignore rules", () => {
  it("parses path, kind, asset and bare path rules", () => {
    const parsed = parseIgnoreRules(
      [
        "# comment",
        "path:docs/draft/**",
        "kind:knowledge",
        "asset:skill:project/review",
        "knowledge/archive.md",
      ].join("\n"),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.rules).toHaveLength(4);
  });

  it("reports malformed rules", () => {
    const parsed = parseIgnoreRules("kind:nope\nunknown:value\n../escape");
    expect(parsed.errors).toHaveLength(3);
  });

  it("matches by path glob, kind, asset and directory prefix", () => {
    const { rules } = parseIgnoreRules(
      ["kind:knowledge", "path:docs/draft/**", "skills/project/old"].join("\n"),
    );
    expect(
      matchesIgnoreRules(
        {
          assetId: "knowledge/a.md",
          kind: "knowledge",
          path: "knowledge/a.md",
        },
        rules,
      ),
    ).toBe(true);
    expect(
      matchesIgnoreRules(
        {
          assetId: "doc/draft",
          kind: "doc",
          path: "docs/draft/nested/readme.md",
        },
        rules,
      ),
    ).toBe(true);
    expect(
      matchesIgnoreRules(
        {
          assetId: "skill:project/old",
          kind: "skill",
          path: "skills/project/old",
        },
        rules,
      ),
    ).toBe(true);
    expect(
      matchesIgnoreRules(
        { assetId: "doc/design", kind: "doc", path: "docs/design/README.md" },
        rules,
      ),
    ).toBe(false);
  });

  it("round-trips rule text", () => {
    const { rules } = parseIgnoreRules("kind:doc\npath:docs/x/**\n");
    expect(formatIgnoreRules(rules)).toBe("kind:doc\npath:docs/x/**\n");
  });

  it("matches gitignore-style file rules at any depth", () => {
    const { rules } = parseIgnoreRules(
      ["path:*.pyc", "__pycache__/", "dir/", "/anchored"].join("\n"),
    );
    expect(
      matchesFileIgnoreRules("scripts/__pycache__/doppler.pyc", rules),
    ).toBe(true);
    expect(matchesFileIgnoreRules("scripts/doppler.pyc", rules)).toBe(true);
    expect(matchesFileIgnoreRules("nested/dir/file.txt", rules)).toBe(true);
    expect(matchesFileIgnoreRules("anchored/file.txt", rules)).toBe(true);
    expect(matchesFileIgnoreRules("nested/anchored/file.txt", rules)).toBe(
      false,
    );
  });

  it("supports wildcards and last-match negation", () => {
    const { rules } = parseIgnoreRules("*.py[cod]\n!keep.pyc\n");
    expect(matchesFileIgnoreRules("a/b/drop.pyc", rules)).toBe(true);
    expect(matchesFileIgnoreRules("a/b/drop.pyo", rules)).toBe(true);
    expect(matchesFileIgnoreRules("a/b/keep.pyc", rules)).toBe(false);
    expect(matchesFileIgnoreRules("a/b/keep.txt", rules)).toBe(false);
  });

  it("drops unsupported ** rules for file matching", () => {
    const { rules } = parseIgnoreRules("docs/**\n");
    expect(matchesFileIgnoreRules("docs/nested/file.md", rules)).toBe(false);
  });
});
