import type { AssetRelationshipRow } from "../shared/core/types";

export interface BatchAssociateFailure {
  assetId: string;
  name: string;
  message: string;
}

export interface BatchAssociateOutcome {
  succeeded: number;
  failed: BatchAssociateFailure[];
}

/** Associates candidates one at a time so one failure cannot abort the rest. */
export async function batchAssociateRows(
  rows: readonly AssetRelationshipRow[],
  adopt: (row: AssetRelationshipRow) => Promise<void>,
): Promise<BatchAssociateOutcome> {
  let succeeded = 0;
  const failed: BatchAssociateFailure[] = [];
  for (const row of rows) {
    try {
      await adopt(row);
      succeeded += 1;
    } catch (error) {
      failed.push({
        assetId: row.shared?.assetId ?? row.id,
        name: row.shared?.name ?? row.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { succeeded, failed };
}
