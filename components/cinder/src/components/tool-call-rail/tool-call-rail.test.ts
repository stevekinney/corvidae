/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, fireEvent, cleanup, waitFor } = await import('@testing-library/svelte');
const { createRawSnippet, tick } = await import('svelte');
const { default: ToolCallRail } = await import('./tool-call-rail.svelte');

type Call = import('./tool-call-rail.types.ts').ToolCallRailCall;

const cssText = await Bun.file(new URL('./tool-call-rail.css', import.meta.url)).text();

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const done = (id: string, name = 'Lookup order', input = id): Call => ({
  id,
  name,
  input,
  result: 'ok',
  duration: '0.2s',
  status: 'done',
});

const turn = (count: number): Call[] =>
  Array.from({ length: count }, (_, index) =>
    done(`call-${index}`, 'Lookup order', `${4400 + index}`),
  );

const text = (element: Element | null): string =>
  (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
const rows = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-cinder-tool-call-row]'),
];
const summary = (container: HTMLElement): HTMLElement | null =>
  container.querySelector('.cinder-tool-call-rail__summary');

describe('ToolCallRail row count and summary', () => {
  test('one or two calls are plain rows: no summary, no connector flag, no fold', () => {
    for (const count of [1, 2]) {
      const { container, unmount } = render(ToolCallRail, { props: { calls: turn(count) } });
      expect(rows(container)).toHaveLength(count);
      expect(summary(container)).toBeNull();
      expect(container.querySelector('.cinder-tool-call-rail__group')).toBeNull();
      expect(container.querySelector('[data-cinder-plain]')).not.toBeNull();
      unmount();
    }
  });

  test('from three calls the summary reads Used N tools, with no counts or duration when none exist', () => {
    const { container } = render(ToolCallRail, { props: { calls: turn(3) } });
    expect(text(summary(container))).toBe('Used 3 tools');
    expect(rows(container)).toHaveLength(3);
    expect(container.querySelector('[data-cinder-plain]')).toBeNull();
  });

  test('seven calls show every row and eight fold the middle two', () => {
    const seven = render(ToolCallRail, { props: { calls: turn(7) } });
    expect(rows(seven.container)).toHaveLength(7);
    expect(seven.container.querySelector('.cinder-tool-call-rail__group')).toBeNull();
    cleanup();
    const eight = render(ToolCallRail, {
      props: { calls: turn(8), endLabel: 'Run finished · no reply' },
    });
    expect(rows(eight.container)).toHaveLength(6);
    expect(text(eight.container.querySelector('.cinder-tool-call-rail__more'))).toBe('Show 2 more');
    expect(text(summary(eight.container))).toBe('Used 8 tools');
    expect(text(eight.container.querySelector('.cinder-tool-call-rail__group-summary-long'))).toBe(
      '2 done: Lookup order ×2',
    );
    expect(text(eight.container.querySelector('.cinder-tool-call-rail__end'))).toBe(
      'Run finished · no reply',
    );
  });

  test('counts failed and waiting calls with their dots and the turn duration', () => {
    const calls: Call[] = [
      ...turn(27),
      { id: 'mail', name: 'Send email', status: 'failed', failure: 'No reply.' },
      done('a'),
      { id: 'refund', name: 'Issue refund', status: 'waiting' },
    ];
    const { container } = render(ToolCallRail, { props: { calls, duration: '18s' } });
    expect(text(summary(container))).toBe('Used 30 tools · 1 failed · 1 waiting on you · 18s');
    expect(
      container.querySelector('[data-cinder-count="failed"] .cinder-tool-call-rail__count-dot'),
    ).not.toBeNull();
    expect(container.querySelector('[data-cinder-count="waiting"]')).not.toBeNull();
  });

  test('a running turn says so far with a spinner and no counts', () => {
    const calls: Call[] = [
      ...turn(11),
      { id: 'now', name: 'Lookup order', input: '4508', duration: '1.2s', status: 'running' },
    ];
    const { container } = render(ToolCallRail, {
      props: { calls, running: true, duration: '18s' },
    });
    const line = container.querySelector('.cinder-tool-call-rail__summary');
    expect(line?.tagName).toBe('P');
    expect(text(line)).toContain('Used 12 tools so far…');
    expect(text(line)).not.toContain('18s');
    expect(line?.querySelector('.cinder-spinner')).not.toBeNull();
    // First 3, the folded 8, then the running call: there is no tail while the turn runs.
    expect(rows(container)).toHaveLength(4);
    expect(text(container.querySelector('.cinder-tool-call-rail__more'))).toBe('Show 8 more');
    expect(text(rows(container)[3] ?? null)).toContain('Running…');
    expect(text(rows(container)[3] ?? null)).toContain('1.2s');
  });
});

describe('ToolCallRail folding', () => {
  const long = (): Call[] => {
    const calls = turn(30);
    calls[27] = {
      id: 'mail',
      name: 'Send email',
      input: 'maya@example.com',
      result: 'SMTP timeout after 10s',
      duration: '10.0s',
      status: 'failed',
      failure: "Mail server didn't reply within 10s.",
    };
    calls[29] = {
      id: 'refund',
      name: 'Issue refund',
      input: '4480',
      status: 'waiting',
      nested: true,
    };
    return calls;
  };

  test('3 + 24 + 3: the failed and waiting calls stay among the last rows', () => {
    const { container } = render(ToolCallRail, { props: { calls: long() } });
    expect(rows(container)).toHaveLength(6);
    expect(text(container.querySelector('.cinder-tool-call-rail__more'))).toBe('Show 24 more');
    expect(text(container.querySelector('.cinder-tool-call-rail__group-summary-short'))).toBe(
      '24 done',
    );
  });

  test('a failure in the middle splits the fold into two groups that count what they hide', () => {
    const calls = turn(30);
    calls[13] = { id: 'mail', name: 'Send email', status: 'failed', failure: 'Down.' };
    const { container } = render(ToolCallRail, { props: { calls } });
    const buttons = [...container.querySelectorAll('.cinder-tool-call-rail__more')].map((button) =>
      text(button),
    );
    expect(buttons).toEqual(['Show 10 more', 'Show 13 more']);
    expect(rows(container).map((row) => row.dataset['cinderToolCallRow'])).toContain('mail');
  });

  test('Show N more opens the group in place and Show fewer folds it again', async () => {
    const { container } = render(ToolCallRail, { props: { calls: long() } });
    await fireEvent.click(
      requiredInstance(container.querySelector('.cinder-tool-call-rail__more'), HTMLElement),
    );
    expect(rows(container)).toHaveLength(30);
    expect(container.querySelector('.cinder-tool-call-rail__more')).toBeNull();
    expect(rows(container).map((row) => row.dataset['cinderToolCallRow'])[3]).toBe('call-3');
    expect(text(summary(container))).toContain('1 failed · 1 waiting on you');
    const fewer = requiredInstance(
      container.querySelector('.cinder-tool-call-rail__fewer button'),
      HTMLElement,
    );
    expect(text(fewer)).toBe('Show fewer');
    await fireEvent.click(fewer);
    expect(rows(container)).toHaveLength(6);
    expect(container.querySelector('.cinder-tool-call-rail__fewer')).toBeNull();
  });

  test('closing the summary leaves the failed and waiting calls and no fold', async () => {
    const { container } = render(ToolCallRail, { props: { calls: long() } });
    const toggle = requiredInstance(summary(container), HTMLElement);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(rows(container).map((row) => row.dataset['cinderToolCallRow'])).toEqual([
      'mail',
      'refund',
    ]);
    expect(container.querySelector('.cinder-tool-call-rail__group')).toBeNull();
    expect(container.querySelector('.cinder-tool-call-rail__failure')).not.toBeNull();
    expect(text(toggle)).toContain('Used 30 tools · 1 failed · 1 waiting on you');
  });

  test('denied calls never fold', () => {
    const calls = turn(12);
    calls[6] = { id: 'no', name: 'Issue refund', status: 'denied', result: 'Denied by you' };
    const { container } = render(ToolCallRail, { props: { calls } });
    expect(rows(container).map((row) => row.dataset['cinderToolCallRow'])).toContain('no');
  });
});

describe('ToolCallRail rows', () => {
  test('a row is one line: the name carries the identifier as a tooltip, then input, result and duration', () => {
    const { container } = render(ToolCallRail, {
      props: {
        calls: [
          {
            id: 'a',
            name: 'Lookup order',
            identifier: 'lookup-order',
            input: '4471',
            result: '$42.00, delivered Mon',
            duration: '0.2s',
            status: 'done',
          },
        ],
      },
    });
    const row = requiredInstance(rows(container)[0], HTMLElement);
    // The identifier is a Cinder tooltip anchored to the row, not a native title nobody can reach.
    expect(row.querySelector('.cinder-tool-call-rail__name')?.hasAttribute('title')).toBe(false);
    expect(text(row.querySelector('.cinder-tool-call-rail__input'))).toBe('4471');
    expect(text(row.querySelector('.cinder-tool-call-rail__result'))).toBe(
      '→ $42.00, delivered Mon',
    );
    expect(text(row.querySelector('.cinder-tool-call-rail__duration'))).toBe('0.2s');
    expect(row.tagName).toBe('DIV');
  });

  test('each status draws its own marker and words', () => {
    const calls: Call[] = [
      { id: 'run', name: 'A', input: '1', status: 'running', duration: '1.2s' },
      { id: 'wait', name: 'B', input: '2', status: 'waiting' },
      { id: 'deny', name: 'C', input: '3', status: 'denied', result: 'Denied by you' },
      { id: 'fail', name: 'D', input: '4', status: 'failed', result: 'Boom' },
      { id: 'ok', name: 'E', input: '5', status: 'approved', decision: 'Approved by you 10:33 AM' },
    ];
    const { container } = render(ToolCallRail, { props: { calls } });
    const byId = (id: string): HTMLElement =>
      requiredInstance(container.querySelector(`[data-cinder-tool-call-row="${id}"]`), HTMLElement);
    // Timeline draws the marker in the entry's own column, beside the row.
    const markerOf = (id: string): HTMLElement =>
      requiredInstance(byId(id).closest('li'), HTMLElement);
    expect(
      markerOf('run').querySelector('.cinder-timeline-item__marker .cinder-spinner'),
    ).not.toBeNull();
    expect(text(byId('run').querySelector('.cinder-tool-call-rail__result'))).toBe('Running…');
    expect(text(byId('wait').querySelector('.cinder-tool-call-rail__result'))).toBe(
      'Waiting on you',
    );
    expect(text(byId('deny').querySelector('.cinder-tool-call-rail__result'))).toBe(
      'Denied by you',
    );
    expect(markerOf('deny').querySelector('.lucide-ban')).not.toBeNull();
    expect(text(byId('fail').querySelector('.cinder-tool-call-rail__name'))).toBe('Failed: D');
    expect(text(byId('fail').querySelector('.cinder-tool-call-rail__result'))).toBe('→ Boom');
    expect(markerOf('ok').querySelector('[data-cinder-status="approved"]')).not.toBeNull();
    // A decision is the person's words, so it has no arrow.
    expect(text(byId('ok').querySelector('.cinder-tool-call-rail__result'))).toBe(
      'Approved by you 10:33 AM',
    );
  });

  test('a failed call has one danger line with the quiet links for the handlers given', async () => {
    const onSelect = mock((_id: string) => undefined);
    const onRetry = mock((_id: string) => undefined);
    const onCopyInput = mock((_id: string) => undefined);
    const calls: Call[] = [
      ...turn(2),
      { id: 'mail', name: 'Send email', status: 'failed', failure: "Mail server didn't reply." },
    ];
    const { container } = render(ToolCallRail, {
      props: { calls, onSelect, onRetry, onCopyInput },
    });
    const failure = requiredInstance(
      container.querySelector('.cinder-tool-call-rail__failure'),
      HTMLElement,
    );
    expect(text(failure)).toBe(
      "Mail server didn't reply. Details Ask the agent to retry Copy input",
    );
    const links = [...failure.querySelectorAll<HTMLElement>('button')];
    await fireEvent.click(requiredInstance(links[0], HTMLElement));
    await fireEvent.click(requiredInstance(links[1], HTMLElement));
    await fireEvent.click(requiredInstance(links[2], HTMLElement));
    expect(onSelect).toHaveBeenCalledWith('mail');
    expect(onRetry).toHaveBeenCalledWith('mail');
    expect(onCopyInput).toHaveBeenCalledWith('mail');
  });

  test('an approved call without a decision shows what came back after an arrow', () => {
    const { container } = render(ToolCallRail, {
      props: {
        calls: [
          { id: 'wf', name: 'Create workflow', status: 'approved', result: 'Morning briefing' },
        ],
      },
    });

    expect(text(container.querySelector('.cinder-tool-call-rail__result'))).toBe(
      '→ Morning briefing',
    );
  });

  test('the failed call stacks its links beneath the danger text', () => {
    expect(cssText).toMatch(
      /\.cinder-tool-call-rail__failure \{[^}]*flex-direction: column;[^}]*\}/,
    );
  });

  test('a row shows the identifier in a Cinder tooltip on hover and on focus', async () => {
    const { container } = render(ToolCallRail, {
      props: {
        calls: [
          { id: 'a', name: 'Lookup order', identifier: 'lookup-order', status: 'done' },
          { id: 'b', name: 'Check inventory', status: 'done' },
        ],
        onSelect: () => undefined,
      },
    });
    const [first, second] = rows(container).map((row) => requiredInstance(row, HTMLElement));
    // The row is described by its own tooltip, so the identifier reaches assistive technology too.
    const describedBy = (row: HTMLElement): string | null | undefined =>
      document.getElementById(row.getAttribute('aria-describedby') ?? '')?.textContent;

    await waitFor(() =>
      expect(describedBy(requiredInstance(first, HTMLElement))).toBe('lookup-order'),
    );
    await waitFor(() =>
      expect(describedBy(requiredInstance(second, HTMLElement))).toBe('Check inventory'),
    );

    const tooltip = (row: HTMLElement): HTMLElement | null =>
      document.getElementById(row.getAttribute('aria-describedby') ?? '');
    expect(tooltip(requiredInstance(first, HTMLElement))?.hasAttribute('data-cinder-visible')).toBe(
      false,
    );
    await fireEvent.focusIn(requiredInstance(first, HTMLElement));
    await waitFor(() =>
      expect(
        tooltip(requiredInstance(first, HTMLElement))?.hasAttribute('data-cinder-visible'),
      ).toBe(true),
    );
  });

  test('a row that cannot be chosen still takes focus so its tooltip is reachable', () => {
    const { container } = render(ToolCallRail, { props: { calls: turn(3) } });

    expect(rows(container).map((row) => row.getAttribute('tabindex'))).toEqual(['0', '0', '0']);
  });

  test('the retry and copy links only show when their handlers are set', () => {
    const calls: Call[] = [{ id: 'mail', name: 'Send email', status: 'failed', failure: 'Down.' }];
    const { container } = render(ToolCallRail, { props: { calls } });
    expect(container.querySelectorAll('.cinder-tool-call-rail__failure button')).toHaveLength(0);
  });

  test('rows are buttons only with onSelect, and the selected row is pressed', async () => {
    const onSelect = mock((_id: string) => undefined);
    const { container } = render(ToolCallRail, {
      props: { calls: turn(3), onSelect, selectedId: 'call-1' },
    });
    const buttons = rows(container);
    expect(buttons.map((row) => row.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON']);
    expect(buttons.map((row) => row.getAttribute('aria-pressed'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    expect(
      container.querySelector('li .cinder-tool-call-rail__item[data-cinder-selected]'),
    ).not.toBeNull();
    await fireEvent.click(requiredInstance(buttons[2], HTMLElement));
    expect(onSelect).toHaveBeenCalledWith('call-2');
  });

  test('focusCall moves focus to the row of that call', async () => {
    const { container, component } = render(ToolCallRail, {
      props: { calls: turn(3), onSelect: () => undefined },
    });
    (component as unknown as { focusCall: (id: string) => void }).focusCall('call-2');
    await tick();
    expect(document.activeElement).toBe(rows(container)[2] ?? null);
  });

  test('nested content draws under the rows that ask for it, whatever their status', () => {
    const children = createRawSnippet((call: () => Call) => ({
      render: () => `<div data-testid="nested">${call().id}</div>`,
    }));
    const calls: Call[] = [
      { ...done('plain'), nested: false },
      { ...done('approved-one'), nested: true },
      { id: 'waiting-one', name: 'Issue refund', status: 'waiting', nested: true },
    ];
    const { container } = render(ToolCallRail, { props: { calls, children } });
    const nested = [...container.querySelectorAll('[data-testid="nested"]')].map((item) =>
      text(item),
    );
    expect(nested).toEqual(['approved-one', 'waiting-one']);
    expect(container.querySelectorAll('.cinder-tool-call-rail__nested')).toHaveLength(2);
  });

  test("the footnote and the labels are the caller's words", () => {
    const { container } = render(ToolCallRail, {
      props: {
        calls: turn(8),
        footnote: 'Counts reflect this turn only.',
        labels: {
          used: (count: number) => `Utilisé ${count} outils`,
          showMore: (count: number) => `Afficher ${count} de plus`,
          folded: (count: number) => `${count} terminés`,
        },
      },
    });
    expect(text(container.querySelector('.cinder-tool-call-rail__footnote'))).toBe(
      'Counts reflect this turn only.',
    );
    expect(text(summary(container))).toBe('Utilisé 8 outils');
    expect(text(container.querySelector('.cinder-tool-call-rail__more'))).toBe(
      'Afficher 2 de plus',
    );
  });

  test('the rail is a labelled region around an ordered list', () => {
    const { container } = render(ToolCallRail, { props: { calls: turn(3), label: 'Turn tools' } });
    const region = requiredInstance(container.querySelector('section'), HTMLElement);
    expect(region.getAttribute('aria-label')).toBe('Turn tools');
    expect(container.querySelector('ol')?.id).toBe(
      summary(container)?.getAttribute('aria-controls') ?? 'none',
    );
  });
});

describe('ToolCallRail on Timeline', () => {
  test('the rows are entries of the rows variant, so Timeline draws the marker column', () => {
    const { container } = render(ToolCallRail, { props: { calls: turn(4) } });

    const list = requiredInstance(container.querySelector('ol'), HTMLOListElement);
    expect(list.classList.contains('cinder-timeline')).toBe(true);
    expect(list.getAttribute('data-cinder-variant')).toBe('rows');
    const items = [...list.querySelectorAll(':scope > li.cinder-timeline-item')];
    expect(items.length).toBe(4);
    for (const item of items) {
      expect(
        item.querySelector(':scope > .cinder-timeline-item__event > .cinder-timeline-item__marker'),
      ).not.toBeNull();
    }
    // Four calls on a rail: the connector joins every marker and ends at the last.
    expect(items.map((item) => item.getAttribute('data-cinder-connector-after'))).toEqual([
      'visible',
      'visible',
      'visible',
      'hidden',
    ]);
  });

  test('a folded group is one Timeline entry with its own marker', () => {
    const { container } = render(ToolCallRail, { props: { calls: turn(12) } });

    const group = requiredInstance(
      container.querySelector('.cinder-tool-call-rail__group'),
      HTMLElement,
    );
    const item = requiredInstance(group.closest('li.cinder-timeline-item'), HTMLElement);
    expect(item.querySelector('.cinder-timeline-item__marker [data-cinder-faint]')).not.toBeNull();
  });

  test('the rail draws no marker column or connector of its own', () => {
    expect(cssText).toContain("@import '../timeline/timeline.css';");
    expect(cssText).not.toContain('.cinder-tool-call-rail__list::before');
    expect(cssText).not.toMatch(/\.cinder-tool-call-rail__marker \{[^}]*grid-column/);
  });

  test('a narrow container moves the marker down to the first line and drops the connector', () => {
    const narrow =
      /@container cinder-tool-call-rail \(max-width: 28rem\) \{(.*)\n {2}\}\n/s.exec(
        cssText,
      )?.[1] ?? '';
    expect(narrow).toMatch(/--cinder-timeline-row-marker-offset:\s*0\.5625rem/);
    expect(narrow).toMatch(/--cinder-timeline-row-gap:\s*0px/);
    expect(narrow).toMatch(/\.cinder-timeline-item__event::before[^{]*\{[^}]*display:\s*none/s);
  });
});

describe('ToolCallRail styles', () => {
  test('a narrow container gives each row two lines and drops the duration', () => {
    expect(cssText).toContain('@container cinder-tool-call-rail (max-width: 28rem)');
    expect(cssText).toContain('grid-row: 2');
    expect(cssText).toContain('.cinder-tool-call-rail__summary-duration');
  });

  test('red and amber words use the status text tokens, never a fill', () => {
    expect(cssText).toContain('var(--cinder-status-danger-text)');
    expect(cssText).toContain('var(--cinder-status-warning-text)');
    expect(cssText).not.toContain('color: var(--cinder-status-danger-solid)');
    expect(cssText).not.toContain('color: var(--cinder-status-warning-solid)');
  });

  test('the selected row keeps the shared quiet focus ring', () => {
    expect(cssText).toContain('[data-cinder-selected] > .cinder-tool-call-rail__row');
    expect(cssText).toContain('var(--_cinder-focus-ring-shadow)');
  });
  test('an interrupted call shows its own words in danger text with a glyph, never a dot, and never folds', () => {
    const calls = turn(12);
    calls[6] = {
      id: 'cut',
      name: 'Issue refund',
      input: '4471',
      status: 'interrupted',
      result: 'Interrupted · may have run',
      duration: '1.2s',
    };
    const { container } = render(ToolCallRail, { props: { calls } });
    expect(rows(container).map((row) => row.dataset['cinderToolCallRow'])).toContain('cut');
    const item = container.querySelector(
      '.cinder-tool-call-rail__item[data-cinder-status="interrupted"]',
    );
    expect(item).not.toBeNull();
    // The marker is the timeline's, beside the row: a glyph, never the dot.
    const marker = container.querySelector(
      '.cinder-tool-call-rail__marker[data-cinder-status="interrupted"]',
    );
    expect(marker?.querySelector('.cinder-tool-call-rail__dot')).toBeNull();
    expect(marker?.querySelector('.cinder-tool-call-rail__glyph')).not.toBeNull();
    const result = item?.querySelector('.cinder-tool-call-rail__result');
    // No arrow: an interrupted call has no answer to point at.
    expect(result?.textContent?.trim()).toBe('Interrupted · may have run');
    expect(item?.querySelector('.cinder-sr-only')?.textContent).toContain('Interrupted');
  });

  test('an interrupted call without words reads Interrupted', () => {
    const { container } = render(ToolCallRail, {
      props: { calls: [{ id: 'cut', name: 'Lookup order', status: 'interrupted' }] },
    });
    expect(container.querySelector('.cinder-tool-call-rail__result')?.textContent?.trim()).toBe(
      'Interrupted',
    );
  });
});
