import type { AssetKind, DriftItem } from "../shared/core/types";

export interface DriftCounts {
  byKind: Map<AssetKind, number>;
  byProvider: Map<string, number>;
}

/**
 * Counts what each tab should advertise.
 *
 * `byKind` covers every kind. `byProvider` is scoped to the open kind because a
 * Skill and a SYSTEM Prompt can both be associated under Claude; showing "2"
 * beside Claude on the Skills tab would promise a Skill that is not there.
 * Ignored entries still render in the "ignored" section, but they are not work
 * the user has to do, so they do not raise a count.
 */
export function countDrift(
  items: readonly DriftItem[],
  kind: AssetKind | null,
): DriftCounts {
  const byKind = new Map<AssetKind, number>();
  const byProvider = new Map<string, number>();
  for (const item of items) {
    if (item.ignored) continue;
    byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
    if (item.kind !== kind) continue;
    if (item.provider) {
      byProvider.set(item.provider, (byProvider.get(item.provider) ?? 0) + 1);
      continue;
    }
    // Entity-backed Skills are computed once, so advertise the same work on
    // every provider tab that still projects the entity.
    for (const projection of item.projections ?? []) {
      byProvider.set(
        projection.provider,
        (byProvider.get(projection.provider) ?? 0) + 1,
      );
    }
  }
  return { byKind, byProvider };
}
