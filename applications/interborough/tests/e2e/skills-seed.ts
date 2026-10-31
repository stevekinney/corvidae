/**
 * Writes the executable skills the end-to-end host starts with (`skills-support.ts` names them):
 * the skill directories under the host's home, and the `skills` key of its configuration.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { E2E_LONG_SKILL_WORD, E2E_SKILL_SOURCES, E2E_SKILLS } from './skills-support.ts';

async function writeSkill(
  root: string,
  name: string,
  description: string,
  allowedTools?: string,
): Promise<void> {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(
    join(root, name, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      ...(allowedTools === undefined ? [] : [`allowed-tools: ${allowedTools}`]),
      '---',
      '',
      'Body.',
      '',
    ].join('\n'),
  );
}

/**
 * Writes the skill directories under `home` and adds the `skills` key to the configuration the
 * home already holds, leaving every other key as it was.
 */
export async function seedSkills(home: string): Promise<void> {
  const trusted = join(home, 'skills-home');
  const untrusted = join(home, 'skills-workspace');
  await writeSkill(trusted, E2E_SKILLS.summarize.name, 'Summarizes a document in a paragraph.');
  await writeSkill(
    trusted,
    E2E_SKILLS.long.name,
    `A skill description that keeps going well past one line. ${E2E_LONG_SKILL_WORD}`,
    'read_file grep glob list_directory search_files',
  );
  await writeSkill(untrusted, E2E_SKILLS.deploy.name, 'Ships a build to production.', 'run_shell');
  const path = join(home, 'configuration.json');
  const configuration = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeFile(
    path,
    JSON.stringify({
      ...configuration,
      skills: {
        sources: [
          { id: E2E_SKILL_SOURCES.trusted, kind: 'user', path: trusted },
          { id: E2E_SKILL_SOURCES.untrusted, kind: 'project', path: untrusted },
        ],
        trusted: [E2E_SKILL_SOURCES.trusted],
      },
    }),
  );
}
