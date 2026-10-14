/**
 * Drift guard for `documentation/reference/api-errors.md`. Source comments in
 * `fault-code.ts` and `weft-error.ts` cite that page as the complete FaultCode
 * mapping and WeftErrorCode table, so each table must match the source maps
 * row for row.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FAULT_CODE_TO_HTTP_STATUS,
  FAULT_CODE_TO_JSON_RPC_CODE,
} from '../server/operation-fault.ts';
import { FAULT_CODE_TO_FAILURE_CATEGORY } from './fault-code.ts';
import { isWeftErrorCode } from './weft-error.ts';

const sourceDirectory = join(import.meta.dir, '..');
const documentation = readFileSync(
  join(sourceDirectory, '..', 'documentation', 'reference', 'api-errors.md'),
  'utf8',
);

/** Body rows (header excluded) of the Markdown table under the named `##` heading. */
function tableRows(heading: string): string[][] {
  const start = documentation.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`api-errors.md has no "## ${heading}" section`);
  const next = documentation.indexOf('\n## ', start + 1);
  const lines = documentation.slice(start, next === -1 ? undefined : next).split('\n');
  const isSeparator = (line: string): boolean => /^\|[\s|:-]+\|$/.test(line);
  return lines
    .filter(
      (line, index) =>
        line.startsWith('| ') && !isSeparator(line) && !isSeparator(lines[index + 1] ?? ''),
    )
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim().replaceAll('`', '')),
    );
}

/** Keys of `publicWeftErrorCodeMap`, which `satisfies Record<WeftErrorCode, true>`. */
function publicWeftErrorCodes(): string[] {
  const source = readFileSync(join(import.meta.dir, 'weft-error.ts'), 'utf8');
  const body = /const publicWeftErrorCodeMap = \{\n([\s\S]*?)\n\} satisfies/.exec(source)?.[1];
  if (body === undefined) throw new Error('publicWeftErrorCodeMap not found in weft-error.ts');
  return [...body.matchAll(/^ {2}(\w+): true,$/gm)].map((match) => match[1] ?? '');
}

describe('documentation/reference/api-errors.md', () => {
  it('lists every FaultCode with its HTTP status, JSON-RPC code, and failure category', () => {
    const documented = tableRows('FaultCode').map(([code, status, rpc, category]) => [
      code,
      Number(status),
      Number(rpc),
      category,
    ]);
    const expected = Object.keys(FAULT_CODE_TO_FAILURE_CATEGORY).map((code) => {
      const faultCode = code as keyof typeof FAULT_CODE_TO_FAILURE_CATEGORY;
      return [
        faultCode,
        FAULT_CODE_TO_HTTP_STATUS[faultCode],
        FAULT_CODE_TO_JSON_RPC_CODE[faultCode],
        FAULT_CODE_TO_FAILURE_CATEGORY[faultCode],
      ];
    });

    expect(documented.toSorted()).toEqual(expected.toSorted());
  });

  it('lists every public WeftErrorCode exactly once, each in the file that defines it', () => {
    const rows = tableRows('WeftErrorCode');
    const documented = rows.map(([code]) => code);

    expect(documented.toSorted()).toEqual(publicWeftErrorCodes().toSorted());
    for (const [code = '', file = ''] of rows) {
      expect(isWeftErrorCode(code)).toBe(true);
      const path = join(sourceDirectory, file);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toMatch(new RegExp(`class ${code}\\b`));
    }
  });
});
