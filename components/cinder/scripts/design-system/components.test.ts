import { describe, expect, test } from 'bun:test';

import {
  cardHeight,
  componentReadme,
  livePreviewHtml,
  README_CAP,
  referenceSection,
  rewriteLinks,
  STATIC_PREVIEW_CAP,
  staticPreviewHtml,
} from './components.ts';
import type { ComponentManifest, ManifestComponent } from './manifest.ts';

const tabs: ManifestComponent = {
  id: 'tabs',
  exportName: 'Tabs',
  import: '@lostgradient/cinder',
  category: 'navigation',
  status: 'stable',
  purpose: 'Switches between panels',
  useWhen: ['Several views share one place.'],
  avoidWhen: ['Steps in order.', { reason: 'Navigating pages.' }],
  related: ['tab-list', 'gone'],
  a11y: { notes: ['Arrow keys move between tabs.'] },
};
const tabList: ManifestComponent = { ...tabs, id: 'tab-list', exportName: 'TabList' };
const manifest: ComponentManifest = {
  package: { tokenNamespaces: [] },
  categories: { navigation: { label: 'Navigation' } },
  components: [tabs, tabList],
};
const plan = {
  id: 'tabs',
  examples: [
    { id: 'basic', title: 'Basic "tabs"' },
    { id: 'vertical', title: 'Vertical' },
  ],
};

describe('rewriteLinks', () => {
  test('keeps absolute links, names linked components, and unlinks the rest', () => {
    const markdown =
      '[docs](https://example.com) [list](../tab-list/README.md#props) [TabList](src/components/tab-list/README.md) [tests](./tabs.test.ts)';
    expect(rewriteLinks(markdown, manifest)).toBe(
      '[docs](https://example.com) list (see TabList) TabList tests',
    );
  });
});

describe('referenceSection', () => {
  test('drops the title and comments and nests headings one level deeper', () => {
    const readme = '# Tabs\n\nIntro.\n<!-- generated -->\n## Usage\n\n#### Deep\n';
    expect(referenceSection(readme, manifest)).toBe('Intro.\n### Usage\n\n##### Deep');
  });
});

describe('componentReadme', () => {
  test('writes the manifest guidance before the reference', () => {
    const readme = componentReadme(tabs, manifest, '# Tabs\n\nBody.\n');
    expect(readme).toBe(
      [
        '# Tabs',
        '',
        'Switches between panels.',
        '',
        "**Category:** Navigation, **Status:** stable, **Import:** `import { Tabs } from '@lostgradient/cinder'`",
        '',
        '## Use when',
        '',
        '- Several views share one place.',
        '',
        '## Avoid when',
        '',
        '- Steps in order.',
        '- Navigating pages.',
        '',
        '## Related',
        '',
        'TabList, gone',
        '',
        '## Accessibility',
        '',
        '- Arrow keys move between tabs.',
        '',
        '## Reference',
        '',
        'Body.',
        '',
      ].join('\n'),
    );
  });

  test('truncates a README over the cap at a line boundary', () => {
    const line = `${'é'.repeat(99)}\n`;
    const readme = componentReadme(tabs, manifest, `# Tabs\n\n${line.repeat(400)}`);
    expect(Buffer.byteLength(readme)).toBeLessThanOrEqual(README_CAP);
    expect(readme).not.toContain('�');
    expect(readme).toEndWith(
      '\n\n_Reference truncated; the full README is in the repository at `components/cinder/src/components/tabs/README.md`._\n',
    );
  });

  test('points a truncated README at its own workspace', () => {
    const line = `${'a'.repeat(99)}\n`;
    const readme = componentReadme(
      tabs,
      manifest,
      `# Tabs\n\n${line.repeat(700)}`,
      'components/editor/src/lib/components/markdown-editor/README.md',
    );
    expect(readme).toEndWith(
      '\n\n_Reference truncated; the full README is in the repository at `components/editor/src/lib/components/markdown-editor/README.md`._\n',
    );
  });
});

describe('preview documents', () => {
  test('clamps the card height and widens only an overflowing card', () => {
    expect(cardHeight(undefined)).toBe(408);
    expect(cardHeight({ height: 10, width: 0 })).toBe(120);
    expect(cardHeight({ height: 9000, width: 0 })).toBe(4000);
    const narrow = livePreviewHtml(tabs, manifest, plan, { height: 200, width: 760 });
    expect(narrow.split('\n')[0]).toBe(
      `<!-- @dsCard group="Navigation" height=208 subtitle="Basic 'tabs', Vertical" -->`,
    );
    const wide = livePreviewHtml(tabs, manifest, plan, { height: 200, width: 900 });
    expect(wide.split('\n')[0]).toContain('height=208 width=916 subtitle=');
    expect(wide).toContain('<script src="./preview.js"></script>');
  });

  test('writes a static rendition with its styles and refuses one over the cap', () => {
    const snapshot = {
      styles: '.a{}',
      html: '<div id="cinder-preview"></div>',
      height: 300,
      errors: [],
    };
    const html = staticPreviewHtml(tabs, manifest, plan, snapshot);
    expect(html.split('\n')[0]).toBe(
      `<!-- @dsCard group="Navigation" height=308 subtitle="Static rendition, Basic 'tabs', Vertical" -->`,
    );
    expect(html).toContain('<title>Tabs — preview</title><style>.a{}</style></head>');
    expect(staticPreviewHtml(tabs, manifest, plan, { ...snapshot, styles: '' })).toContain(
      '<title>Tabs — preview</title></head>',
    );
    expect(() =>
      staticPreviewHtml(tabs, manifest, plan, {
        ...snapshot,
        html: 'x'.repeat(STATIC_PREVIEW_CAP),
      }),
    ).toThrow('static preview too large: Tabs');
  });
});
