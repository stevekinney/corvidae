/** The audit export: every page the filters match, JSON Lines, and the file it is saved as. */
import { afterEach, describe, expect, test } from 'bun:test';

import { installBureauStub, type BureauStub } from '../../lib/bureau-stub.test-support.ts';
import {
  auditExportFilename,
  downloadText,
  EXPORT_PAGE_SIZE,
  JSON_LINES_TYPE,
  readAuditExport,
  toJsonLines,
} from './audit-export.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

const record = (sequence: number, principal: string | null = 'alice') => ({
  sequence,
  timestamp: `2026-10-19T08:0${String(sequence)}:00.000Z`,
  type: 'run.completed',
  resource: `run-${String(sequence)}`,
  principal,
  detail: null,
});

describe('readAuditExport', () => {
  test('follows the cursor to the last page, asking for the largest page and keeping the filter', async () => {
    stub = installBureauStub({
      'bureau.audit.query': (params) =>
        params['cursor'] === undefined
          ? { records: [record(1), record(2)], nextCursor: 'c1' }
          : params['cursor'] === 'c1'
            ? { records: [record(3)], nextCursor: 'c2' }
            : { records: [record(4)], nextCursor: null },
    });

    const records = await readAuditExport({ type: 'run.completed', since: 5 }, '');

    expect(records.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4]);
    const calls = stub.callsTo('bureau.audit.query').map((call) => call.params);
    expect(calls.map((params) => params['cursor'])).toEqual([undefined, 'c1', 'c2']);
    for (const params of calls) {
      expect(params).toMatchObject({ limit: EXPORT_PAGE_SIZE, type: 'run.completed', since: 5 });
    }
  });

  test('keeps only what the person asked for, across every page', async () => {
    stub = installBureauStub({
      'bureau.audit.query': (params) =>
        params['cursor'] === undefined
          ? { records: [record(1, 'alice'), record(2, 'bob')], nextCursor: 'c1' }
          : { records: [record(3, 'alice'), record(4, null)], nextCursor: null },
    });

    const records = await readAuditExport({}, 'alice');

    expect(records.map((entry) => entry.sequence)).toEqual([1, 3]);
  });

  test('is empty for an empty trail', async () => {
    stub = installBureauStub({ 'bureau.audit.query': () => ({ records: [], nextCursor: null }) });
    expect(await readAuditExport({}, '')).toEqual([]);
  });
});

describe('toJsonLines', () => {
  test('is one compact JSON record per line with a final newline, and nothing for no records', () => {
    const text = toJsonLines([record(1), record(2)]);
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toEqual([record(1), record(2)]);
    expect(lines.every((line) => !line.includes('\n') && !line.startsWith(' '))).toBe(true);
    expect(toJsonLines([])).toBe('');
  });

  test('keeps a newline inside a value on its own line, escaped', () => {
    const text = toJsonLines([{ ...record(1), type: 'a\nb' }]);
    expect(text.trimEnd().split('\n')).toHaveLength(1);
  });
});

describe('auditExportFilename', () => {
  test('is the day it was exported, with the .jsonl extension', () => {
    expect(auditExportFilename(new Date('2026-10-31T23:59:59Z'))).toBe(
      'audit-log-2026-10-31.jsonl',
    );
  });
});

describe('downloadText', () => {
  test('saves the text under the name with the type, and lets go of the object URL', async () => {
    const saved: { blob: Blob; name: string }[] = [];
    const revoked: string[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const originalClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (blob) => {
      saved.push({ blob: blob as Blob, name: '' });
      return 'blob:one';
    };
    URL.revokeObjectURL = (url) => {
      revoked.push(url);
    };
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      saved[0]!.name = this.download;
    };
    try {
      downloadText('{"a":1}\n', 'file.jsonl', JSON_LINES_TYPE);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      HTMLAnchorElement.prototype.click = originalClick;
    }
    expect(saved[0]?.name).toBe('file.jsonl');
    expect(saved[0]?.blob.type).toBe(JSON_LINES_TYPE);
    expect(await saved[0]?.blob.text()).toBe('{"a":1}\n');
    expect(revoked).toEqual(['blob:one']);
  });
});
