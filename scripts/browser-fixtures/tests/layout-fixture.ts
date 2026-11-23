import type { ComponentEntry } from '@lostgradient/testing';
import { loadManifest } from '@lostgradient/testing';
import type { Locator } from '@playwright/test';

export function fixtureEntry(slug: string): ComponentEntry {
  const entry = loadManifest().find((candidate) => candidate.slug === slug);
  if (entry === undefined) throw new Error(`Missing fixture entry for ${slug}`);
  return entry;
}

export function fixtureRoute(slug: string): string {
  const entry = fixtureEntry(slug);
  const fixture = entry.fixtures?.find((candidate) => candidate.name === 'assertion');
  if (fixture === undefined) throw new Error(`Missing assertion fixture for ${slug}`);
  const query = new URLSearchParams({
    snapshot: '1',
    fixture: 'assertion',
    fixtureContentHash: fixture.fixtureContentHash,
  });
  return `${entry.route}?${query.toString()}`;
}

/** Set the space available to a fixture when measuring a particular layout threshold. */
export async function setFixtureWidth(wrapper: Locator, inlineSize: string): Promise<void> {
  await wrapper.evaluate((element, size) => {
    if (!(element instanceof HTMLElement)) throw new Error('Expected an HTML fixture wrapper');
    element.style.inlineSize = size;
  }, inlineSize);
}
