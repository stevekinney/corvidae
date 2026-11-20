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
    if (typeof issue.file !== 'string') throw new Error(`Knip issue ${index} must name a file.`);
    return Object.entries(issue).flatMap(([category, findings]) => {
      if (category === 'file' || !Array.isArray(findings)) return [];
      return findings.map((finding) => {
        if (Array.isArray(finding))
          return { category, file: issue.file, name: JSON.stringify(finding) };
        const item = object(finding, `${category} finding in ${issue.file}`);
        if (typeof item.name !== 'string')
          throw new Error(`${category} finding in ${issue.file} must name a symbol.`);
        return { category, file: issue.file, name: item.name };
      });
    });
  });
}

export function unexpectedFindings(report: readonly Finding[], baseline: readonly Finding[]): Finding[] {
  const accepted = new Set(baseline.map((finding) => JSON.stringify(finding)));
  return report.filter((finding) => !accepted.has(JSON.stringify(finding)));
}

function main(): void {
  const [reportPath, baselinePath] = process.argv.slice(2);
  if (reportPath === undefined || baselinePath === undefined)
    throw new Error('Usage: bun scripts/check-unused-code.ts <knip-report.json> <baseline.json>');
  const report = findingsFromReport(JSON.parse(readFileSync(resolve(reportPath), 'utf8')));
  const baseline = findingsFromReport(JSON.parse(readFileSync(resolve(baselinePath), 'utf8')));
  const unexpected = unexpectedFindings(report, baseline);
  for (const finding of unexpected)
    process.stderr.write(`check-unused-code — ${finding.category} ${finding.file}: ${finding.name}\n`);
  if (unexpected.length > 0) process.exitCode = 1;
}

if (import.meta.main) main();
