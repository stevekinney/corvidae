/**
 * A block-mode capture with no committed baseline writes the page's screenshot as the
 * `<name>-actual.png` of the test's output path before it fails, so the fixtures job's artifact
 * holds an image `baselines-from-run.ts` can copy (it maps `<component>/<name>-actual.png` to a
 * `new` baseline).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactKey } from './artifact-path.ts';
import { missingBaselineActualPath, writeMissingBaselineActual } from './screenshot.ts';

const key: ArtifactKey = {
  slug: 'approval-card',
  theme: 'light',
  viewport: 'desktop',
  fixture: 'assertion',
};

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function testInfo(): Promise<{ outputPath: (...segments: string[]) => string }> {
  directory = await mkdtemp(join(tmpdir(), 'missing-baseline-'));
  const root = directory;
  return { outputPath: (...segments) => join(root, ...segments) };
}

describe('writeMissingBaselineActual', () => {
  it('names the actual <component>/<theme>-<viewport>-<fixture>-actual.png', async () => {
    const info = await testInfo();
    expect(missingBaselineActualPath(key, info)).toBe(
      join(directory ?? '', 'approval-card', 'light-desktop-assertion-actual.png'),
    );
  });

  it('captures as toHaveScreenshot does: CSS pixels, animations off, caret hidden', async () => {
    const info = await testInfo();
    let received: object | undefined;
    await writeMissingBaselineActual(
      {
        screenshot: async (options?: object) => {
          received = options;
          return Buffer.from('');
        },
      },
      key,
      info,
    );
    expect(received).toMatchObject({
      scale: 'css',
      animations: 'disabled',
      caret: 'hide',
      fullPage: false,
    });
  });

  it("writes the page's screenshot there", async () => {
    const info = await testInfo();
    const page = {
      screenshot: async (options?: { path?: string }) => {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(options?.path ?? '', 'png bytes');
        return Buffer.from('png bytes');
      },
    };
    const path = await writeMissingBaselineActual(page, key, info);
    expect(path).toBe(missingBaselineActualPath(key, info));
    expect(await readFile(path ?? '', 'utf8')).toBe('png bytes');
  });

  it('never hides the missing-baseline error when the screenshot cannot be taken', async () => {
    const info = await testInfo();
    const page = {
      screenshot: async () => {
        throw new Error('page closed');
      },
    };
    expect(await writeMissingBaselineActual(page, key, info)).toBeUndefined();
  });
});
