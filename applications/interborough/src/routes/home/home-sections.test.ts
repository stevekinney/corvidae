/**
 * Home draws its parts as Cinder's `Section` (COR-2329): a title and its link over the rows, with no
 * box, tinted header band or rule of the page's own, so space alone separates one section from the
 * next. The words and rows of each section are the board's (`home.test.ts`); these only keep the
 * boxes from coming back.
 */
import { cleanup, render, within } from '@testing-library/svelte';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from 'bun:test';
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';

import HomeHarness from './home-test-harness.test-harness.svelte';
import {
  HOME_NOW,
  installHome,
  sampleHomeWorld,
  type HomeWorld,
  type InstalledHome,
} from './home-test-support.test-support.ts';

let installed: InstalledHome | undefined;

// The zone in effect now is the one to give back; `bun test` runs in UTC without naming it in `TZ`.
const previousZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

beforeAll(() => {
  process.env['TZ'] = 'America/Chicago';
});

afterAll(() => {
  // The zone is the process's: another file in this worker reads its own.
  process.env['TZ'] = previousZone;
});

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  setSystemTime(new Date(HOME_NOW));
});

afterEach(() => {
  cleanup();
  installed?.restore();
  installed = undefined;
  setSystemTime();
});

/** Opens Home and waits until it is drawn. */
async function open(world: HomeWorld = sampleHomeWorld()) {
  installed = installHome(world);
  const rendered = render(HomeHarness, { props: { client: installed.client } } as never);
  await rendered.findByTestId('home-date');
  return rendered;
}

/** The section Home titles `title`. */
function cardOf(container: HTMLElement, title: string): HTMLElement {
  const card = container.querySelector<HTMLElement>(`[data-home-card="${title}"]`);
  if (card === null) throw new Error(`no ${title} section`);
  return card;
}

describe('Home’s sections', () => {
  test('are Cinder sections, each titled by a level-two heading, and the page draws no card', async () => {
    const { container } = await open();
    // The rows are in once the list is named.
    await within(cardOf(container, 'Recent chats')).findByRole('list', { name: 'Recent chats' });

    // The Needs you list is titled by the Spotlight above it, so it is the one block with no
    // heading of its own (COR-2329).
    const needsYou = cardOf(container, 'Needs you');
    expect(needsYou.querySelector('h2')).toBeNull();
    const sections = [
      ...container.querySelectorAll<HTMLElement>(
        '[data-home-card]:not([data-home-card="Needs you"])',
      ),
    ];
    expect(sections.map((section) => section.getAttribute('data-home-card'))).toEqual(
      expect.arrayContaining(['Needs attention', 'Start a chat', 'Recent chats']),
    );
    for (const section of sections) {
      const title = section.getAttribute('data-home-card');
      expect(section.tagName, `${String(title)} is a section`).toBe('SECTION');
      // A section that holds nothing is its empty state alone, named by its region (owner
      // report, 2026-11-19): the state's title is its one heading.
      if (section.querySelector('.cinder-empty-state') !== null) {
        expect(section.getAttribute('aria-label')).toBe(title);
        expect(section.querySelector('h2')?.classList.contains('cinder-empty-state-title')).toBe(
          true,
        );
        continue;
      }
      expect(section.classList.contains('cinder-section')).toBe(true);
      const heading = section.querySelector('h2');
      expect(heading?.classList.contains('cinder-section__title')).toBe(true);
      expect(heading?.textContent?.trim()).toBe(title ?? undefined);
    }
    const page = container.querySelector('[data-page="home"]');
    expect(page).not.toBeNull();
    expect(page?.querySelector('.cinder-card')).toBeNull();
  });

  // Owner, 2026-11-19: no card says nothing; nothing needing the person is one quiet line.
  test('says nothing needs you as one quiet line, in no section and no box, and draws no empty Needs attention', async () => {
    const base = sampleHomeWorld();
    const { container, findByTestId } = await open(
      sampleHomeWorld({
        world: { ...base.world, reviews: [] },
        attention: [],
        providerConnected: true,
      }),
    );
    const line = await findByTestId('home-nothing-needs-you');
    expect(line.closest('.cinder-card')).toBeNull();
    expect(line.closest('[data-home-card]')).toBeNull();
    await within(cardOf(container, 'Recent chats')).findByRole('list', { name: 'Recent chats' });
    expect(container.querySelector('[data-home-card="Needs attention"]')).toBeNull();
  });

  // Owner, 2026-11-19: the left column and Start a chat ended at different heights, with a dead
  // band before Recent chats, and the gaps between sections were two values.
  test('puts Recent chats under Start a chat in the narrow column, and spaces every section by one value', async () => {
    const { container } = await open();
    await within(cardOf(container, 'Recent chats')).findByRole('list', { name: 'Recent chats' });
    const aside = container.querySelector('.ib-home__aside');
    expect(aside?.contains(cardOf(container, 'Start a chat'))).toBe(true);
    expect(aside?.contains(cardOf(container, 'Recent chats'))).toBe(true);
    // Only the activity bands, the last region (COR-2227), sit under the two columns.
    const columns = container.querySelector('.ib-home__columns');
    expect(columns?.nextElementSibling?.getAttribute('data-testid')).toBe('home-activity');
    const layout = readFileSync(new URL('./home-layout.svelte', import.meta.url), 'utf8');
    const gaps = new Set(
      [...layout.matchAll(/^\s+(?:column-|row-)?gap: ([^;]+);/gm)].map((match) => match[1]),
    );
    expect([...gaps]).toEqual(['var(--ib-home-gap)']);
    expect(layout).toContain('--ib-home-gap: var(--cinder-space-8);');
  });
});

describe('Home holds no middle dot (COR-2388)', () => {
  test('no rendered text on Home contains U+00B7', async () => {
    const { container } = await open();
    expect(container.textContent?.length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain(String.fromCodePoint(0xb7));
  });
});
