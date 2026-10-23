/**
 * COR-837 — the A2A `application/a2ui+json` data part Bureau sends for a surface is checked in as a
 * golden file that the browser fixture renders with `A2uiSurface`
 * (`scripts/browser-fixtures/src/fixtures/a2ui-a2a-part.golden.json`). This test builds the part
 * from a real surface and requires it to equal the file, so the renderer's end-to-end test and
 * Bureau's emitter cannot drift apart. Delete the file and run the test to regenerate it (then format it with Prettier).
 */
import { Part } from '@a2a-js/sdk';
import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

import {
  a2uiHarness,
  confirmAction,
  createMessage,
  panelComponents,
  TASK,
  updateComponentsMessage,
} from '../a2ui/a2ui.test-support.ts';
import { A2UI_EXTENSION_URI } from '../a2ui/catalogs.ts';
import { surfaceParts } from './a2a-task-projection.ts';

const GOLDEN = resolve(
  import.meta.dirname,
  '../../../../scripts/browser-fixtures/src/fixtures/a2ui-a2a-part.golden.json',
);

describe('the A2UI data part of an A2A task', () => {
  it('equals the golden part the browser fixture renders', async () => {
    const h = a2uiHarness();
    await h.adapter.apply({
      taskId: TASK,
      commandId: 'create',
      messages: [createMessage('panel'), updateComponentsMessage('panel', panelComponents())],
      actions: [confirmAction],
      complete: true,
    });
    await h.adapter.apply({
      taskId: TASK,
      commandId: 'data',
      baseRevision: 1,
      messages: [
        {
          version: 'v0.9.1',
          updateDataModel: { surfaceId: 'panel', path: '/note', value: 'ready' },
        },
      ],
    });
    const surface = await h.snapshot('panel');
    const parts = surfaceParts([surface], new Set([A2UI_EXTENSION_URI]));
    expect(parts).toHaveLength(1);
    const wire: unknown = JSON.parse(JSON.stringify(Part.toJSON(parts[0]!)));

    if (!(await Bun.file(GOLDEN).exists())) {
      await Bun.write(GOLDEN, `${JSON.stringify(wire, null, 2)}\n`);
    }
    expect(wire).toEqual(JSON.parse(await Bun.file(GOLDEN).text()));
  });
});
