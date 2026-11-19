/**
 * COR-2435 — `bureau.skills.get`: one catalogued skill's SKILL.md, for a person to read before an
 * agent loads it. It is named, never addressed by a path; it is authorized like
 * `bureau.skills.list`; it serves only the record's own SKILL.md (a symbolic link that leaves the
 * skill's directory, or a file changed since discovery, is refused); and it is bounded in size.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { discoverSkills } from '../../skills/discovery/discover.ts';
import { admitSources, type SkillSource } from '../../skills/discovery/source.ts';
import { createBureauHandler } from '../create-bureau-handler.ts';
import { disposeServed, serve } from './agent-definitions-fixtures.test-support.ts';
import { authentication, rpc } from './management-fixtures.test-support.ts';
import { MAXIMUM_SKILL_INSTRUCTIONS_BYTES, type SkillsStanding } from './skills-operations.ts';

const roots: string[] = [];

afterEach(async () => {
  await disposeServed();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const now = (): string => '2026-11-17T00:00:00.000Z';

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bureau-skills-get-'));
  roots.push(root);
  return root;
}

const releaseNotes = [
  '---',
  'name: release-notes',
  'description: Writes release notes from merged changes.',
  '---',
  '',
  'Group the merged pull requests by what changed for a customer.',
  '',
  '- Lead with the change, not the pull request number.',
  '',
].join('\n');

/** A source with `release-notes`, whose SKILL.md is `text`. */
async function oneSkill(
  text: string = releaseNotes,
): Promise<{ root: string; source: SkillSource }> {
  const root = await temporaryDirectory();
  await mkdir(join(root, 'release-notes'), { recursive: true });
  await writeFile(join(root, 'release-notes', 'SKILL.md'), text);
  return { root, source: { id: 'home', kind: 'user', location: root, precedence: 20 } };
}

async function standingOf(source: SkillSource): Promise<SkillsStanding> {
  return {
    catalog: await discoverSkills({ sources: [source], trustPolicy: admitSources([]), now }),
    sources: [],
  };
}

async function handlerOver(standing: () => Promise<SkillsStanding> | SkillsStanding) {
  const served = await serve();
  return createBureauHandler(served.bureau, { authentication, skills: { standing } });
}

describe('bureau.skills.get', () => {
  it('returns the skill’s SKILL.md and its size in bytes', async () => {
    const { source } = await oneSkill();
    const standing = await standingOf(source);
    const handler = await handlerOver(() => standing);

    const response = await rpc(
      handler,
      'bureau.skills.get',
      { name: 'release-notes' },
      'agents-reader-key',
    );

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      name: 'release-notes',
      instructions: {
        text: releaseNotes,
        size: new TextEncoder().encode(releaseNotes).byteLength,
        truncated: false,
      },
      unavailableReason: null,
    });
  });

  it('needs bureau.agents:read, and refuses before it looks the skill up', async () => {
    const { source } = await oneSkill();
    const standing = await standingOf(source);
    const handler = await handlerOver(() => standing);

    const known = await rpc(handler, 'bureau.skills.get', { name: 'release-notes' }, 'alice-key');
    const unknown = await rpc(handler, 'bureau.skills.get', { name: 'no-such-skill' }, 'alice-key');

    // The same refusal whether or not the skill exists, so it says nothing of what does.
    expect(known.error?.data?.httpStatus).toBe(403);
    expect(unknown.error?.data?.httpStatus).toBe(403);
    expect(known.result).toBeUndefined();
  });

  it('answers not-found for a name no skill has, and for a host that discovers none', async () => {
    const { source } = await oneSkill();
    const standing = await standingOf(source);
    const handler = await handlerOver(() => standing);
    const missing = await rpc(handler, 'bureau.skills.get', { name: 'other' }, 'agents-reader-key');
    expect(missing.result).toEqual({
      name: 'other',
      instructions: null,
      unavailableReason: 'not-found',
    });

    const served = await serve();
    const bare = createBureauHandler(served.bureau, { authentication });
    const none = await rpc(bare, 'bureau.skills.get', { name: 'other' }, 'agents-reader-key');
    expect(none.result).toMatchObject({ instructions: null, unavailableReason: 'not-found' });
  });

  it('takes a name, never a path', async () => {
    const { source } = await oneSkill();
    const standing = await standingOf(source);
    const handler = await handlerOver(() => standing);

    const response = await rpc(
      handler,
      'bureau.skills.get',
      { name: '../release-notes/SKILL.md' },
      'agents-reader-key',
    );
    expect(response.result).toMatchObject({ instructions: null, unavailableReason: 'not-found' });
  });

  it('refuses a SKILL.md that is a symbolic link out of the skill’s directory', async () => {
    const { root, source } = await oneSkill();
    const standing = await standingOf(source);
    // After discovery, the file is swapped for a link to a file outside the skill's directory.
    const outside = join(await temporaryDirectory(), 'secret.md');
    await writeFile(outside, 'PRIVATE-OUTSIDE-THE-SKILL');
    await rm(join(root, 'release-notes', 'SKILL.md'));
    await symlink(outside, join(root, 'release-notes', 'SKILL.md'));
    const handler = await handlerOver(() => standing);

    const response = await rpc(
      handler,
      'bureau.skills.get',
      { name: 'release-notes' },
      'agents-reader-key',
    );

    expect(JSON.stringify(response)).not.toContain('PRIVATE-OUTSIDE-THE-SKILL');
    expect(response.result).toMatchObject({ instructions: null });
    expect(response.result?.['unavailableReason']).not.toBeNull();
  });

  it('says a skill whose files changed since discovery changed, and serves none of them', async () => {
    const { root, source } = await oneSkill();
    const standing = await standingOf(source);
    await writeFile(
      join(root, 'release-notes', 'SKILL.md'),
      releaseNotes.replace('Group', 'NEW-TEXT Group'),
    );
    const handler = await handlerOver(() => standing);

    const response = await rpc(
      handler,
      'bureau.skills.get',
      { name: 'release-notes' },
      'agents-reader-key',
    );

    expect(response.result).toEqual({
      name: 'release-notes',
      instructions: null,
      unavailableReason: 'changed',
    });
    expect(JSON.stringify(response)).not.toContain('NEW-TEXT');
  });

  it('cuts a long SKILL.md at the bound, on a character, and still says its whole size', async () => {
    // A multi-byte character straddles the bound, so a cut by bytes would split it.
    const body = `${'é'.repeat(MAXIMUM_SKILL_INSTRUCTIONS_BYTES)}\n`;
    const text = releaseNotes + body;
    const { source } = await oneSkill(text);
    const standing = await standingOf(source);
    const handler = await handlerOver(() => standing);

    const response = await rpc(
      handler,
      'bureau.skills.get',
      { name: 'release-notes' },
      'agents-reader-key',
    );
    const instructions = response.result?.['instructions'] as {
      text: string;
      size: number;
      truncated: boolean;
    };

    expect(instructions.truncated).toBe(true);
    expect(instructions.size).toBe(new TextEncoder().encode(text).byteLength);
    expect(new TextEncoder().encode(instructions.text).byteLength).toBeLessThanOrEqual(
      MAXIMUM_SKILL_INSTRUCTIONS_BYTES,
    );
    expect(instructions.text).not.toContain('�');
    expect(text.startsWith(instructions.text)).toBe(true);
  });
});
