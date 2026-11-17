import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyTaskControls } from './outcome-accounting.ts';

const scratch = mkdtempSync(join(tmpdir(), 'outcome-accounting-controls-'));
const bank = JSON.parse(await Bun.file('scripts/chef/fixtures/sdlc-task-bank.json').text());
const errors = verifyTaskControls(bank, scratch);
rmSync(scratch, { recursive: true, force: true });

test('each frozen task oracle rejects buggy and empty controls, then accepts the repair', () => {
  expect(errors).toEqual([]);
});
