/**
 * The design review's geometry audit (`.agents/skills/design-review`). A reviewer reading a
 * screenshot cannot tell a two-pixel misalignment from none, or a button whose label has as much
 * room above it as beside it, so a capture also measures each page (`tests/e2e/design-review-geometry-probe.ts`
 * writes the facts beside the screenshots) and this script holds them to the thresholds the rubric
 * states (`references/rubric.md` "Craft"). It writes `geometry-findings.json` and
 * `geometry-report.md` into the capture directory; one defect seen on forty captures is one line
 * naming where.
 *
 *   bun scripts/design-review-geometry.ts --capture <capture directory>
 *
 * `scripts/design-review-capture.ts` runs it after every capture. Exit 0 when the reports were
 * written, 1 when the directory holds no measured capture, 2 on bad usage. A finding is a measured
 * fact, not a verdict: the reviewer confirms it on the screenshot and routes it, because a
 * threshold cannot see intent (a deliberately indented quotation, a primary action meant to span a
 * phone).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** A box in CSS pixels, in page coordinates. */
import {
  type GeometryCapture,
  type GeometryCoverage,
  type GeometryFacts,
  type GeometryFinding,
  GEOMETRY_THRESHOLDS,
  auditCapture,
  consolidateFindings,
  renderGeometryReport,
} from '@lostgradient/testing/design-review-geometry';

const SCALE_STEPS_MINIMUM = 3;

async function readManifest(directory: string): Promise<GeometryCapture[]> {
  let text: string;
  try {
    text = await readFile(join(directory, 'manifest.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as GeometryCapture);
}

/** Audits a capture directory and writes its two reports; answers what it read and found. */
export async function auditGeometry(
  directory: string,
): Promise<GeometryCoverage & { readonly findings: number }> {
  const captures = await readManifest(directory);
  const findings: GeometryFinding[] = [];
  let measured = 0;
  let coarse = 0;
  let unscaled = 0;
  for (const capture of captures) {
    if (capture.geometry === undefined) continue;
    const facts = JSON.parse(
      await readFile(join(directory, capture.geometry), 'utf8'),
    ) as GeometryFacts;
    measured += 1;
    if (facts.pointerCoarse) coarse += 1;
    if (facts.spaceScale.length < SCALE_STEPS_MINIMUM) unscaled += 1;
    findings.push(...auditCapture(facts, capture));
  }
  const coverage: GeometryCoverage = { captures: captures.length, measured, coarse, unscaled };
  if (measured === 0) return { ...coverage, findings: 0 };
  const consolidated = consolidateFindings(findings);
  await writeFile(
    join(directory, 'geometry-findings.json'),
    `${JSON.stringify({ coverage, thresholds: GEOMETRY_THRESHOLDS, findings: consolidated }, null, 2)}\n`,
  );
  await writeFile(
    join(directory, 'geometry-report.md'),
    renderGeometryReport(consolidated, coverage),
  );
  return { ...coverage, findings: consolidated.length };
}

/** Runs the command line and answers the exit code. */
export async function runGeometryAudit(
  argv: readonly string[] = process.argv.slice(2),
  write: { out: (text: string) => void; error: (text: string) => void } = {
    out: (text) => void process.stdout.write(text),
    error: (text) => void process.stderr.write(text),
  },
): Promise<number> {
  const [flag, value, ...rest] = argv;
  if (flag !== '--capture' || value === undefined || rest.length > 0) {
    write.error('usage: bun scripts/design-review-geometry.ts --capture <capture directory>\n');
    return 2;
  }
  const directory = resolve(value);
  const result = await auditGeometry(directory);
  if (result.measured === 0) {
    write.error(`design review: no measured capture in ${directory}\n`);
    return 1;
  }
  write.out(
    `design review: ${result.findings} geometry findings from ${result.measured} measured captures: ${join(directory, 'geometry-report.md')}\n`,
  );
  return 0;
}

if (import.meta.main) process.exitCode = await runGeometryAudit();
