/**
 * COR-1926: a source the host stops trusting is refused at the next use by a run that started
 * before the change. The client offers the revision it was built with and consults
 * `currentCatalog` whenever a skill is used.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFilesystemArtifactLoader } from '../../../src/skills/client/artifact-loader';
import { createSkillClient, type SkillClient } from '../../../src/skills/client/skill-client';
import type { SkillCatalogRevision } from '../../../src/skills/discovery/catalog';
import { discoverSkills } from '../../../src/skills/discovery/discover';

const now = (): string => '2026-10-30T00:00:00.000Z';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A host whose one source `workspace` is trusted or not, rediscovered on every change. */
async function host(initiallyTrusted: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'corvidae-skill-revocation-'));
  roots.push(root);
  await mkdir(join(root, 'deploy', 'references'), { recursive: true });
  await writeFile(
    join(root, 'deploy', 'SKILL.md'),
    '---\nname: deploy\ndescription: Deploys.\n---\n\nBody.\n',
  );
  await writeFile(join(root, 'deploy', 'references', 'guide.md'), '# Guide');
  let trusted = initiallyTrusted;
  let revision = 0;
  const discover = async (): Promise<SkillCatalogRevision> =>
    discoverSkills({
      sources: [{ id: 'workspace', kind: 'project', location: root, precedence: 20 }],
      trustPolicy: {
        decide: () => ({
          state: trusted ? 'trusted' : 'untrusted',
          reason: trusted ? 'listed' : 'not listed',
        }),
      },
      revision: (revision += 1),
      now,
    });
  let current = await discover();
  return {
    get current() {
      return current;
    },
    async setTrusted(next: boolean) {
      trusted = next;
      current = await discover();
    },
    /** A run: a client bound to the catalog as it is now, checking the host's catalog at use. */
    run(): SkillClient {
      return createSkillClient({
        catalog: current,
        currentCatalog: () => current,
        loadArtifact: createFilesystemArtifactLoader(),
        now,
      });
    },
  };
}

type Step =
  | { readonly do: 'revoke' | 'trust' | 'deactivate' }
  | { readonly do: 'activate'; readonly expect: 'activated' | 'refused' }
  | { readonly do: 'resource'; readonly expect: 'loaded' | 'refused' }
  | { readonly do: 'active'; readonly expect: readonly string[] };

const rows: ReadonlyArray<{
  readonly name: string;
  readonly trustedAtStart: boolean;
  /** Steps before the run starts, then after. */
  readonly beforeRun: readonly ('revoke' | 'trust')[];
  readonly steps: readonly Step[];
}> = [
  {
    name: 'revoked before the run starts: the first use is refused',
    trustedAtStart: true,
    beforeRun: ['revoke'],
    steps: [{ do: 'activate', expect: 'refused' }],
  },
  {
    name: 'revoked during the run, before its first use: the first use is refused',
    trustedAtStart: true,
    beforeRun: [],
    steps: [{ do: 'revoke' }, { do: 'activate', expect: 'refused' }],
  },
  {
    name: 'revoked between two uses: the second use is refused and the skill leaves the active set',
    trustedAtStart: true,
    beforeRun: [],
    steps: [
      { do: 'activate', expect: 'activated' },
      { do: 'resource', expect: 'loaded' },
      { do: 'revoke' },
      { do: 'resource', expect: 'refused' },
      { do: 'active', expect: [] },
      { do: 'deactivate' },
      { do: 'activate', expect: 'refused' },
    ],
  },
  {
    name: 'trusted again after a revoke: the next use is allowed and the skill is active again',
    trustedAtStart: true,
    beforeRun: [],
    steps: [
      { do: 'activate', expect: 'activated' },
      { do: 'revoke' },
      { do: 'activate', expect: 'refused' },
      { do: 'active', expect: [] },
      { do: 'trust' },
      { do: 'resource', expect: 'loaded' },
      { do: 'active', expect: ['deploy'] },
      { do: 'activate', expect: 'refused' },
    ],
  },
  {
    name: 'trusted only after the run started: it was never offered, so it stays refused',
    trustedAtStart: false,
    beforeRun: [],
    steps: [{ do: 'trust' }, { do: 'activate', expect: 'refused' }],
  },
];

describe('revocation reaches a run already in flight', () => {
  for (const row of rows) {
    it(row.name, async () => {
      const home = await host(row.trustedAtStart);
      for (const change of row.beforeRun) await home.setTrusted(change === 'trust');
      const client = home.run();

      for (const step of row.steps) {
        switch (step.do) {
          case 'revoke':
            await home.setTrusted(false);
            break;
          case 'trust':
            await home.setTrusted(true);
            break;
          case 'deactivate':
            client.deactivate('deploy');
            break;
          case 'activate': {
            const outcome = await client.activate('deploy');
            expect(outcome.activated ? 'activated' : 'refused').toBe(step.expect);
            break;
          }
          case 'resource':
            expect(
              client.loadResource('deploy', 'references/guide.md') === undefined
                ? 'refused'
                : 'loaded',
            ).toBe(step.expect);
            break;
          case 'active':
            expect(client.active().map((skill) => skill.record.name)).toEqual([...step.expect]);
            break;
        }
      }
    });
  }

  it('refuses with the reason the current catalog gives, and stops offering the skill', async () => {
    const home = await host(true);
    const client = home.run();
    expect(client.offered().map((entry) => entry.name)).toEqual(['deploy']);

    await home.setTrusted(false);

    expect(await client.activate('deploy')).toMatchObject({
      activated: false,
      refusal: 'source-untrusted',
    });
    expect(client.offered()).toEqual([]);
    expect(client.report()[0]?.standing).toBe('untrusted');
  });

  it('applies to a child client and to recovery of a stored activation', async () => {
    const home = await host(true);
    const client = home.run();
    await client.activate('deploy');
    const records = client.activationRecords();
    const child = client.attenuate({});
    await home.setTrusted(false);

    expect(await child.activate('deploy')).toMatchObject({ activated: false });
    expect(await home.run().recover(records)).toEqual({ recovered: [], refused: ['deploy'] });
  });

  it('keeps the bound catalog when there is no current catalog', async () => {
    const home = await host(true);
    const client = createSkillClient({
      catalog: home.current,
      loadArtifact: createFilesystemArtifactLoader(),
      now,
    });
    await home.setTrusted(false);

    expect(await client.activate('deploy')).toMatchObject({ activated: true });
  });
});
