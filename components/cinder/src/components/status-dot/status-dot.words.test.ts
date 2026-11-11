/// <reference lib="dom" />
/**
 * COR-2010 (B02, rows 07t to 07x, 09u to 10d and the pages that follow them): status-dot owns the
 * word-to-tone table, so a page passes a word and never picks its own tone.
 */
import { describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: StatusDot } = await import('./status-dot.svelte');
const { statusDotWordTones, statusForStatusDotWord } = await import('./status-dot.words.ts');

const statusCss = await Bun.file(new URL('./status-dot.css', import.meta.url)).text();

/** The agreed design's "Status words" table, word by word. */
const expectedTones: ReadonlyArray<readonly [string, string]> = [
  ['Waiting on you', 'warning'],
  ['Running', 'info'],
  ['Running, checking the result', 'info'],
  ['Waiting', 'pending'],
  ['Scheduled', 'pending'],
  ['Done', 'success'],
  ['Done, refund not issued', 'neutral'],
  ['Check not met', 'neutral'],
  ['Approved', 'success'],
  ['Denied', 'neutral'],
  ['Sent back', 'neutral'],
  ['Expired', 'neutral'],
  ['Failed', 'danger'],
  ['Failed for good', 'danger'],
  ['Gave up', 'danger'],
  ["Can't load", 'danger'],
  ["Can't find workflow", 'danger'],
  ['Not loaded', 'danger'],
  ['Canceled', 'neutral'],
  ['Stopped', 'neutral'],
  ['Paused', 'neutral'],
  ['Off', 'neutral'],
  ['Active', 'success'],
  ['Missed runs, 4', 'warning'],
  ['Available', 'success'],
  ['Unavailable', 'neutral'],
  ['Needs setup', 'neutral'],
  ['Needs attention', 'warning'],
  ['Needs sign-in', 'warning'],
  ['Ended', 'neutral'],
  ['Delivered', 'success'],
  ['Retrying', 'neutral'],
  ['Connected', 'success'],
  ['Draining', 'neutral'],
  ['Disconnected', 'warning'],
  ['Live', 'info'],
  ['Live, last event 1 s ago', 'info'],
  ['Reconnecting…', 'pending'],
];

function rootOf(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>('.cinder-status-dot');
  if (!root) throw new Error('status dot root not rendered');
  return root;
}

describe('statusForStatusDotWord', () => {
  test.each(expectedTones)('%s is %s', (word, tone) => {
    expect(statusForStatusDotWord(word)).toBe(tone as never);
  });

  test('a typographic apostrophe finds the straight one', () => {
    expect(statusForStatusDotWord('Can’t load')).toBe('danger');
  });

  test('a qualifier rides along on its base word', () => {
    expect(statusForStatusDotWord('Missed runs, 12')).toBe('warning');
    expect(statusForStatusDotWord('Running, checking the result')).toBe('info');
  });

  test('a qualifier on Done always means the task was not achieved, so the dot is never green', () => {
    expect(statusForStatusDotWord('Done, refund not issued')).toBe('neutral');
    expect(statusForStatusDotWord('Done, no tickets found')).toBe('neutral');
    expect(statusForStatusDotWord('Done, approval denied')).toBe('neutral');
    expect(statusForStatusDotWord('Done')).toBe('success');
  });

  test('a word the table does not know is undefined', () => {
    expect(statusForStatusDotWord('Needs you')).toBeUndefined();
    expect(statusForStatusDotWord('constructor')).toBeUndefined();
    expect(statusForStatusDotWord('toString, x')).toBeUndefined();
  });

  test('red is reserved for six words and amber for five', () => {
    const entries = Object.entries(statusDotWordTones);
    expect(entries.filter(([, tone]) => tone === 'danger').map(([word]) => word)).toEqual([
      'Failed',
      'Failed for good',
      'Gave up',
      "Can't load",
      "Can't find workflow",
      'Not loaded',
    ]);
    expect(entries.filter(([, tone]) => tone === 'warning').map(([word]) => word)).toEqual([
      'Waiting on you',
      'Missed runs',
      'Needs attention',
      'Needs sign-in',
      'Disconnected',
    ]);
  });

  test('"Needs you" is never a row word, only a section, a count and a badge', () => {
    expect(Object.keys(statusDotWordTones)).not.toContain('Needs you');
  });
});

describe('StatusDot word prop', () => {
  test.each(expectedTones)('word "%s" sets the tone %s and shows the word', (word, tone) => {
    const { container } = render(StatusDot, { props: { word: word as never } });
    const root = rootOf(container);
    expect(root.getAttribute('data-cinder-status')).toBe(tone);
    expect(container.querySelector('.cinder-status-dot__label')?.textContent).toBe(word);
    expect(root.getAttribute('aria-label')).toBe(word);
  });

  test('a label gives the text while the word keeps the tone, as the dropped-stream line needs', () => {
    const { container } = render(StatusDot, {
      props: { word: 'Reconnecting…', label: 'Reconnecting… last event 40 s ago' },
    });
    const root = rootOf(container);
    expect(root.getAttribute('data-cinder-status')).toBe('pending');
    expect(container.querySelector('.cinder-status-dot__label')?.textContent).toBe(
      'Reconnecting… last event 40 s ago',
    );
  });

  test('an unknown word renders a neutral dot with that word', () => {
    const { container } = render(StatusDot, { props: { word: 'Archived' as never } });
    expect(rootOf(container).getAttribute('data-cinder-status')).toBe('neutral');
    expect(container.querySelector('.cinder-status-dot__label')?.textContent).toBe('Archived');
  });

  test('an explicit status wins over the word tone', () => {
    const { container } = render(StatusDot, { props: { word: 'Failed', status: 'neutral' } });
    expect(rootOf(container).getAttribute('data-cinder-status')).toBe('neutral');
  });

  test('an explicit label wins over the word text but the tone still follows the word', () => {
    const { container } = render(StatusDot, { props: { word: 'Failed', label: 'Build failed' } });
    expect(rootOf(container).getAttribute('data-cinder-status')).toBe('danger');
    expect(container.querySelector('.cinder-status-dot__label')?.textContent).toBe('Build failed');
  });

  test('labelVisible false keeps the word as the accessible name', () => {
    const { container } = render(StatusDot, { props: { word: 'Waiting', labelVisible: false } });
    expect(container.querySelector('.cinder-status-dot__label')).toBeNull();
    expect(rootOf(container).getAttribute('aria-label')).toBe('Waiting');
  });

  test('a blank word is ignored', () => {
    const { container } = render(StatusDot, { props: { word: '  ' as never, status: 'online' } });
    expect(rootOf(container).getAttribute('data-cinder-status')).toBe('online');
    expect(container.querySelector('.cinder-status-dot__label')?.textContent).toBe('Online');
  });
});

describe('info status and the hollow pending ring', () => {
  test('info renders a solid neutral dot with a default word', () => {
    const { container } = render(StatusDot, { props: { status: 'info' } });
    expect(rootOf(container).getAttribute('data-cinder-status')).toBe('info');
    expect(container.querySelector('.cinder-status-dot__label')?.textContent).toBe('Info');
    // The info dot shares the neutral rule's control-border colour, never the accent or the info
    // hue (COR-2314).
    expect(statusCss).toMatch(
      /data-cinder-status='info'\](?:,[^{]*)? \{\s*--cinder-status-dot-color: var\(--cinder-border-contrast\);/,
    );
    expect(statusCss).not.toContain('--cinder-status-info-solid');
  });

  test('pending is a 1.5px ring in the contrast border over a transparent fill', () => {
    expect(statusCss).toMatch(
      /data-cinder-status='pending'\] \{\s*--cinder-status-dot-color: var\(--cinder-border-contrast\);/,
    );
    const ring = statusCss.match(
      /data-cinder-status='pending'\] \.cinder-status-dot__indicator \{([^}]*)\}/,
    );
    expect(ring?.[1]).toContain('border: 0.09375rem solid var(--cinder-status-dot-color)');
    expect(ring?.[1]).toContain('background: transparent');
    expect(ring?.[1]).toContain('box-sizing: border-box');
  });

  test('pending no longer paints the info-blue fill', () => {
    const pending = statusCss.match(/data-cinder-status='pending'\] \{([^}]*)\}/);
    expect(pending?.[1]).not.toContain('info');
  });
});

describe('status word colour', () => {
  test.each([
    ['warning', '--cinder-status-warning-text'],
    ['danger', '--cinder-status-danger-text'],
  ])('a %s word is coloured with %s', (status, token) => {
    const block = statusCss.match(new RegExp(`data-cinder-status='${status}'\\] \\{([^}]*)\\}`));
    expect(block?.[1]).toContain(`--_cinder-status-dot-word-color: var(${token})`);
  });

  test.each(['online', 'offline', 'pending', 'neutral', 'info', 'success', 'accent'])(
    'a %s word stays muted',
    (status) => {
      const block = statusCss.match(
        new RegExp(`data-cinder-status='${status}'\\](?:,[^{]*)? \\{([^}]*)\\}`),
      );
      expect(block?.[1]).toBeDefined();
      expect(block?.[1]).not.toContain('--_cinder-status-dot-word-color');
    },
  );

  test('the root colour is the word colour, defaulting to muted text', () => {
    expect(statusCss).toContain(
      'color: var(--_cinder-status-dot-word-color, var(--cinder-text-muted));',
    );
  });
});

describe('forced colors', () => {
  const forced = statusCss.slice(statusCss.indexOf('@media (forced-colors: active)'));

  test('the solid dot uses Highlight', () => {
    expect(forced).toMatch(/\.cinder-status-dot__indicator \{[^}]*background: Highlight;/);
    expect(forced).toContain('forced-color-adjust: none');
  });

  test('the hollow pending ring uses CanvasText over a transparent fill', () => {
    const ring = forced.match(
      /data-cinder-status='pending'\] \.cinder-status-dot__indicator \{([^}]*)\}/,
    );
    expect(ring?.[1]).toContain('border-color: CanvasText');
    expect(ring?.[1]).toContain('background: transparent');
  });
});
