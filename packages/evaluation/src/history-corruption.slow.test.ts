import { describe, expect, test } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';

import type { EvaluationRunRecord } from './evaluation-run';
import baselineFixture from './fixtures/history/baseline-run.json';
import { CorruptHistoricalRecordError, createEvaluationHistory } from './history';
import { BASELINE_RUN_ID } from './history.test-support';

/*
 * Slow lane (COR-1499). Flipping every byte of a roughly 10 KB stored record means about ten
 * thousand full reads, each decoding, schema-parsing, canonicalizing and hashing it. The cost is the
 * assertion's subject, so the test keeps every byte and runs here, serially, instead of in the
 * fast lane.
 */
describe('createEvaluationHistory corruption', () => {
  test('rejects read() with CorruptHistoricalRecordError when any single byte of the stored record changes', async () => {
    const storage = new MemoryStorage();
    const store = textValueStore(storage);
    const history = createEvaluationHistory(store);
    const appended = await history.append(structuredClone(baselineFixture) as EvaluationRunRecord);
    const keys = await store.list('');
    expect(keys).toHaveLength(1);
    const key = keys[0]!;
    const original = (await storage.get(key))!.slice();

    for (let index = 0; index < original.length; index++) {
      const changed = original.slice();
      changed[index] = changed[index]! ^ 0x01;
      await storage.put(key, changed);
      expect(await rejectionOf(history.read(BASELINE_RUN_ID))).toBeInstanceOf(
        CorruptHistoricalRecordError,
      );
    }

    await storage.put(key, original);
    expect(await history.read(BASELINE_RUN_ID)).toEqual(appended);
  });
});
