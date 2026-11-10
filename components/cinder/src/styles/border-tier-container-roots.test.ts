import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

/**
 * COR-2311: space first, then tone, then a border, with elevation for anything that floats. A
 * container root draws a structural-tier border (`--cinder-border`, `-muted`, `-strong`; never the
 * 3:1 `-control` tier) only when it is a panel, a floating surface, a status, or a small control
 * chip, and each one is named here. A component outside the list that adds one fails, so a new
 * card-like container has to choose a tone or a shadow, or be added here with a reason.
 */
describe('COR-2311: container roots draw no structural border unless allowlisted', () => {
  const COMPONENTS_ROOT = join(import.meta.dirname, '..', 'components');

  const EXCEPTIONS: Record<string, string> = {
    accordion: 'a stack of panels, each a real outlined region',
    alert: 'a status role; the border carries the tone',
    avatar: 'a small identity chip, not a container',
    badge: 'a small label chip, not a container',
    callout: 'a status role; the border carries the tone',
    'capability-gate': 'a status panel',
    chip: 'a small control chip',
    collapsible: 'a real panel with a disclosure',
    'data-grid': 'a framed data surface with its own scroll box',
    'hover-card': 'floats; the border keeps it legible over content',
    kbd: 'a key cap, not a container',
    message: 'a message bubble',
    'payload-inspector': 'a framed code region',
    popover: 'floats; the border keeps it legible over content',
    'preview-panel': 'a framed preview region',
    'pricing-card': 'a marketing panel',
    'share-card': 'a marketing panel',
    'source-diff-viewer': 'a framed code region',
    surface: 'the explicit bordered surface primitive',
    table: 'a framed data surface; `frameless` opts out',
    'terminal-frame': 'a framed code region',
    'theme-switch': 'a control track',
    'tool-call-panel': 'a framed panel inside a conversation',
  };

  function bordered(): string[] {
    const found: string[] = [];
    for (const name of readdirSync(COMPONENTS_ROOT)) {
      const path = join(COMPONENTS_ROOT, name, `${name}.css`);
      if (!existsSync(path)) continue;
      const source = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) =>
        ' '.repeat(c.length),
      );
      for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (match[1]!.replace(/\s+/g, ' ').trim() !== `.cinder-${name}`) continue;
        const edges = match[2]!.match(/(?:^|[;\s])border(?:-color)?:\s*([^;]+);/g) ?? [];
        if (edges.some((edge) => /--cinder-border(-muted|-strong)?\)/.test(edge))) found.push(name);
      }
    }
    return found;
  }

  test('only the named components draw a structural border on their root', () => {
    const unexpected = bordered().filter((name) => !(name in EXCEPTIONS));
    expect(
      unexpected,
      'A component root draws a structural-tier border. Separate it with space or a surface tone, ' +
        'a floating one with a shadow token, or add it to EXCEPTIONS with the reason it is a panel.',
    ).toEqual([]);
  });

  test('the allowlist holds only components that still draw one', () => {
    const drawing = new Set(bordered());
    expect(Object.keys(EXCEPTIONS).filter((name) => !drawing.has(name))).toEqual([]);
  });

  test.each(['card', 'stacked-list-item', 'page-header', 'segmented-control'])(
    '%s is borderless by default',
    (name) => {
      expect(bordered()).not.toContain(name);
    },
  );
});
