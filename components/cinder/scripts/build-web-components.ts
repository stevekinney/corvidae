import { sveltePlugin } from '@lostgradient/testing';
import { relative, resolve } from 'node:path';
import { compile, parse } from 'svelte/compiler';
import { inlineImports } from './design-system/css.ts';
import { ensureCinderGenerated } from './ensure-cinder-generated.ts';
import { observeBrowserBindings } from './web-component-bindings.ts';
import { readWebComponentCatalog, type PropertyOptions } from './web-component-catalog.ts';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'src');
const webComponents = resolve(source, 'web-components');
const lifecycle = resolve(webComponents, 'element-lifecycle.ts');

type CompoundOptions = {
  part: string;
  attributes: Record<string, { attribute: string; boolean?: boolean }>;
};
/** The source component and properties to expose in a browser build. */
export type ElementOptions = {
  propsType: string;
  properties: Record<string, PropertyOptions>;
  extend?: string;
  compound?: CompoundOptions;
  directory?: string;
  stylesheets?: string[];
  hostDisplay?: 'block';
  hiddenChildren?: string[];
  catalog?: boolean;
};

const browserOverrides: Record<string, Partial<ElementOptions>> = {
  select: {
    extend: 'withNativeSelect',
    hostDisplay: 'block',
    hiddenChildren: ['option'],
    properties: { options: { type: 'Array' } },
  },
  accordion: {
    hostDisplay: 'block',
    compound: {
      part: 'accordion-item',
      attributes: {
        title: { attribute: 'heading' },
        disabled: { attribute: 'disabled', boolean: true },
      },
    },
  },
};

async function catalogDefinitions(): Promise<Record<string, ElementOptions>> {
  const catalog = await readWebComponentCatalog(root);
  return Object.fromEntries(
    catalog
      .filter(({ id }) => id !== 'accordion-item')
      .map(({ id, propsType, properties }) => {
        const override = Object.hasOwn(browserOverrides, id) ? browserOverrides[id] : undefined;
        return [
          id,
          {
            propsType,
            catalog: true,
            ...override,
            properties: { ...properties, ...override?.properties },
          },
        ];
      }),
  );
}

function componentFile(
  name: string,
  suffix: string,
  directory = resolve(source, 'components', name),
) {
  return resolve(directory, `${name}.${suffix}`);
}

const publish =
  'cinderPublishBindable={(property, value) => { if (!Object.is(host[property], value)) host[property] = value; }}';

function createCatalogSource(name: string, options: ElementOptions, publishes: boolean) {
  const renderer = resolve(webComponents, 'browser-renderer.svelte.ts');
  const properties = Object.entries(options.properties);
  const slots = properties.flatMap(([property, definition]) =>
    definition.renderer ? [definition.source ?? property] : [],
  );
  const bindings = properties.map(([property, definition]) => {
    const value = `properties[${JSON.stringify(property)}]`;
    return `${JSON.stringify(definition.source ?? property)}: ${
      definition.renderer
        ? `browserContent(${value}, authored.get(${JSON.stringify(definition.source ?? property)}))`
        : value
    }`;
  });
  return `<script lang="ts" module></script>
<script lang="ts">
  import Component from ${JSON.stringify(componentFile(name, 'svelte'))};
  import { browserContent, inheritProjectedContext, readAuthoredContent } from ${JSON.stringify(renderer)};
  let properties = $props();
  const host = $host();
  inheritProjectedContext(host);
  const authored = readAuthoredContent(host, ${JSON.stringify(slots)});
  const input = $derived(Object.fromEntries(
    Object.entries({${bindings.join(',\n')}}).filter(([, value]) => value !== undefined)
  ));
</script>
<Component {...input} ${publishes ? publish : ''} />`;
}

function createCompoundSource(
  name: string,
  { part, attributes }: CompoundOptions,
  publishes: boolean,
) {
  const tag = `cinder-${part}`;
  const properties = Object.entries(attributes).map(([property, { attribute, boolean }]) => {
    const argument = JSON.stringify(attribute);
    const read = boolean ? `hasAttribute(${argument})` : `getAttribute(${argument}) ?? ''`;
    return `${property}={item.element.${read}}`;
  });
  const observed = Object.values(attributes).map(({ attribute }) => attribute);
  const foundation = inlineImports(resolve(source, 'styles/foundation.css'));
  const stylesheet = `@layer cinder.tokens, cinder.foundation, cinder.components, cinder.utilities;
@layer cinder.foundation {
${foundation}
}
${inlineImports(componentFile(name, 'css'))}`;

  // Parts render inside their original Svelte parent, which supplies their context and styles.
  return `<script lang="ts" module></script>
<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import Root from ${JSON.stringify(componentFile(name, 'svelte'))};
  import Part from ${JSON.stringify(componentFile(part, 'svelte'))};
  import { observeAuthoredChildren, projectAuthoredChild } from ${JSON.stringify(lifecycle)};

  const stylesheet = ${JSON.stringify(stylesheet)};
  const properties = $props();
  const host = $host();
  let items = $state.raw<{ element: Element; id: string; content: Snippet }[]>([]);
  let nextId = 0;

  onMount(() => {
    const read = () => Array.from(host.querySelectorAll(':scope > ${tag}'));
    function update(children: Element[]) {
      const previous = new Map(items.map((item) => [item.element, item]));
      items = children.map((element) => ({
        element,
        id: previous.get(element)?.id ?? String(++nextId),
        content: previous.get(element)?.content ?? projectAuthoredChild(element),
      }));
    }

    update(read());
    return observeAuthoredChildren(host, read, ${JSON.stringify(observed)}, update);
  });
</script>

<svelte:element this={'style'}>{stylesheet}</svelte:element>
<Root {...properties} ${publishes ? publish : ''}>
  {#each items as item (item.id)}
    <Part id={item.id} ${properties.join(' ')}>
      {@render item.content()}
    </Part>
  {/each}
</Root>`;
}

function compileElement(path: string, text: string, options: ElementOptions) {
  const module = parse(text, { modern: true }).module;
  if (!module) throw new Error(`Missing module script in ${path}`);
  const extension = options.extend;
  const extensions = [
    'withAttributeDefaults',
    ...(options.catalog ? ['withProjectedConnection'] : []),
    ...(extension ? [extension] : []),
  ];
  const imports = extensions.join(', ');
  const extend = `(base) => ${extensions.reduce((base, helper) => `${helper}(${base})`, 'base')}`;
  const { content } = module;
  if (!('start' in content) || typeof content.start !== 'number')
    throw new Error(`Missing module script source position in ${path}`);
  const { start } = content;
  const component = `${text.slice(0, start)}\nimport { ${imports} } from ${JSON.stringify(lifecycle)};\n${text.slice(start)}`;
  const props = Object.entries(options.properties).map(([name, definition]) => {
    const entries = Object.entries(definition)
      .filter(([field]) => field !== 'source' && field !== 'renderer')
      .map(([field, value]) => `${field}: ${JSON.stringify(value)}`);
    return `${name}: {${entries.join(', ')}}`;
  });
  const shadow = options.compound ? "{mode: 'open', slotAssignment: 'manual'}" : "'none'";
  const compiled = compile(
    `<svelte:options customElement={{ shadow: ${shadow}, props: {${props.join(', ')}}, extend: ${extend} }} />\n${component}`,
    { filename: path, customElement: true },
  );
  // Every prop passed through a rest binding has its own entry in the build configuration.
  const warnings = compiled.warnings.filter(
    (warning) => warning.code !== 'custom_element_props_identifier',
  );
  if (warnings.length) throw new Error(warnings.map((warning) => warning.message).join('\n'));
  return { loader: 'js' as const, contents: compiled.js.code };
}

/** Build the browser module, its declarations and stylesheet, and the example page. */
export async function buildWebComponents(
  outdir = resolve(root, 'dist/web-components'),
  {
    definitions,
    example = resolve(webComponents, 'example.html'),
    exampleEntry,
  }: { definitions?: Record<string, ElementOptions>; example?: string; exampleEntry?: string } = {},
) {
  const entry = resolve(webComponents, 'web-components.ts');
  const sources = new Map<string, string>();
  const inputs = await Promise.all(
    Object.entries(definitions ?? (await catalogDefinitions())).map(async ([name, options]) => {
      const sourcePath = componentFile(name, 'svelte', options.directory);
      const patched = options.catalog
        ? observeBrowserBindings(await Bun.file(sourcePath).text(), options.properties)
        : undefined;
      if (patched !== undefined) sources.set(sourcePath, patched);
      return {
        name,
        options,
        path:
          options.compound || options.catalog
            ? resolve(webComponents, `${name}.generated.svelte`)
            : componentFile(name, 'svelte', options.directory),
        virtualSource: options.compound
          ? createCompoundSource(name, options.compound, patched !== undefined)
          : options.catalog
            ? createCatalogSource(name, options, patched !== undefined)
            : undefined,
      };
    }),
  );
  const byPath = new Map(inputs.map((input) => [input.path, input]));
  const imports = inputs.map(
    ({ path }, index) => `import component${index} from ${JSON.stringify(path)};`,
  );
  const registrations = inputs.flatMap(({ name, options }, index) => [
    `['cinder-${name}', component${index}.element]`,
    ...(options.compound
      ? [`['cinder-${options.compound.part}', class extends HTMLElement {}]`]
      : []),
  ]);
  const registrationModule = `
${imports.join('\n')}
for (const [name, element] of [${registrations.join(', ')}]) {
  if (!element) throw new Error(\`Missing custom element constructor for \${name}\`);
  if (!customElements.get(name)) customElements.define(name, element);
}
`;
  const files = Object.fromEntries([
    [entry, registrationModule],
    ...inputs.flatMap(({ path, virtualSource }) =>
      virtualSource === undefined ? [] : [[path, virtualSource]],
    ),
  ]);
  const importedStylesheets = new Set<string>();
  await Bun.build({
    entrypoints: exampleEntry ? [entry, exampleEntry] : [entry],
    files,
    outdir,
    naming: { entry: '[name].[ext]' },
    target: 'browser',
    format: 'esm',
    splitting: true,
    optimizeImports: ['@lostgradient/cinder'],
    minify: true,
    conditions: ['browser', 'svelte'],
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'cinder-custom-elements',
        setup(builder) {
          builder.onLoad({ filter: /\.css$/ }, ({ path }) => {
            importedStylesheets.add(path);
            return { contents: '', loader: 'js' };
          });
          builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
            const patched = sources.get(path);
            if (patched !== undefined)
              return {
                loader: 'js',
                contents: compile(patched, { filename: path, css: 'injected' }).js.code,
              };
            const input = byPath.get(path);
            if (input === undefined) return undefined;
            const text = input.virtualSource ?? (await Bun.file(path).text());
            return compileElement(path, text, input.options);
          });
        },
      },
      sveltePlugin({ generate: 'client', injectCss: true, development: false }),
    ],
  });
  const declarations = inputs.flatMap(({ name, options }) => {
    const types = relative(outdir, componentFile(name, 'types.ts', options.directory)).replaceAll(
      '\\',
      '/',
    );
    const propsType = `import(${JSON.stringify(types)}).${options.propsType}`;
    const properties = Object.entries(options.properties).map(([key, definition]) => {
      const originalName = JSON.stringify(definition.source ?? key);
      const value = `Prop<${propsType}, ${originalName}>`;
      return `${JSON.stringify(key)}?: ${definition.renderer ? `RenderProp<${value}>` : value}`;
    });
    return [
      `    'cinder-${name}': HTMLElement & { ${properties.join('; ')} };`,
      ...(options.compound ? [`    'cinder-${options.compound.part}': HTMLElement;`] : []),
    ];
  });
  await Bun.write(
    resolve(outdir, 'web-components.d.ts'),
    `import type { Snippet } from 'svelte';\n\ntype Prop<Props, Key> = Props extends unknown ? Key extends keyof Props ? Props[Key] : never : never;\ntype RenderProp<Value> = Value extends Snippet<infer Arguments> ? (...arguments_: Arguments) => Node | string | null | undefined : Value;\n\ndeclare global {\n  interface HTMLElementTagNameMap {\n${declarations.join('\n')}\n  }\n}\n`,
  );
  const stylesheets = [
    resolve(source, 'styles/index.css'),
    ...inputs
      .filter(({ options }) => options.compound === undefined)
      .flatMap(
        ({ name, options }) =>
          options.stylesheets ?? [componentFile(name, 'css', options.directory)],
      ),
    ...[...importedStylesheets].toSorted(),
  ];
  const inlined = new Set<string>();
  const availableStylesheets = await Promise.all(
    stylesheets.map(async (path) => ((await Bun.file(path).exists()) ? path : undefined)),
  );
  const hostRules = inputs.flatMap(({ name, options }) => {
    const tag = `cinder-${name}`;
    return [
      ...(options.hostDisplay
        ? [`  :where(${tag}:not([hidden])) { display: ${options.hostDisplay}; }`]
        : options.catalog
          ? [`  :where(.cinder-browser-content ${tag}:not([hidden])) { display: contents; }`]
          : []),
      ...(options.hiddenChildren ?? []).map(
        (child) => `  :where(${tag}) > ${child} { display: none; }`,
      ),
    ];
  });
  await Bun.write(
    resolve(outdir, 'web-components.css'),
    [
      ...availableStylesheets.flatMap((path) => (path ? [inlineImports(path, inlined)] : [])),
      `@layer cinder.components {\n  :where(.cinder-browser-content) { display: contents; }\n${hostRules.join('\n')}\n}\n`,
    ].join('\n'),
  );
  await Bun.write(resolve(outdir, 'index.html'), Bun.file(example));
}

if (import.meta.main) {
  await ensureCinderGenerated();
  await buildWebComponents();
}
