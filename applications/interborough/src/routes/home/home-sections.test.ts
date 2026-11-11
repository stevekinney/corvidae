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

describe('Home’s sections', () => {
  test('are Cinder sections, each titled by a level-two heading, and the page draws no card', async () => {
    const { container } = await open();
    const recent = container.querySelector<HTMLElement>('[data-home-card="Recent chats"]');
    expect(recent).not.toBeNull();
    // The rows are in once the list is named.
    await within(recent as HTMLElement).findByRole('list', { name: 'Recent chats' });

    const sections = [...container.querySelectorAll<HTMLElement>('[data-home-card]')];
    expect(sections.map((section) => section.getAttribute('data-home-card'))).toEqual(
      expect.arrayContaining(['Needs you', 'Needs attention', 'Start a chat', 'Recent chats']),
    );
    for (const section of sections) {
      const title = section.getAttribute('data-home-card');
      expect(section.tagName, `${String(title)} is a section`).toBe('SECTION');
      expect(section.classList.contains('cinder-section')).toBe(true);
      const heading = section.querySelector('h2');
      expect(heading?.classList.contains('cinder-section__title')).toBe(true);
      expect(heading?.textContent?.trim()).toBe(title);
    }
    const page = container.querySelector('[data-page="home"]');
    expect(page).not.toBeNull();
    expect(page?.querySelector('.cinder-card')).toBeNull();
  });

  test('says nothing needs attention as one line with no box around it', async () => {
    const base = sampleHomeWorld();
    const { findByTestId } = await open(
      sampleHomeWorld({
        world: { ...base.world, reviews: [] },
        attention: [],
        providerConnected: true,
      }),
    );
    const line = await findByTestId('attention-clear');
    expect(line.closest('.cinder-card')).toBeNull();
    expect(line.closest('[data-home-card]')).toBeNull();
  });
});
