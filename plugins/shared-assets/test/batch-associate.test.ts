import { describe, expect, it } from "vitest";
import { batchAssociateRows } from "../client/batch-associate";
import type { AssetRelationshipRow } from "../shared/core/types";

function row(id: string): AssetRelationshipRow {
  return {
    id,
    relationship: "candidate",
    shared: {
      assetId: `skill:project/${id}`,
      kind: "skill",
      name: id,
      scope: "project",
      description: null,
      path: `skills/project/${id}`,
      fileCount: 1,
      totalBytes: 1,
      files: [],
      warnings: [],
    },
    local: {
      assetId: `local-skill:codex/${id}`,
      kind: "skill",
      name: id,
      provider: "codex",
      path: `/tmp/${id}`,
      description: null,
      fileCount: 1,
      totalBytes: 1,
      warnings: [],
    },
    syncStatus: null,
    driftFiles: 0,
  };
}

describe("batchAssociateRows", () => {
  it("runs adopt calls serially and continues after a failure", async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const result = await batchAssociateRows(
      [row("alpha"), row("beta"), row("gamma")],
      async (entry) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(entry.id);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        if (entry.id === "beta") throw new Error("association failed");
      },
    );

    expect(order).toEqual(["alpha", "beta", "gamma"]);
    expect(maxActive).toBe(1);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      assetId: "skill:project/beta",
      name: "beta",
      message: "association failed",
    });
  });
});
