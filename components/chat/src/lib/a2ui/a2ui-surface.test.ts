/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

import { A2UI_COMPONENT_TARGETS, A2UI_ENUM_MAPPINGS } from './catalog-mapping.ts';
import { A2uiDataModel } from './data-model.svelte.ts';
import { A2UI_ICONS } from './icon-names.ts';
import type { A2uiAction, A2uiComponent, A2uiDiagnostic, A2uiJsonValue } from './types.ts';

setupHappyDom();

const { render, cleanup, fireEvent, screen } = await import('@testing-library/svelte');
const { default: A2uiSurface } = await import('./a2ui-surface.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type CatalogSchema = {
  components: Record<
    string,
    { allOf: { properties?: Record<string, { enum?: string[]; oneOf?: { enum?: string[] }[] }> }[] }
  >;
};

const catalog = (await Bun.file(
  new URL('./basic-catalog.schema.json', import.meta.url),
).json()) as CatalogSchema;

function catalogProperties(component: string) {
  const entry = catalog.components[component];
  if (entry === undefined) throw new Error(`no ${component} in the catalog`);
  return Object.assign({}, ...entry.allOf.map((part) => part.properties ?? {})) as Record<
    string,
    { enum?: string[]; oneOf?: { enum?: string[] }[] }
  >;
}

type Example = { messages: Record<string, unknown>[] };

/** The components and data model an example's messages leave a surface with. */
async function loadExample(
  file: string,
): Promise<{ components: A2uiComponent[]; dataModel: A2uiJsonValue }> {
  const example = (await Bun.file(
    new URL(`./examples/${file}`, import.meta.url),
  ).json()) as Example;
  const byId = new Map<string, A2uiComponent>();
  const model = new A2uiDataModel({});
  for (const message of example.messages) {
    const update = message['updateComponents'] as { components: A2uiComponent[] } | undefined;
    for (const component of update?.components ?? []) byId.set(component.id, component);
    const data = message['updateDataModel'] as { path?: string; value?: A2uiJsonValue } | undefined;
    // A2UI's wire names the whole model `/`; the data model is strict RFC 6901.
    if (data !== undefined)
      model.set(data.path === undefined || data.path === '/' ? '' : data.path, data.value ?? null);
  }
  return { components: [...byId.values()], dataModel: model.snapshot() };
}

describe('the catalog mapping', () => {
  test('maps every basic-catalog component and nothing else', () => {
    expect(Object.keys(A2UI_COMPONENT_TARGETS).toSorted()).toEqual(
      Object.keys(catalog.components).toSorted(),
    );
  });

  test('lists every enumerated property value the vendored catalog allows', () => {
    const missing: string[] = [];
    for (const component of Object.keys(catalog.components)) {
      for (const [property, schema] of Object.entries(catalogProperties(component))) {
        if (schema.enum === undefined || property === 'component') continue;
        const mapping = (A2UI_ENUM_MAPPINGS as Record<string, Record<string, { values: object }>>)[
          component
        ]?.[property];
        for (const value of schema.enum) {
          if (mapping === undefined || !Object.hasOwn(mapping.values, value)) {
            missing.push(`${component}.${property}=${value}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('lists every icon name the vendored catalog allows', () => {
    const names = catalogProperties('Icon')['name']?.oneOf?.[0]?.enum ?? [];
    expect(Object.keys(A2UI_ICONS).toSorted()).toEqual([...names].toSorted());
  });
});

const EXAMPLE_FOR: Record<string, string> = {
  Text: '00_complex-layout.json',
  Image: '06_music-player.json',
  Icon: '07_task-card.json',
  Video: '29_movie-card.json',
  AudioPlayer: '26_podcast-episode.json',
  Row: '00_complex-layout.json',
  Column: '00_complex-layout.json',
  List: '34_child-list-template.json',
  Card: '01_flight-status.json',
  Tabs: '24_recipe-card.json',
  Divider: '01_flight-status.json',
  Modal: '36_modal.json',
  Button: '00_interactive-button.json',
  TextField: '00_complex-layout.json',
  CheckBox: '07_task-card.json',
  ChoicePicker: '19_software-purchase.json',
  Slider: '06_music-player.json',
  DateTimeInput: '07_task-card.json',
};

describe('rendering the vendored examples', () => {
  for (const [type, file] of Object.entries(EXAMPLE_FOR)) {
    test(`renders ${type} from ${file}`, async () => {
      const { components, dataModel } = await loadExample(file);
      const diagnostics: A2uiDiagnostic[] = [];
      const { container } = render(A2uiSurface, {
        props: {
          surfaceId: 'example',
          components,
          dataModel,
          resolveAssetUrl: async (url: string) => url,
          onDiagnostic: (diagnostic: A2uiDiagnostic) => diagnostics.push(diagnostic),
        },
      });
      await flush();
      await flush();

      // Content inside a Modal renders once its trigger opens it, outside the container.
      if (container.querySelector(`[data-a2ui-component="${type}"]`) === null) {
        for (const trigger of container.querySelectorAll('.a2ui-modal-trigger button')) {
          await fireEvent.click(trigger);
        }
        await flush();
        await flush();
      }
      const nodes = document.querySelectorAll(`[data-a2ui-component="${type}"]`);
      expect(nodes.length).toBeGreaterThan(0);
      const rendered = [...nodes].some((node) => node.childElementCount > 0);
      expect(rendered).toBe(true);
      const structural = diagnostics.filter((diagnostic) =>
        ['unsupported-component', 'missing-component', 'component-cycle'].includes(diagnostic.code),
      );
      expect(structural).toEqual([]);
    });
  }
});

describe('data binding', () => {
  const formComponents: A2uiComponent[] = [
    { id: 'root', component: 'Column', children: ['field', 'echo', 'list'] },
    { id: 'field', component: 'TextField', label: 'Name', value: { path: '/form/name' } },
    { id: 'echo', component: 'Text', text: { path: '/form/name' }, variant: 'h2' },
    { id: 'list', component: 'List', children: { componentId: 'row', path: '/people' } },
    { id: 'row', component: 'Text', text: { path: 'name' }, variant: 'h3' },
  ];

  test('an input writes its bound path at once, and every binding to it updates', async () => {
    const changes: A2uiJsonValue[] = [];
    const { container } = render(A2uiSurface, {
      props: {
        surfaceId: 'form',
        components: formComponents,
        dataModel: { form: { name: 'Ada' }, people: [{ name: 'Grace' }, { name: 'Alan' }] },
        onDataModelChange: (model: A2uiJsonValue) => changes.push(model),
      },
    });
    await flush();

    const input = screen.getByLabelText('Name') as HTMLInputElement;
    expect(input.value).toBe('Ada');
    await fireEvent.input(input, { target: { value: 'Ada Lovelace' } });
    await flush();

    expect(container.querySelector('[data-a2ui-id="echo"]')?.textContent).toBe('Ada Lovelace');
    expect(changes.at(-1)).toMatchObject({ form: { name: 'Ada Lovelace' } });
  });

  test('a template resolves relative paths against each item, and follows a new model', async () => {
    const view = render(A2uiSurface, {
      props: {
        surfaceId: 'form',
        components: formComponents,
        dataModel: { form: { name: '' }, people: [{ name: 'Grace' }, { name: 'Alan' }] },
      },
    });
    await flush();
    const rows = () =>
      [...view.container.querySelectorAll('[data-a2ui-id="row"]')].map((node) => node.textContent);
    expect(rows()).toEqual(['Grace', 'Alan']);

    await view.rerender({ dataModel: { form: { name: '' }, people: [{ name: 'Barbara' }] } });
    await flush();

    expect(rows()).toEqual(['Barbara']);
  });
});

describe('diagnostics', () => {
  test('a component outside the basic catalog renders nothing and is reported once', async () => {
    const diagnostics: A2uiDiagnostic[] = [];
    const components: A2uiComponent[] = [
      { id: 'root', component: 'Column', children: ['script', 'note'] },
      { id: 'script', component: 'Script', source: 'alert(1)' },
      { id: 'note', component: 'Text', text: '<img src=x onerror=alert(1)>', variant: 'h1' },
    ];
    const view = render(A2uiSurface, {
      props: {
        surfaceId: 'unsafe',
        components,
        onDiagnostic: (diagnostic: A2uiDiagnostic) => diagnostics.push(diagnostic),
      },
    });
    await flush();
    await view.rerender({ components: [...components] });
    await flush();

    expect(view.container.querySelector('[data-a2ui-id="script"]')).toBeNull();
    expect(view.container.querySelector('img')).toBeNull();
    expect(diagnostics.filter((entry) => entry.code === 'unsupported-component')).toEqual([
      {
        code: 'unsupported-component',
        componentId: 'script',
        message: '"Script" is not in the A2UI basic catalog',
      },
    ]);
  });

  test('an unmapped enumerated value falls back to its default and is reported', async () => {
    const diagnostics: A2uiDiagnostic[] = [];
    render(A2uiSurface, {
      props: {
        surfaceId: 'values',
        components: [
          { id: 'root', component: 'Row', justify: 'diagonal', children: ['icon'] },
          { id: 'icon', component: 'Icon', name: 'starHalf' },
        ],
        onDiagnostic: (diagnostic: A2uiDiagnostic) => diagnostics.push(diagnostic),
      },
    });
    await flush();

    expect(diagnostics.map((entry) => entry.code).toSorted()).toEqual([
      'unknown-icon',
      'unsupported-value',
    ]);
  });
});

describe('actions', () => {
  test('a Button sends its event with the context resolved when it is pressed', async () => {
    const actions: A2uiAction[] = [];
    render(A2uiSurface, {
      props: {
        surfaceId: 'actions',
        components: [
          { id: 'root', component: 'Column', children: ['field', 'submit'] },
          { id: 'field', component: 'TextField', label: 'Email', value: { path: '/email' } },
          {
            id: 'submit',
            component: 'Button',
            child: 'submit-label',
            variant: 'primary',
            action: {
              event: {
                name: 'submit_form',
                context: { email: { path: '/email' }, source: 'form' },
              },
            },
          },
          { id: 'submit-label', component: 'Text', text: 'Submit' },
        ],
        dataModel: { email: 'old@example.com' },
        onAction: (action: A2uiAction) => actions.push(action),
      },
    });
    await flush();

    await fireEvent.input(screen.getByLabelText('Email'), { target: { value: 'new@example.com' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      name: 'submit_form',
      surfaceId: 'actions',
      sourceComponentId: 'submit',
      context: { email: 'new@example.com', source: 'form' },
    });
    expect(Number.isNaN(Date.parse(actions[0]?.timestamp ?? ''))).toBe(false);
  });

  test('a failing check disables its Button', async () => {
    render(A2uiSurface, {
      props: {
        surfaceId: 'checks',
        components: [
          {
            id: 'root',
            component: 'Button',
            child: 'label',
            action: { event: { name: 'go' } },
            checks: [
              {
                condition: { call: 'required', args: { value: { path: '/terms' } } },
                message: 'Accept the terms',
              },
            ],
          },
          { id: 'label', component: 'Text', text: 'Go' },
        ],
        dataModel: { terms: '' },
      },
    });
    await flush();

    expect((screen.getByRole('button', { name: 'Go' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('assets', () => {
  test('every asset URL goes through the resolver, and its object URL is released on unmount', async () => {
    const resolved: string[] = [];
    const revoked: string[] = [];
    const originalRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
    try {
      const view = render(A2uiSurface, {
        props: {
          surfaceId: 'media',
          components: [
            { id: 'root', component: 'Column', children: ['image', 'video', 'audio'] },
            {
              id: 'image',
              component: 'Image',
              url: 'https://assets.test/a.png',
              description: 'A chart',
            },
            { id: 'video', component: 'Video', url: 'https://assets.test/b.mp4' },
            {
              id: 'audio',
              component: 'AudioPlayer',
              url: 'https://assets.test/c.mp3',
              description: 'Episode',
            },
          ],
          resolveAssetUrl: async (url: string) => {
            resolved.push(url);
            return URL.createObjectURL(new Blob([url]));
          },
          releaseAssetUrl: (url: string) => URL.revokeObjectURL(url),
        },
      });
      await flush();
      await flush();

      expect(resolved.toSorted()).toEqual([
        'https://assets.test/a.png',
        'https://assets.test/b.mp4',
        'https://assets.test/c.mp3',
      ]);
      const sources = [...view.container.querySelectorAll('img, video, audio')].map(
        (element) => element.getAttribute('src') ?? '',
      );
      expect(sources).toHaveLength(3);
      for (const source of sources) expect(source.startsWith('blob:')).toBe(true);

      view.unmount();
      expect(revoked.toSorted()).toEqual(sources.toSorted());
    } finally {
      URL.revokeObjectURL = originalRevoke;
    }
  });
});

describe('Modal', () => {
  test('opens from its trigger and has a close affordance', async () => {
    const { components, dataModel } = await loadExample('36_modal.json');
    render(A2uiSurface, { props: { surfaceId: 'modal', components, dataModel } });
    await flush();

    const triggers = screen.getAllByRole('button');
    const trigger = triggers[0];
    if (trigger === undefined) throw new Error('no trigger button');
    await fireEvent.click(trigger);
    await flush();

    const dialog = screen.getByRole('dialog');
    expect(dialog).not.toBeNull();
    expect(screen.getByRole('button', { name: /close/i })).not.toBeNull();
  });
});

describe('review fixes', () => {
  test('the vendored files match the digests in PROVENANCE.json', async () => {
    const provenance = (await Bun.file(new URL('./PROVENANCE.json', import.meta.url)).json()) as {
      files: Record<string, { sha256: string }>;
    };
    for (const [name, { sha256 }] of Object.entries(provenance.files)) {
      const bytes = await Bun.file(new URL(`./${name}`, import.meta.url)).arrayBuffer();
      const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
      expect(`${name} ${digest}`).toBe(`${name} ${sha256}`);
    }
  });

  test('a path through a prototype key writes nothing', async () => {
    render(A2uiSurface, {
      props: {
        surfaceId: 'proto',
        components: [
          {
            id: 'root',
            component: 'TextField',
            label: 'Field',
            value: { path: '/__proto__/polluted' },
          },
        ],
      },
    });
    await flush();

    await fireEvent.input(screen.getByLabelText('Field'), { target: { value: 'yes' } });

    expect(Reflect.get({}, 'polluted')).toBeUndefined();
  });

  test('accepts a proxied data model, as a Svelte $state object is', async () => {
    const dataModel = new Proxy({ name: 'Ada' }, {});
    const { container } = render(A2uiSurface, {
      props: {
        surfaceId: 'proxy',
        components: [{ id: 'root', component: 'Text', text: { path: '/name' }, variant: 'h2' }],
        dataModel,
      },
    });
    await flush();

    expect(container.textContent).toContain('Ada');
  });

  test('evaluates an unbound function-call value, and a server update replaces a literal edit', async () => {
    const field = (value: unknown): A2uiComponent[] => [
      { id: 'root', component: 'TextField', label: 'Greeting', value },
    ];
    const view = render(A2uiSurface, {
      props: {
        surfaceId: 'literal',
        components: field({ call: 'formatString', args: { value: 'hi' } }),
      },
    });
    await flush();
    const input = () => screen.getByLabelText('Greeting') as HTMLInputElement;
    expect(input().value).toBe('hi');

    await fireEvent.input(input(), { target: { value: 'edited' } });
    await view.rerender({ components: field('from the server') });
    await flush();

    expect(input().value).toBe('from the server');
  });

  test('a number TextField writes its bound path as a string', async () => {
    const changes: A2uiJsonValue[] = [];
    render(A2uiSurface, {
      props: {
        surfaceId: 'number',
        components: [
          {
            id: 'root',
            component: 'TextField',
            label: 'Count',
            variant: 'number',
            value: { path: '/count' },
          },
        ],
        dataModel: { count: '1' },
        onDataModelChange: (model: A2uiJsonValue) => changes.push(model),
      },
    });
    await flush();
    const field = screen.getByRole('spinbutton', { name: /Count/ });

    await fireEvent.input(field, { target: { value: '4' } });
    await fireEvent.blur(field);

    expect(changes.at(-1)).toEqual({ count: '4' });
  });

  test('an invalid validation pattern neither throws nor marks the value invalid', async () => {
    const { container } = render(A2uiSurface, {
      props: {
        surfaceId: 'pattern',
        components: [
          { id: 'root', component: 'TextField', label: 'Code', value: 'x', validationRegexp: '(' },
        ],
      },
    });
    await flush();

    expect(container.querySelector('[data-a2ui-id="root"]')).not.toBeNull();
    expect(screen.getByLabelText('Code').getAttribute('aria-invalid')).not.toBe('true');
  });

  test('a weighted Row child grows in proportion', async () => {
    const { container } = render(A2uiSurface, {
      props: {
        surfaceId: 'weights',
        components: [
          { id: 'root', component: 'Row', children: ['wide', 'narrow'] },
          { id: 'wide', component: 'Text', text: 'Wide', weight: 2 },
          { id: 'narrow', component: 'Text', text: 'Narrow', weight: 1 },
        ],
      },
    });
    await flush();

    const wide = container.querySelector('[data-a2ui-id="wide"]') as HTMLElement;
    expect(wide.style.flexGrow).toBe('2');
  });

  test('a Modal whose Button trigger contains itself still renders', async () => {
    const diagnostics: A2uiDiagnostic[] = [];
    render(A2uiSurface, {
      props: {
        surfaceId: 'cycle',
        components: [
          { id: 'root', component: 'Modal', trigger: 'loop', content: 'body' },
          { id: 'loop', component: 'Button', child: 'loop', action: { event: { name: 'x' } } },
          { id: 'body', component: 'Text', text: 'Body' },
        ],
        onDiagnostic: (diagnostic: A2uiDiagnostic) => diagnostics.push(diagnostic),
      },
    });
    await flush();

    expect(diagnostics.map((entry) => entry.code)).toContain('component-cycle');
  });

  test('a ChoicePicker without a label and an icon-only Button are still named', async () => {
    render(A2uiSurface, {
      props: {
        surfaceId: 'names',
        components: [
          { id: 'root', component: 'Column', children: ['pick', 'cart'] },
          {
            id: 'pick',
            component: 'ChoicePicker',
            displayStyle: 'chips',
            options: [{ label: 'One', value: 'one' }],
            value: [],
          },
          {
            id: 'cart',
            component: 'Button',
            child: 'cart-icon',
            action: { event: { name: 'cart' } },
          },
          { id: 'cart-icon', component: 'Icon', name: 'shoppingCart' },
        ],
      },
    });
    await flush();

    expect(screen.getByRole('combobox', { name: 'Options' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Shopping cart' })).not.toBeNull();
  });

  test('a __proto__ key in an action context never becomes the context’s prototype', async () => {
    const actions: A2uiAction[] = [];
    const context = JSON.parse('{"__proto__": {"admin": true}, "item": "x"}') as Record<
      string,
      unknown
    >;
    render(A2uiSurface, {
      props: {
        surfaceId: 'proto-action',
        components: [
          {
            id: 'root',
            component: 'Button',
            child: 'label',
            action: { event: { name: 'go', context } },
          },
          { id: 'label', component: 'Text', text: 'Go' },
        ],
        onAction: (action: A2uiAction) => actions.push(action),
      },
    });
    await flush();

    await fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    expect(Reflect.get(actions[0]?.context ?? {}, 'admin')).toBeUndefined();
    expect(Object.getPrototypeOf(actions[0]?.context)).toBe(Object.prototype);
    expect(actions[0]?.context).toEqual({ item: 'x' });
  });

  test('a DateTimeInput without a label is named, and a CheckBox trigger is not nested in a button', async () => {
    const { container } = render(A2uiSurface, {
      props: {
        surfaceId: 'names-2',
        components: [
          { id: 'root', component: 'Column', children: ['when', 'modal'] },
          { id: 'when', component: 'DateTimeInput', enableDate: true, enableTime: true, value: '' },
          { id: 'modal', component: 'Modal', trigger: 'agree', content: 'body' },
          { id: 'agree', component: 'CheckBox', label: 'Agree', value: false },
          { id: 'body', component: 'Text', text: 'Terms' },
        ],
      },
    });
    await flush();

    expect(screen.getAllByLabelText('Date and time').length).toBeGreaterThan(0);
    expect(container.querySelector('button input, button [role="checkbox"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open' })).not.toBeNull();
  });

  test('an Icon modal trigger is named, and a repeated ChoicePicker value renders once', async () => {
    const diagnostics: A2uiDiagnostic[] = [];
    const { container } = render(A2uiSurface, {
      props: {
        surfaceId: 'names-3',
        components: [
          { id: 'root', component: 'Column', children: ['modal', 'pick'] },
          { id: 'modal', component: 'Modal', trigger: 'help', content: 'body' },
          { id: 'help', component: 'Icon', name: 'search' },
          { id: 'body', component: 'Text', text: 'Help' },
          {
            id: 'pick',
            component: 'ChoicePicker',
            variant: 'multipleSelection',
            options: [
              { label: 'One', value: 'one' },
              { label: 'Again', value: 'one' },
            ],
            value: [],
          },
        ],
        onDiagnostic: (diagnostic: A2uiDiagnostic) => diagnostics.push(diagnostic),
      },
    });
    await flush();

    expect(screen.getByRole('button', { name: 'Search' })).not.toBeNull();
    expect(container.querySelectorAll('[data-a2ui-id="pick"] input[type="checkbox"]')).toHaveLength(
      1,
    );
    expect(diagnostics.some((entry) => entry.message.includes('listed more than once'))).toBe(true);
  });

  test('accessibility metadata names and describes a component over inferred fallbacks', async () => {
    render(A2uiSurface, {
      props: {
        surfaceId: 'accessibility',
        components: [
          { id: 'root', component: 'Column', children: ['add', 'email', 'logo'] },
          {
            id: 'add',
            component: 'Button',
            child: 'add-icon',
            action: { event: { name: 'add' } },
            accessibility: { label: { path: '/addLabel' }, description: 'Adds this product' },
          },
          { id: 'add-icon', component: 'Icon', name: 'add' },
          {
            id: 'email',
            component: 'TextField',
            label: 'Email',
            value: '',
            accessibility: { description: 'We never share it' },
          },
          {
            id: 'logo',
            component: 'Icon',
            name: 'search',
            accessibility: { label: 'Favorite' },
          },
        ],
        dataModel: { addLabel: 'Add item' },
      },
    });
    await flush();

    const add = screen.getByRole('button', { name: 'Add item' });
    expect(add.getAttribute('aria-describedby')).not.toBeNull();
    expect(document.getElementById(add.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Adds this product',
    );
    const email = screen.getByRole('textbox', { name: 'Email' });
    const described = (email.getAttribute('aria-describedby') ?? '').split(' ');
    expect(described.map((id) => document.getElementById(id)?.textContent)).toContain(
      'We never share it',
    );
    expect(screen.getByRole('img', { name: 'Favorite' })).not.toBeNull();
  });

  test('an empty label still names its control, and an inherited icon name renders nothing', async () => {
    const diagnostics: A2uiDiagnostic[] = [];
    const { container } = render(A2uiSurface, {
      props: {
        surfaceId: 'unnamed',
        components: [
          { id: 'root', component: 'Column', children: ['done', 'note', 'odd'] },
          { id: 'done', component: 'CheckBox', label: '', value: false },
          { id: 'note', component: 'TextField', label: '', value: '' },
          { id: 'odd', component: 'Icon', name: '__defineGetter__' },
        ],
        onDiagnostic: (diagnostic: A2uiDiagnostic) => diagnostics.push(diagnostic),
      },
    });
    await flush();

    expect(screen.getByRole('checkbox', { name: 'Checkbox' })).not.toBeNull();
    expect(screen.getByRole('textbox', { name: 'Text' })).not.toBeNull();
    expect(container.querySelector('[data-a2ui-id="odd"] svg')).toBeNull();
    expect(diagnostics.some((entry) => entry.code === 'unknown-icon')).toBe(true);
  });

  test('a new surfaceId starts from a fresh data model', async () => {
    const components = [
      { id: 'root', component: 'Column', children: ['name', 'echo'] },
      { id: 'name', component: 'TextField', label: 'Name', value: { path: '/name' } },
      { id: 'echo', component: 'Text', text: { path: '/name' }, variant: 'h2' },
    ];
    const { container, rerender } = render(A2uiSurface, {
      props: { surfaceId: 'first', components },
    });
    await flush();
    await fireEvent.input(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Ada' },
    });
    await flush();
    expect(container.querySelector('[data-a2ui-id="echo"]')?.textContent).toBe('Ada');

    await rerender({ surfaceId: 'second', components });
    await flush();

    expect(container.querySelector('[data-a2ui-id="echo"]')?.textContent).toBe('');
  });

  test('a wrapped Modal trigger with no text of its own is still named', async () => {
    render(A2uiSurface, {
      props: {
        surfaceId: 'unnamed-trigger',
        components: [
          { id: 'root', component: 'Column', children: ['modal'] },
          { id: 'modal', component: 'Modal', trigger: 'blank', content: 'body' },
          { id: 'blank', component: 'Text', text: '' },
          { id: 'body', component: 'Text', text: 'Details' },
        ],
      },
    });
    await flush();

    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    await fireEvent.click(trigger);
    await flush();
    expect(screen.getByRole('dialog', { name: 'Dialog' })).not.toBeNull();
  });

  test('a Modal trigger Button with a failing check stays disabled', async () => {
    render(A2uiSurface, {
      props: {
        surfaceId: 'checked-trigger',
        components: [
          { id: 'root', component: 'Column', children: ['modal'] },
          { id: 'modal', component: 'Modal', trigger: 'open', content: 'body' },
          {
            id: 'open',
            component: 'Button',
            child: 'open-text',
            action: { event: { name: 'open' } },
            checks: [{ condition: false, message: 'Fill in the form first' }],
          },
          { id: 'open-text', component: 'Text', text: 'Review' },
          { id: 'body', component: 'Text', text: 'Details' },
        ],
      },
    });
    await flush();

    expect(screen.getByRole('button', { name: 'Review' }).hasAttribute('disabled')).toBe(true);
  });

  test('malformed options and tabs are skipped, and a Button never wraps another control', async () => {
    const actions: A2uiAction[] = [];
    const diagnostics: A2uiDiagnostic[] = [];
    const { container } = render(A2uiSurface, {
      props: {
        surfaceId: 'malformed',
        components: [
          { id: 'root', component: 'Column', children: ['pick', 'tabs', 'outer'] },
          {
            id: 'pick',
            component: 'ChoicePicker',
            label: 'Pick',
            options: [null, { label: 'One', value: 'one' }],
            value: [],
          },
          { id: 'tabs', component: 'Tabs', tabs: [null, { title: 'First', child: 'first' }] },
          { id: 'first', component: 'Text', text: 'First tab' },
          {
            id: 'outer',
            component: 'Button',
            child: 'row',
            action: { event: { name: 'outer' } },
          },
          { id: 'row', component: 'Row', children: ['inner'] },
          {
            id: 'inner',
            component: 'Button',
            child: 'inner-text',
            action: { event: { name: 'inner' } },
          },
          { id: 'inner-text', component: 'Text', text: 'Inner' },
        ],
        onAction: (action: A2uiAction) => actions.push(action),
        onDiagnostic: (diagnostic: A2uiDiagnostic) => diagnostics.push(diagnostic),
      },
    });
    await flush();

    expect(screen.getByRole('tab', { name: 'First' })).not.toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Inner' }));
    await flush();
    expect(actions.map((action) => action.name)).toEqual(['inner']);
    expect(container.querySelectorAll('button button')).toHaveLength(0);
    expect(diagnostics.some((entry) => entry.message.includes('interactive'))).toBe(true);
  });

  test('a Modal whose Button trigger holds a control can still be opened', async () => {
    render(A2uiSurface, {
      props: {
        surfaceId: 'nested-trigger',
        components: [
          { id: 'root', component: 'Column', children: ['modal'] },
          { id: 'modal', component: 'Modal', trigger: 'open', content: 'body' },
          { id: 'open', component: 'Button', child: 'agree', action: { event: { name: 'x' } } },
          { id: 'agree', component: 'CheckBox', label: 'Agree', value: false },
          { id: 'body', component: 'Text', text: 'Details', variant: 'h2' },
        ],
      },
    });
    await flush();

    await fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await flush();
    expect(screen.getByRole('dialog')).not.toBeNull();
  });

  test('a Button never wraps a media player, and a Modal is described by its description', async () => {
    const { container } = render(A2uiSurface, {
      props: {
        surfaceId: 'players',
        components: [
          { id: 'root', component: 'Column', children: ['play', 'modal'] },
          { id: 'play', component: 'Button', child: 'clip', action: { event: { name: 'x' } } },
          { id: 'clip', component: 'AudioPlayer', url: 'https://example.test/a.mp3' },
          {
            id: 'modal',
            component: 'Modal',
            trigger: 'more',
            content: 'body',
            accessibility: { description: 'Read before you continue' },
          },
          { id: 'more', component: 'Text', text: 'More' },
          { id: 'body', component: 'Text', text: 'Details', variant: 'h2' },
        ],
      },
    });
    await flush();

    expect(container.querySelector('[data-a2ui-id="play"] > button')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'More' }));
    await flush();
    const dialog = screen.getByRole('dialog');
    const described = (dialog.getAttribute('aria-describedby') ?? '').split(' ');
    expect(described.map((id) => document.getElementById(id)?.textContent)).toContain(
      'Read before you continue',
    );
  });

  test('a malformed component record is skipped and reported, and a checked dropped trigger stays disabled', async () => {
    const diagnostics: A2uiDiagnostic[] = [];
    render(A2uiSurface, {
      props: {
        surfaceId: 'boundary',
        components: [
          // A JSON-parsed message can hold anything; the surface must survive it.
          JSON.parse('null') as A2uiComponent,
          { id: 'root', component: 'Column', children: ['modal'] },
          { id: 'modal', component: 'Modal', trigger: 'open', content: 'body' },
          {
            id: 'open',
            component: 'Button',
            child: 'agree',
            action: { event: { name: 'x' } },
            checks: [{ condition: false, message: 'Not yet' }],
          },
          { id: 'agree', component: 'CheckBox', label: 'Agree', value: false },
          { id: 'body', component: 'Text', text: 'Details', variant: 'h2' },
        ],
        onDiagnostic: (diagnostic: A2uiDiagnostic) => diagnostics.push(diagnostic),
      },
    });
    await flush();

    expect(diagnostics.some((entry) => entry.message.startsWith('components[0]'))).toBe(true);
    expect(screen.getByRole('button', { name: 'Open' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('control fixes', () => {
  test('a ChoicePicker option with an empty value is reported and not offered', async () => {
    const diagnostics: A2uiDiagnostic[] = [];
    const { container } = render(A2uiSurface, {
      props: {
        surfaceId: 'empty-option',
        components: [
          {
            id: 'root',
            component: 'ChoicePicker',
            label: 'Size',
            options: [
              { label: 'None', value: '' },
              { label: 'Small', value: 's' },
            ],
            value: { path: '/size' },
          },
        ],
        dataModel: { size: [] },
        onDiagnostic: (diagnostic: A2uiDiagnostic) => diagnostics.push(diagnostic),
      },
    });
    await flush();

    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(1);
    expect(screen.queryByLabelText('None')).toBeNull();
    expect(diagnostics.some((entry) => entry.message.includes('empty value'))).toBe(true);
  });

  test('a Slider over a fractional range steps by a fraction of it', async () => {
    const changes: A2uiJsonValue[] = [];
    render(A2uiSurface, {
      props: {
        surfaceId: 'fraction',
        components: [
          {
            id: 'root',
            component: 'Slider',
            label: 'Opacity',
            min: 0,
            max: 1,
            value: { path: '/opacity' },
          },
        ],
        dataModel: { opacity: 0.5 },
        onDataModelChange: (model: A2uiJsonValue) => changes.push(model),
      },
    });
    await flush();
    const slider = screen.getByRole('slider', { name: /Opacity/ });
    expect(slider.getAttribute('aria-valuenow')).toBe('0.5');

    await fireEvent.keyDown(slider, { key: 'ArrowRight' });
    await flush();

    expect(changes.at(-1)).toEqual({ opacity: 0.51 });
  });

  test('a number TextField writes its bound path as the user types', async () => {
    const changes: A2uiJsonValue[] = [];
    render(A2uiSurface, {
      props: {
        surfaceId: 'typing',
        components: [
          {
            id: 'root',
            component: 'TextField',
            label: 'Count',
            variant: 'number',
            value: { path: '/count' },
          },
        ],
        dataModel: { count: '1' },
        onDataModelChange: (model: A2uiJsonValue) => changes.push(model),
      },
    });
    await flush();
    const field = screen.getByRole('spinbutton', { name: /Count/ }) as HTMLInputElement;

    await fireEvent.focus(field);
    await fireEvent.input(field, { target: { value: '42' } });
    await flush();

    expect(changes.at(-1)).toEqual({ count: '42' });
    expect(field.value).toBe('42');
  });

  test('a time-only DateTimeInput enforces its min and max', async () => {
    const components = (value: string): A2uiComponent[] => [
      {
        id: 'root',
        component: 'DateTimeInput',
        label: 'Start',
        enableTime: true,
        min: '09:00',
        max: '17:00',
        value,
      },
    ];
    const view = render(A2uiSurface, {
      props: { surfaceId: 'time-range', components: components('08:30') },
    });
    await flush();
    expect(screen.getByLabelText('Start').getAttribute('aria-invalid')).toBe('true');

    await view.rerender({ components: components('12:00') });
    await flush();
    expect(screen.getByLabelText('Start').getAttribute('aria-invalid')).not.toBe('true');

    await view.rerender({ components: components('17:30') });
    await flush();
    expect(screen.getByLabelText('Start').getAttribute('aria-invalid')).toBe('true');
  });

  test('a server update that removes the selected tab selects the first', async () => {
    const tabs = (count: number): A2uiComponent[] => [
      {
        id: 'root',
        component: 'Tabs',
        tabs: Array.from({ length: count }, (_entry, index) => ({
          title: `Tab ${index + 1}`,
          child: `panel-${index + 1}`,
        })),
      },
      ...Array.from({ length: count }, (_entry, index): A2uiComponent => ({
        id: `panel-${index + 1}`,
        component: 'Text',
        text: `Panel ${index + 1}`,
        variant: 'h2',
      })),
    ];
    const view = render(A2uiSurface, { props: { surfaceId: 'tabs', components: tabs(3) } });
    await flush();
    await fireEvent.click(screen.getByRole('tab', { name: 'Tab 3' }));
    await flush();
    expect(screen.getByRole('tab', { name: 'Tab 3' }).getAttribute('aria-selected')).toBe('true');

    await view.rerender({ components: tabs(2) });
    await flush();

    expect(screen.getByRole('tab', { name: 'Tab 1' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Panel 1')).not.toBeNull();
  });

  test('a DateTimeInput shows a zoned value in the surface’s time zone', async () => {
    const components: A2uiComponent[] = [
      {
        id: 'root',
        component: 'DateTimeInput',
        label: 'When',
        enableDate: true,
        enableTime: true,
        value: '2025-12-15T17:00:00Z',
      },
    ];
    const view = render(A2uiSurface, {
      props: { surfaceId: 'zoned', components, timeZone: 'Asia/Tokyo' },
    });
    await flush();
    expect((screen.getByLabelText('When') as HTMLInputElement).value).toBe('2025-12-16T02:00');

    view.unmount();
    const original = process.env['TZ'];
    process.env['TZ'] = 'America/Los_Angeles';
    try {
      // Without a zone from the host, the mounted surface shows the runtime's.
      render(A2uiSurface, { props: { surfaceId: 'runtime', components } });
      await flush();
      expect((screen.getByLabelText('When') as HTMLInputElement).value).toBe('2025-12-15T09:00');
    } finally {
      if (original === undefined) delete process.env['TZ'];
      else process.env['TZ'] = original;
    }
  });
});
