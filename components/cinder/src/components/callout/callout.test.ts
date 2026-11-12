/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import { declarationsFor } from '../../test/css.ts';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: Callout } = await import('./callout.svelte');

function textSnippet(text: string) {
  return createRawSnippet(() => ({
    render: () => `<span>${text}</span>`,
    setup: () => {},
  }));
}

afterEach(() => {
  cleanup();
});

const emptySnippet = createRawSnippet(() => ({
  render: () => `<span></span>`,
  setup: () => {},
}));

describe('Callout rendering', () => {
  test('renders without errors with required props', () => {
    const { container } = render(Callout, {
      props: { children: emptySnippet },
    });
    expect(container.querySelector('.cinder-callout')).not.toBeNull();
  });

  test('root element is an <aside>', () => {
    const { container } = render(Callout, {
      props: { children: emptySnippet },
    });
    const root = container.querySelector('.cinder-callout');
    expect(root?.tagName).toBe('ASIDE');
  });

  test('semantic note mode renders a named static note without live-region attributes', () => {
    const { getByRole } = render(Callout, {
      props: {
        semantic: 'note',
        title: 'Temporal concept: Activity',
        children: textSnippet(
          'An Activity is durable work that runs outside the workflow isolate.',
        ),
        role: 'alert',
        'aria-live': 'assertive',
        'aria-atomic': 'true',
        'aria-relevant': 'additions',
        'aria-busy': 'true',
      } as never,
    });

    const note = getByRole('note', { name: 'Temporal concept: Activity' });
    expect(note.tagName).toBe('DIV');
    expect(note.classList.contains('cinder-callout')).toBe(true);
    expect(note.hasAttribute('aria-live')).toBe(false);
    expect(note.hasAttribute('aria-atomic')).toBe(false);
    expect(note.hasAttribute('aria-relevant')).toBe(false);
    expect(note.hasAttribute('aria-busy')).toBe(false);
  });

  test('applies custom class prop while preserving cinder-callout', () => {
    const { container } = render(Callout, {
      props: { class: 'my-custom-class', children: emptySnippet },
    });
    const root = container.querySelector('.cinder-callout');
    expect(root?.classList.contains('my-custom-class')).toBe(true);
    expect(root?.classList.contains('cinder-callout')).toBe(true);
  });

  test('rest props are spread onto the root element', () => {
    const { container } = render(Callout, {
      props: { id: 'my-callout', children: emptySnippet },
    });
    expect(container.querySelector('#my-callout')).not.toBeNull();
  });

  test('renders body children inside the content region', () => {
    const { container } = render(Callout, {
      props: { children: textSnippet('Body text') },
    });
    expect(container.querySelector('.cinder-callout__content')?.textContent).toContain('Body text');
  });
});

describe('Callout variants', () => {
  for (const variant of ['neutral', 'info', 'success', 'warning', 'danger'] as const) {
    test(`applies data-cinder-variant for variant "${variant}"`, () => {
      const { container } = render(Callout, {
        props: { variant, children: emptySnippet },
      });
      expect(container.querySelector('.cinder-callout')?.getAttribute('data-cinder-variant')).toBe(
        variant,
      );
    });
  }

  test('defaults data-cinder-variant to "neutral" when variant is omitted', () => {
    const { container } = render(Callout, {
      props: { children: emptySnippet },
    });
    const root = container.querySelector('.cinder-callout');
    expect(root?.getAttribute('data-cinder-variant')).toBe('neutral');
    // The default is untinted: it takes no status-surface class.
    expect(root?.classList.contains('cinder-_status-surface')).toBe(false);
  });

  test('a caller that wants the tinted info look passes variant="info"', () => {
    const { container } = render(Callout, {
      props: { variant: 'info', children: emptySnippet },
    });
    const root = container.querySelector('.cinder-callout');
    expect(root?.getAttribute('data-cinder-variant')).toBe('info');
    expect(root?.classList.contains('cinder-_status-surface')).toBe(true);
  });
});

describe('Callout neutral variant and action', () => {
  test('neutral does not take the status-surface classes, so it reads as a note, not a status', () => {
    const { container } = render(Callout, {
      props: { variant: 'neutral', children: emptySnippet },
    });
    const root = container.querySelector('.cinder-callout');
    expect(root?.classList.contains('cinder-_status-surface')).toBe(false);
    expect(root?.classList.contains('cinder-_status-surface-border')).toBe(false);
    cleanup();
    const warning = render(Callout, { props: { variant: 'warning', children: emptySnippet } });
    expect(
      warning.container
        .querySelector('.cinder-callout')
        ?.classList.contains('cinder-_status-surface'),
    ).toBe(true);
  });

  test('renders the action after the content, in both semantics, and omits it when absent', () => {
    const action = createRawSnippet(() => ({
      render: () => `<a href="/goals/draft/attempts/5">Open attempt 5</a>`,
      setup: () => {},
    }));
    for (const semantic of ['aside', 'note'] as const) {
      const { container } = render(Callout, {
        props: {
          variant: 'neutral',
          semantic,
          action,
          icon: textSnippet('i'),
          children: textSnippet('Gave up after 5 attempts.'),
        },
      });
      const root = container.querySelector('.cinder-callout');
      const children = [...(root?.children ?? [])].map((child) => child.className);
      expect(children).toEqual([
        'cinder-callout__icon',
        'cinder-callout__content',
        'cinder-callout__action',
      ]);
      expect(root?.querySelector('.cinder-callout__action a')?.textContent).toBe('Open attempt 5');
      // The action is outside the content, so it never joins the callout's accessible text.
      expect(root?.querySelector('.cinder-callout__content a')).toBeNull();
      cleanup();
    }
    const bare = render(Callout, { props: { children: emptySnippet } });
    expect(bare.container.querySelector('.cinder-callout__action')).toBeNull();
  });

  test('the stylesheet draws neutral as an icon and muted text with no tint', async () => {
    const css = await Bun.file(new URL('./callout.css', import.meta.url)).text();
    const neutral = declarationsFor(css, ".cinder-callout[data-cinder-variant='neutral']");
    expect(neutral.get('align-items')).toBe('center');
    expect(neutral.get('background')).toBe('transparent');
    expect(neutral.get('border-color')).toBe('transparent');
    expect(neutral.get('color')).toBe('var(--cinder-text-muted)');
  });

  test('the stylesheet stacks the action under a message capped at 68ch, in a wrapping row', async () => {
    const css = await Bun.file(new URL('./callout.css', import.meta.url)).text();
    const content = declarationsFor(css, '.cinder-callout__content');
    expect(content.get('max-inline-size')).toBe('68ch');
    expect(content.get('grid-row')).toBe('1');
    const action = declarationsFor(css, '.cinder-callout__action');
    expect(action.get('grid-row')).toBe('2');
    expect(action.get('grid-column')).toBe('2');
    expect(action.get('flex-wrap')).toBe('wrap');
    expect(action.get('margin-inline-start')).toBeUndefined();
    for (const control of ['button', 'a']) {
      expect(declarationsFor(css, `.cinder-callout__action ${control}`).get('white-space')).toBe(
        'nowrap',
      );
    }
  });

  test('supports an explicit inline action layout without changing the stacked default', () => {
    const action = createRawSnippet(() => ({ render: () => '<button>Retry</button>' }));
    const { container } = render(Callout, {
      props: { actionLayout: 'inline', action, children: textSnippet('Connection paused.') },
    });
    expect(container.querySelector('.cinder-callout--inline-action')).not.toBeNull();
    cleanup();
    const stacked = render(Callout, {
      props: { action, children: textSnippet('Connection paused.') },
    });
    expect(stacked.container.querySelector('.cinder-callout--inline-action')).toBeNull();
  });

  test('keeps an icon, long copy and inline action in separate grid tracks', async () => {
    const action = createRawSnippet(() => ({ render: () => '<button>Retry</button>' }));
    const icon = createRawSnippet(() => ({ render: () => '<svg aria-hidden="true"></svg>' }));
    const { container } = render(Callout, {
      props: {
        actionLayout: 'inline',
        action,
        icon,
        children: textSnippet(
          'This is a deliberately long notice that must remain readable when the available width becomes narrow.',
        ),
      },
    });
    const root = container.querySelector('.cinder-callout--inline-action')!;
    expect(root.querySelector('.cinder-callout__icon')).not.toBeNull();
    expect(root.querySelector('.cinder-callout__content')?.textContent).toContain(
      'deliberately long',
    );
    expect(root.querySelector('.cinder-callout__action button')?.textContent).toBe('Retry');
    const css = await Bun.file(new URL('./callout.css', import.meta.url)).text();
    expect(css).toContain('.cinder-callout--inline-action:has(> .cinder-callout__icon)');
    expect(css).toContain('grid-template-columns: minmax(0, 1fr) max-content;');
  });
});

describe('Callout title', () => {
  test('renders title as a <p>, not a heading element', () => {
    const { container } = render(Callout, {
      props: { title: 'Heads up', children: emptySnippet },
    });
    const titleElement = container.querySelector('.cinder-callout__title');
    expect(titleElement).not.toBeNull();
    expect(titleElement?.tagName).toBe('P');
    expect(titleElement?.textContent).toBe('Heads up');
  });

  test('omits the title element when no title prop is supplied', () => {
    const { container } = render(Callout, {
      props: { children: emptySnippet },
    });
    expect(container.querySelector('.cinder-callout__title')).toBeNull();
  });

  test('does not inject heading elements into the document outline', () => {
    const { container } = render(Callout, {
      props: { title: 'Heads up', children: textSnippet('Body') },
    });
    expect(container.querySelectorAll('h1, h2, h3, h4, h5, h6').length).toBe(0);
  });
});

describe('Callout icon', () => {
  test('renders icon snippet when provided', () => {
    const { container } = render(Callout, {
      props: { icon: textSnippet('icon-mark'), children: emptySnippet },
    });
    const iconWrapper = container.querySelector('.cinder-callout__icon');
    expect(iconWrapper).not.toBeNull();
    expect(iconWrapper?.textContent).toContain('icon-mark');
  });

  test('icon wrapper is aria-hidden', () => {
    const { container } = render(Callout, {
      props: { icon: textSnippet('x'), children: emptySnippet },
    });
    expect(container.querySelector('.cinder-callout__icon')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  test('does not render an icon wrapper when icon prop is omitted', () => {
    const { container } = render(Callout, {
      props: { children: emptySnippet },
    });
    expect(container.querySelector('.cinder-callout__icon')).toBeNull();
  });
});

describe('Callout accessibility', () => {
  test('does not set an explicit role attribute on the root <aside>', () => {
    const { container } = render(Callout, {
      props: { children: emptySnippet },
    });
    const root = container.querySelector('.cinder-callout');
    expect(root?.hasAttribute('role')).toBe(false);
  });

  test('does not set aria-live on the root element', () => {
    const { container } = render(Callout, {
      props: { children: emptySnippet },
    });
    const root = container.querySelector('.cinder-callout');
    expect(root?.hasAttribute('aria-live')).toBe(false);
  });

  test('strips a consumer-supplied role from rest props', () => {
    // role is forbidden by the type, but a consumer can still escape it
    // via `as never`. The runtime must scrub it so consumers cannot
    // override the implicit <aside> role with role="alert" or similar.
    const { container } = render(Callout, {
      props: { role: 'alert', children: emptySnippet } as never,
    });
    const root = container.querySelector('.cinder-callout');
    expect(root?.hasAttribute('role')).toBe(false);
  });

  test('strips aria-live from consumer-supplied rest props', () => {
    const { container } = render(Callout, {
      // aria-live is intentionally forbidden by the type, but a runtime
      // consumer could still pass it through spread props. The component
      // must scrub it so callouts never accidentally become live regions.
      props: { 'aria-live': 'polite', children: emptySnippet } as never,
    });
    const root = container.querySelector('.cinder-callout');
    expect(root?.hasAttribute('aria-live')).toBe(false);
  });

  test('strips aria-atomic, aria-relevant, and aria-busy from consumer rest props', () => {
    const { container } = render(Callout, {
      props: {
        'aria-atomic': 'true',
        'aria-relevant': 'additions',
        'aria-busy': 'true',
        children: emptySnippet,
      } as never,
    });
    const root = container.querySelector('.cinder-callout');
    expect(root?.hasAttribute('aria-atomic')).toBe(false);
    expect(root?.hasAttribute('aria-relevant')).toBe(false);
    expect(root?.hasAttribute('aria-busy')).toBe(false);
  });

  test('forwards aria-label from consumer rest props', () => {
    const { container } = render(Callout, {
      props: { 'aria-label': 'Heads up', children: emptySnippet },
    });
    expect(container.querySelector('.cinder-callout')?.getAttribute('aria-label')).toBe('Heads up');
  });
});

describe('Callout landmark labeling', () => {
  test('derives aria-label from title when no consumer label is provided', () => {
    const { container } = render(Callout, {
      props: { title: 'Heads up', children: emptySnippet },
    });
    expect(container.querySelector('.cinder-callout')?.getAttribute('aria-label')).toBe('Heads up');
  });

  test('does not set aria-label when neither title nor consumer label is supplied', () => {
    const { container } = render(Callout, {
      props: { children: emptySnippet },
    });
    expect(container.querySelector('.cinder-callout')?.hasAttribute('aria-label')).toBe(false);
  });

  test('consumer-supplied aria-label overrides the title-derived label', () => {
    const { container } = render(Callout, {
      props: {
        title: 'Visual title',
        'aria-label': 'Accessible name',
        children: emptySnippet,
      },
    });
    expect(container.querySelector('.cinder-callout')?.getAttribute('aria-label')).toBe(
      'Accessible name',
    );
  });

  test('aria-labelledby suppresses the title-derived aria-label so the accessible name has a single source', () => {
    const { container } = render(Callout, {
      props: {
        title: 'Visual title',
        'aria-labelledby': 'external-heading',
        children: emptySnippet,
      },
    });
    const root = container.querySelector('.cinder-callout');
    expect(root?.hasAttribute('aria-label')).toBe(false);
    expect(root?.getAttribute('aria-labelledby')).toBe('external-heading');
  });
});
