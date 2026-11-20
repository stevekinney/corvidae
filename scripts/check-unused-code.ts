/** Compares a Knip JSON report with the reviewed baseline. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Finding = { category: string; file: string; name: string };
type JsonRecord = Record<string, unknown>;

function object(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as JsonRecord;
}

export function findingsFromReport(value: unknown): Finding[] {
  const report = object(value, 'Knip report');
  if (!Array.isArray(report.issues)) throw new Error('Knip report must contain an issues array.');
  return report.issues.flatMap((entry, index) => {
    const issue = object(entry, `Knip issue ${index}`);
    if (typeof issue.file !== 'string' || issue.file === '')
      throw new Error(`Knip issue ${index} must name a file.`);
    return Object.entries(issue).flatMap(([category, findings]) => {
      if (category === 'file') return [];
      if (!Array.isArray(findings))
        throw new Error(`Malformed ${category} findings in ${issue.file}.`);
      return findings.map((finding) => {
        const nameOf = (value: unknown) => {
          const item = object(value, `${category} finding in ${issue.file}`);
          if (typeof item.name !== 'string' || item.name === '')
            throw new Error(`${category} finding in ${issue.file} must name a symbol.`);
          return item.name;
        };
        const name = Array.isArray(finding)
          ? JSON.stringify(finding.map(nameOf).toSorted())
          : nameOf(finding);
        return { category, file: issue.file, name };
      });
    });
  });
}

export function unexpectedFindings(
  report: readonly Finding[],
  baseline: readonly Finding[],
): Finding[] {
  const accepted = new Set(baseline.map((finding) => JSON.stringify(finding)));
  return report.filter((finding) => !accepted.has(JSON.stringify(finding)));
}

function baselineFindings(text: string): Finding[] {
  if (text.trim() === '') return [];
  return text
    .trimEnd()
    .split('\n')
    .map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`Baseline row ${index + 1} is invalid JSON.`);
      }
      if (
        !Array.isArray(value) ||
        value.length !== 3 ||
        !value.every((part) => typeof part === 'string')
      )
        throw new Error(`Baseline row ${index + 1} must be [category, file, name].`);
      return { category: value[0], file: value[1], name: value[2] };
    });
}

async function main(): Promise<void> {
  const [reportPath, baselinePath] = process.argv.slice(2);
  if (reportPath === undefined || baselinePath === undefined)
    throw new Error('Usage: bun scripts/check-unused-code.ts <knip-report.json> <baseline.txt>');
  const report = findingsFromReport(JSON.parse(readFileSync(resolve(reportPath), 'utf8')));
  const baseline = baselineFindings(readFileSync(resolve(baselinePath), 'utf8'));
  const unexpected = unexpectedFindings(report, baseline);
  const additions = new Set(unexpected.map((finding) => JSON.stringify(finding)));
  const retained = report.filter((finding) => !additions.has(JSON.stringify(finding)));
  const inventoryPath = `${reportPath}.retained.jsonl`;
  await Bun.write(
    inventoryPath,
    retained.map((finding) => JSON.stringify(finding)).join('\n') + '\n',
  );
  process.stdout.write(
    `check-unused-code — ${retained.length} retained findings in ${inventoryPath}.\n`,
  );
  for (const finding of unexpected)
    process.stderr.write(
      `check-unused-code — ${finding.category} ${finding.file}: ${finding.name}\n`,
    );
  if (unexpected.length > 0) process.exitCode = 1;
}

if (import.meta.main) await main();
