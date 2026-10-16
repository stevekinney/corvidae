import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  analyzeAll,
  analyzeComponent,
  getProjectCreationCount,
  getProjectProgramFileNames,
  resetProject,
} from './analyze.ts';
import {
  CHAT_COMPONENT_SOURCE,
  CINDER_COMPONENT_SOURCE,
  EDITOR_COMPONENT_SOURCE,
} from './component-sources.ts';

/*
 * Slow lane (COR-1499). Each case analyzes the whole Cinder inventory, or builds ts-morph programs
 * for three packages, which is tens of seconds of real work on a busy host. They carry an explicit
 * per-test deadline already; running them in `test:slow`, serially after the fast phase, keeps
 * their contention out of the fast lane without changing any assertion.
 */
const COMPONENTS_DIR = CINDER_COMPONENT_SOURCE.componentsRoot;

function componentPath(name: string): string {
  // Migrated components live in `<name>/<name>.svelte`; legacy flat components
  // live in `<name>.svelte`. Prefer the directory shape so the analyzer's
  // component-side fallback to `<name>.types.ts` (next to the .svelte) finds
  // the types file.
  const directoryPath = join(COMPONENTS_DIR, name, `${name}.svelte`);
  if (existsSync(directoryPath)) return directoryPath;
  return join(COMPONENTS_DIR, `${name}.svelte`);
}

describe('shared ts-morph project over the full inventory', () => {
  it('reuses a single Project across one analyzeAll run', async () => {
    resetProject();
    const before = getProjectCreationCount();
    await analyzeAll(COMPONENTS_DIR);
    const after = getProjectCreationCount();
    // ~100 concurrent analyzeComponent calls must share a single Project, so
    // exactly one new instance is created for the whole run.
    expect(after - before).toBe(1);
  }, 20_000);

  it('creates exactly one new Project after a reset', async () => {
    await analyzeAll(COMPONENTS_DIR);
    resetProject();
    const before = getProjectCreationCount();
    await analyzeAll(COMPONENTS_DIR);
    expect(getProjectCreationCount() - before).toBe(1);
  }, 20_000);

  it("keeps each package's analyses in its own Project so one package's dependency graph never taxes another's", async () => {
    resetProject();
    const before = getProjectCreationCount();
    await analyzeComponent(componentPath('card'));
    // Chat's types reach Cinder's barrel, and through it every `@lucide/svelte`
    // icon declaration (thousands of files). ts-morph keeps each resolved
    // dependency as a root of every later program in the same Project, so a
    // Project shared across packages made every Cinder analysis after the first
    // Chat one rebuild a program thousands of files larger.
    await analyzeComponent(join(CHAT_COMPONENT_SOURCE.componentsRoot, 'chat', 'chat.svelte'), {
      importPath: CHAT_COMPONENT_SOURCE.packageName,
    });
    await analyzeComponent(componentPath('alert'));

    const isLucideDeclaration = (path: string): boolean => path.includes('/@lucide/svelte/');
    // The premise: Chat's analysis really does pull the icon graph in.
    expect(
      getProjectProgramFileNames(CHAT_COMPONENT_SOURCE.packageRoot).some(isLucideDeclaration),
    ).toBe(true);
    // The guarantee: Cinder's Project never inherits it.
    expect(
      getProjectProgramFileNames(CINDER_COMPONENT_SOURCE.packageRoot).some(isLucideDeclaration),
    ).toBe(false);
    expect(getProjectCreationCount() - before).toBe(2);
  }, 20_000);

  // Each package's tsconfig lists `types: ["bun"]` for its tests. Left in force for the analyzer,
  // that one entry pulls Bun's declarations and, through them, `@types/node` and `undici-types`
  // (about 235 files) into every program, and a program is rebuilt for each of the 211 components:
  // resolving those type-reference directives was two thirds of a cold manifest build. A component's
  // props are typed against the browser, so the analyzer's projects load no ambient test-runner types.
  it("builds each package's program without the test runner's ambient type declarations", async () => {
    resetProject();
    await analyzeComponent(componentPath('card'));
    await analyzeComponent(join(CHAT_COMPONENT_SOURCE.componentsRoot, 'chat', 'chat.svelte'), {
      importPath: CHAT_COMPONENT_SOURCE.packageName,
    });
    await analyzeComponent(
      join(EDITOR_COMPONENT_SOURCE.componentsRoot, 'markdown-editor', 'markdown-editor.svelte'),
      { importPath: EDITOR_COMPONENT_SOURCE.packageName },
    );

    const isAmbientTestRunnerDeclaration = (path: string): boolean =>
      /\/(?:bun-types|undici-types)\/|\/@types\/(?:bun|node)\//.test(path.replaceAll('\\', '/'));
    for (const source of [
      CINDER_COMPONENT_SOURCE,
      CHAT_COMPONENT_SOURCE,
      EDITOR_COMPONENT_SOURCE,
    ]) {
      const programFiles = getProjectProgramFileNames(source.packageRoot);
      // The premise: the tsconfig still applies (its `lib` brings the DOM declarations in), so
      // the empty list below is a real program with the ambient types removed, not a vacuous one.
      expect(programFiles.some((path) => path.endsWith('/lib.dom.d.ts'))).toBe(true);
      expect(programFiles.filter(isAmbientTestRunnerDeclaration)).toEqual([]);
    }
  }, 20_000);
});
