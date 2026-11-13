const MAX_DIFF_LINES = 4000;
const CONTEXT_LINES = 3;

type Op = { kind: "equal" | "insert" | "delete"; line: string };

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r\n/g, "\n").split("\n");
}

/** Longest-common-subsequence line diff. Bounded so a huge file cannot stall the daemon. */
function buildOps(before: string[], after: string[]): Op[] {
  const n = before.length;
  const m = after.length;
  if (n + m > MAX_DIFF_LINES) {
    return [
      ...before.map((line): Op => ({ kind: "delete", line })),
      ...after.map((line): Op => ({ kind: "insert", line })),
    ];
  }

  const width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        before[i] === after[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              table[(i + 1) * width + j] ?? 0,
              table[i * width + j + 1] ?? 0,
            );
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: "equal", line: before[i] as string });
      i += 1;
      j += 1;
    } else if (
      (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)
    ) {
      ops.push({ kind: "delete", line: before[i] as string });
      i += 1;
    } else {
      ops.push({ kind: "insert", line: after[j] as string });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "delete", line: before[i] as string });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "insert", line: after[j] as string });
    j += 1;
  }
  return ops;
}

/** Produces a unified diff suitable for a preview; an identical file yields "". */
export function unifiedDiff(
  path: string,
  beforeText: string,
  afterText: string,
): string {
  if (beforeText === afterText) return "";
  const before = splitLines(beforeText);
  const after = splitLines(afterText);
  const ops = buildOps(before, after);

  const changed: number[] = [];
  ops.forEach((op, index) => {
    if (op.kind !== "equal") changed.push(index);
  });
  if (changed.length === 0) return "";

  const first = changed[0] as number;
  const last = changed[changed.length - 1] as number;
  const start = Math.max(0, first - CONTEXT_LINES);
  const end = Math.min(ops.length - 1, last + CONTEXT_LINES);

  let beforeLine = 0;
  let afterLine = 0;
  for (let index = 0; index < start; index += 1) {
    const op = ops[index] as Op;
    if (op.kind !== "insert") beforeLine += 1;
    if (op.kind !== "delete") afterLine += 1;
  }

  let beforeCount = 0;
  let afterCount = 0;
  const body: string[] = [];
  for (let index = start; index <= end; index += 1) {
    const op = ops[index] as Op;
    if (op.kind === "equal") {
      body.push(` ${op.line}`);
      beforeCount += 1;
      afterCount += 1;
    } else if (op.kind === "delete") {
      body.push(`-${op.line}`);
      beforeCount += 1;
    } else {
      body.push(`+${op.line}`);
      afterCount += 1;
    }
  }

  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${beforeLine + 1},${beforeCount} +${afterLine + 1},${afterCount} @@`,
    ...body,
    "",
  ].join("\n");
}
