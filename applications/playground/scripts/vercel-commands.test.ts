import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

/**
 * Vercel's build image ships Bun on `PATH`, and `bunx bun@<version>` exits 1 there without a
 * word: every production deployment from 2026-10-28 failed in the install command before Bun
 * printed its banner, while the image's own Bun ran the same install. The commands must call
 * the image's `bun` directly.
 */
async function commands(): Promise<string[]> {
  const configuration = (await Bun.file(join(import.meta.dirname, '..', 'vercel.json')).json()) as {
    installCommand: string;
    buildCommand: string;
  };
  return [configuration.installCommand, configuration.buildCommand];
}

describe('vercel.json commands', () => {
  it('never launch Bun through bunx', async () => {
    for (const command of await commands()) expect(command).not.toMatch(/bunx\s+bun@/);
  });

  it('install with a frozen lockfile', async () => {
    expect((await commands())[0]).toContain('bun install --frozen-lockfile');
  });
});
