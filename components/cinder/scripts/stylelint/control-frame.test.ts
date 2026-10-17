import { describe, expect, test } from 'bun:test';
import stylelint from 'stylelint';

const ruleName = 'cinder/control-frame';
const pluginPath = new URL('./control-frame.mjs', import.meta.url).pathname;

async function findings(code: string, codeFilename?: string): Promise<string[]> {
  const result = await stylelint.lint({
    code,
    ...(codeFilename ? { codeFilename } : {}),
    config: { plugins: [pluginPath], rules: { [ruleName]: true } },
  });
  return result.results
    .flatMap((file) => file.warnings ?? [])
    .filter((warning) => warning.rule === ruleName)
    .map((warning) => warning.text);
}

describe(ruleName, () => {
  test('accepts a control drawn entirely from the frame', async () => {
    expect(
      await findings(`.cinder-input {
        background: var(--cinder-control-background);
        border: 1px solid var(--cinder-control-border);
        border-radius: var(--cinder-control-radius);
      }
      .cinder-input:hover { border-color: var(--cinder-control-border-hover); }
      .cinder-input:disabled {
        background: var(--cinder-control-background-disabled);
        border-color: var(--cinder-control-border-disabled);
      }
      .cinder-input[aria-invalid='true'] { border-color: var(--cinder-control-border-invalid); }`),
    ).toEqual([]);
  });

  test.each([
    ['a structural border tier', 'border: 1px solid var(--cinder-border)'],
    ['the strong tier as a hover', 'border-color: var(--cinder-border-strong)'],
    [
      'the control tier directly instead of the frame',
      'border-color: var(--cinder-border-control)',
    ],
    ['the page surface', 'background: var(--cinder-surface)'],
    ['the inset surface', 'background-color: var(--cinder-surface-inset)'],
    [
      'the raised surface directly instead of the frame',
      'background: var(--cinder-surface-raised)',
    ],
    ['an unrecognized public token', 'background: var(--cinder-text-default)'],
    ['the small radius', 'border-radius: var(--cinder-radius-sm)'],
    ['the raw medium radius', 'border-radius: var(--cinder-radius-md)'],
    ['a literal color', 'border-color: #ccc'],
    ['a status fill as an edge', 'border-color: var(--cinder-status-danger-solid)'],
  ])('rejects %s', async (_name, declaration) => {
    const [message] = await findings(`input { ${declaration}; }`);
    expect(message).toContain('must come from the control frame');
  });

  test('targets select, textarea, and combobox roles as well as input', async () => {
    for (const selector of ['select', 'textarea', "[role='combobox']", '.cinder-textarea']) {
      expect(
        await findings(`${selector} { border-radius: var(--cinder-radius-sm); }`),
      ).toHaveLength(1);
    }
  });

  test('allows state colors, forced-colors keywords, and composer radii', async () => {
    expect(
      await findings(`.cinder-input:focus-visible { border-color: transparent; }
      .cinder-checkbox:checked { background: var(--cinder-accent-solid); }
      @media (forced-colors: active) { .cinder-input { border-color: Mark; } }
      .chat-input { border-radius: var(--cinder-radius-lg); }`),
    ).toEqual([]);
  });

  test('defers private hooks to where they are declared', async () => {
    expect(
      await findings('.cinder-input { background: var(--_cinder-input-fill, transparent); }'),
    ).toEqual([]);
  });

  test('leaves a checkbox or radio box its own radius', async () => {
    expect(await findings('.cinder-checkbox { border-radius: var(--cinder-radius-sm); }')).toEqual(
      [],
    );
  });

  test('ignores non-control selectors and sources outside component CSS', async () => {
    expect(await findings('.cinder-card { border: 1px solid var(--cinder-border); }')).toEqual([]);
    expect(
      await findings(
        'input { border: 1px solid var(--cinder-border); }',
        '/workspace/applications/playground/src/routes/page.css',
      ),
    ).toEqual([]);
  });
});
