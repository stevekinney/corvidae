import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const componentsRoot = join(import.meta.dir, 'components');

/**
 * A Cinder component's barrel, in core or in the package the split moved it into (P-COR-101): the
 * one `components/<package>/src/components/<name>/index.ts` that exists.
 */
function cinderComponentIndex(name: string): string {
  const workspaces = join(import.meta.dir, '../../..');
  const [found] = new Bun.Glob(`*/src/components/${name}/index.ts`).scanSync({ cwd: workspaces });
  if (found === undefined) throw new Error(`No Cinder package holds ${name}/index.ts.`);
  return join(workspaces, found);
}

describe('Chat package style contracts', () => {
  for (const [component, dependency, stylesheet] of [
    ['chat-composer-popover', 'CommandMenu', 'command-menu'],
    ['chat/export/conversation-export-actions', 'Dropdown', 'dropdown'],
  ]) {
    test(`${component} receives Cinder styles through its public component import`, async () => {
      if (!component || !dependency || !stylesheet)
        throw new Error('Missing style contract fixture');
      const source = await Bun.file(
        join(
          componentsRoot,
          component.includes('/') ? `${component}.svelte` : `${component}/${component}.svelte`,
        ),
      ).text();
      expect(source).toMatch(
        new RegExp(
          `import\\s*\\{[^}]*\\b${dependency}\\b[^}]*\\}\\s*from\\s*['"]@lostgradient/cinder['"]`,
        ),
      );
      const dependencyEntry = await Bun.file(cinderComponentIndex(stylesheet)).text();
      expect(dependencyEntry).toContain(`import './${stylesheet}.css'`);
    });
  }

  test('Chat status surfaces do not mix solid status tokens into soft surfaces', async () => {
    const auditedFiles = [
      join(componentsRoot, 'chat', 'input', 'chat-input.svelte'),
      join(componentsRoot, 'chat', 'message', 'chat-message.svelte'),
      join(componentsRoot, 'chat', 'message', 'tool-call-timeline.svelte'),
    ];
    const forbiddenStatusMixPattern =
      /color-mix\((?:(?!;).|\r|\n)*?var\(\s*--cinder-(info|success|warning|danger)\s*(?:[,)\s])/m;
    const failures: string[] = [];
    for (const file of auditedFiles) {
      if (forbiddenStatusMixPattern.test(await Bun.file(file).text())) failures.push(file);
    }
    expect(failures).toEqual([]);
  });
});
