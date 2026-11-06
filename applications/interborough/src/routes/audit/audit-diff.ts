/**
 * The change an agent's version made to its instructions, as the unified patch Cinder's
 * `SourceDiffViewer` draws. The Bureau keeps each saved version's definition, so the two versions
 * an `agent.updated` record names (`previousRevision` and `revision`) hold the before and after
 * text; the record itself never carries instructions.
 */

/** How many lines of context surround a change, as `diff -u` does. */
const CONTEXT_LINES = 3;

/**
 * The longest pair of texts, in lines multiplied together, that is compared line by line. A pair
 * past it is shown as every old line removed and every new line added, which is a correct patch and
 * cannot take a long time to build.
 */
const COMPARISON_LIMIT = 4_000_000;

type Step = { readonly kind: ' ' | '-' | '+'; readonly text: string };

function linesOf(value: string): string[] {
  if (value === '') return [];
  const lines = value.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** The steps that turn `before` into `after`: the longest common subsequence of lines, kept as context. */
function stepsOf(before: readonly string[], after: readonly string[]): Step[] {
  if (before.length * after.length > COMPARISON_LIMIT) {
    return [
      ...before.map((text): Step => ({ kind: '-', text })),
      ...after.map((text): Step => ({ kind: '+', text })),
    ];
  }
  // lengths[i][j] is the length of the longest common run of before[i..] and after[j..].
  const columns = after.length + 1;
  const lengths = new Uint32Array((before.length + 1) * columns);
  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      lengths[row * columns + column] =
        before[row] === after[column]
          ? (lengths[(row + 1) * columns + column + 1] ?? 0) + 1
          : Math.max(
              lengths[(row + 1) * columns + column] ?? 0,
              lengths[row * columns + column + 1] ?? 0,
            );
    }
  }
  const steps: Step[] = [];
  let row = 0;
  let column = 0;
  while (row < before.length && column < after.length) {
    if (before[row] === after[column]) {
      steps.push({ kind: ' ', text: before[row] ?? '' });
      row += 1;
      column += 1;
    } else if (
      (lengths[(row + 1) * columns + column] ?? 0) >= (lengths[row * columns + column + 1] ?? 0)
    ) {
      steps.push({ kind: '-', text: before[row] ?? '' });
      row += 1;
    } else {
      steps.push({ kind: '+', text: after[column] ?? '' });
      column += 1;
    }
  }
  for (; row < before.length; row += 1) steps.push({ kind: '-', text: before[row] ?? '' });
  for (; column < after.length; column += 1) steps.push({ kind: '+', text: after[column] ?? '' });
  return steps;
}

/** How many lines `steps` adds and removes. */
export function changedLineCount(steps: readonly Step[]): number {
  return steps.filter((step) => step.kind !== ' ').length;
}

/**
 * The unified patch from `before` to `after`, with three lines of context around each change, or
 * `undefined` when the two read the same.
 */
export function instructionPatch(before: string, after: string): string | undefined {
  const steps = stepsOf(linesOf(before), linesOf(after));
  if (changedLineCount(steps) === 0) return undefined;
  // The steps a hunk keeps: every change and the context lines within reach of one.
  const keep = Array.from({ length: steps.length }, () => false);
  steps.forEach((step, index) => {
    if (step.kind === ' ') return;
    const from = Math.max(0, index - CONTEXT_LINES);
    const to = Math.min(steps.length - 1, index + CONTEXT_LINES);
    for (let near = from; near <= to; near += 1) keep[near] = true;
  });
  const out = ['--- a/instructions.md', '+++ b/instructions.md'];
  let oldLine = 1;
  let newLine = 1;
  let index = 0;
  while (index < steps.length) {
    if (keep[index] !== true) {
      const step = steps[index];
      if (step?.kind !== '+') oldLine += 1;
      if (step?.kind !== '-') newLine += 1;
      index += 1;
      continue;
    }
    const hunk: Step[] = [];
    const oldStart = oldLine;
    const newStart = newLine;
    while (index < steps.length && keep[index] === true) {
      const step = steps[index];
      if (step !== undefined) hunk.push(step);
      if (step?.kind !== '+') oldLine += 1;
      if (step?.kind !== '-') newLine += 1;
      index += 1;
    }
    const oldCount = hunk.filter((step) => step.kind !== '+').length;
    const newCount = hunk.filter((step) => step.kind !== '-').length;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const step of hunk) out.push(`${step.kind}${step.text}`);
  }
  return `${out.join('\n')}\n`;
}
