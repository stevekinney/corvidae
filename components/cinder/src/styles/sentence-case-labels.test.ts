/**
 * COR-1821: section labels in Cinder components are sentence case, never uppercase and letter
 * spaced. A group heading, a field-group title or a "Conditions" label reads as text, not as a
 * shout. No Cinder stylesheet sets `text-transform: uppercase` on a section label.
 *
 * The scan cannot tell a section label from other text by looking at a declaration, so it works
 * from a short allowlist of selectors that are not section labels. An entry carries a reason, must
 * still match a rule that sets `text-transform: uppercase` (a stale entry fails), and the list can
 * only shrink: adding to it is a reviewed edit.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';
import { parse } from 'postcss';

const sourceDirectory = fileURLToPath(new URL('..', import.meta.url));

type Allowed = { file: string; selector: string; reason: string };

const allowlist: Allowed[] = [
  {
    file: 'components/avatar/avatar.css',
    selector: '.cinder-avatar__initials',
    reason: 'Initials are letters drawn inside a circle, not a section label.',
  },
  {
    file: 'components/pricing-card/pricing-card.css',
    selector: '.cinder-pricing-card__selected-flag',
    reason: 'A filled status chip that says the plan is selected, not a section label.',
  },
  {
    file: 'components/preview-panel/preview-panel.css',
    selector: '.cinder-preview-panel__status',
    reason: 'A one-word status readout beside the title, not a section label.',
  },
  {
    file: 'components/code-block/code-block.css',
    selector: '.cinder-code-block__language',
    reason: 'A language tag (TS, JSON) shown on a code block; COR-1823 reworks this file.',
  },
  {
    file: 'components/payload-inspector/payload-inspector.css',
    selector: '.cinder-payload-inspector__label',
    reason: 'COR-1823 replaces the payload inspector; drop this entry when that change merges.',
  },
];

function cssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

/** Every `file | selector` whose rule sets `text-transform: uppercase`. */
function uppercaseRules(): string[] {
  const found: string[] = [];
  for (const path of cssFiles(sourceDirectory)) {
    const file = relative(sourceDirectory, path);
    parse(readFileSync(path, 'utf8')).walkRules((rule) => {
      rule.walkDecls('text-transform', (declaration) => {
        if (declaration.value.trim() === 'uppercase') {
          for (const selector of rule.selectors) found.push(`${file} | ${selector.trim()}`);
        }
      });
    });
  }
  return found;
}

describe('section labels are sentence case', () => {
  test('no Cinder component sets text-transform: uppercase on a section label', () => {
    const allowed = new Set(allowlist.map((entry) => `${entry.file} | ${entry.selector}`));
    const offenders = uppercaseRules().filter((rule) => !allowed.has(rule));
    expect(offenders).toEqual([]);
  });

  test('every allowlist entry still matches an uppercase rule, so the list can only shrink', () => {
    const found = new Set(uppercaseRules());
    const stale = allowlist
      .map((entry) => `${entry.file} | ${entry.selector}`)
      .filter((key) => !found.has(key));
    expect(stale).toEqual([]);
  });

  test('every allowlist entry gives a reason', () => {
    for (const entry of allowlist) expect(entry.reason.length).toBeGreaterThanOrEqual(20);
  });

  test('no section label is letter-spaced for capitals', () => {
    const labelSelectors = [
      '.cinder-section-heading__label',
      '.cinder-command-group__label',
      '.cinder-keyboard-shortcuts__group-label',
      '.cinder-jse-section__title',
      '.cinder-schedule-builder__section-label',
      '.cinder-invocation-rule-builder__section-heading',
      '.cinder-timeline__group-header',
      '.cinder-approval-card__details-label',
      '.cinder-pricing-card__name',
    ];
    const spaced: string[] = [];
    for (const path of cssFiles(sourceDirectory)) {
      parse(readFileSync(path, 'utf8')).walkRules((rule) => {
        if (!rule.selectors.some((selector) => labelSelectors.includes(selector.trim()))) return;
        rule.walkDecls('letter-spacing', (declaration) => {
          if (declaration.value.trim() !== '0') {
            spaced.push(`${relative(sourceDirectory, path)} | ${rule.selector}`);
          }
        });
      });
    }
    expect(spaced).toEqual([]);
  });
});
