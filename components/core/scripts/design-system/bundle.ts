/**
 * Plans the design system's `components/bundle.js`: one classic script that assigns
 * `window.Cinder`, with a React component per export name for a design canvas to mount. The
 * runtime it bundles is `bundle-runtime.svelte.ts`; `bundle-build.ts` builds it.
 */

import { escapePreviewScript } from './previews.ts';

/** The global the bundle assigns, and the design system's `namespace`. */
export const BUNDLE_NAMESPACE = 'Cinder';
/** The largest bundle the design system accepts: a file kept in files may be 15 MiB. */
export const BUNDLE_SCRIPT_CAP = 15 * 1024 * 1024;

/** One module whose components the bundle exposes. */
export type BundleSource = {
  /** The absolute path of the module that exports every component in `names`. */
  entry: string;
  /** The export names to expose, in manifest order. */
  names: string[];
  /** Whether the module loads on a component's first mount rather than when the bundle runs. */
  lazy: boolean;
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The source of the bundle's entry module: it imports each eager source, defers each lazy one
 * behind `import()`, and assigns the global from every export name. Bundled as one script, a lazy
 * source's code is inlined but not evaluated until a component from it first mounts.
 */
export function bundleEntrySource(
  runtime: string,
  sources: BundleSource[],
  namespace: string = BUNDLE_NAMESPACE,
): string {
  if (!IDENTIFIER.test(namespace)) throw new Error(`bad bundle namespace ${namespace}`);
  const imports = [`import { createCinderGlobal, lazyComponent } from ${JSON.stringify(runtime)};`];
  const loaders: string[] = [];
  const members: string[] = [];
  sources.forEach((source, index) => {
    const binding = `source${index}`;
    if (source.lazy) {
      loaders.push(`const ${binding} = () => import(${JSON.stringify(source.entry)});`);
    } else {
      imports.push(`import * as ${binding} from ${JSON.stringify(source.entry)};`);
    }
    for (const name of source.names) {
      if (!IDENTIFIER.test(name)) throw new Error(`bad export name ${name}`);
      const key = JSON.stringify(name);
      members.push(
        source.lazy
          ? `  ${key}: lazyComponent(() => ${binding}().then((module) => module[${key}])),`
          : `  ${key}: ${binding}[${key}],`,
      );
    }
  });
  return [
    ...imports,
    ...loaders,
    `window.${namespace} = createCinderGlobal({`,
    ...members,
    '});',
    '',
  ].join('\n');
}

/**
 * The bundle's first line, which tells the design system its namespace and its components in
 * order.
 */
export function bundleHeader(names: string[], namespace: string = BUNDLE_NAMESPACE): string {
  const header = { format: 4, namespace, components: names.map((name) => ({ name })) };
  return `/* @ds-bundle: ${JSON.stringify(header)} */\n`;
}

/**
 * The published bundle: the header, then the built script with the sequences escaped that would
 * end or open markup when a consumer inlines it. Fails when it is over {@link BUNDLE_SCRIPT_CAP}.
 */
export function finishBundle(
  code: string,
  names: string[],
  namespace: string = BUNDLE_NAMESPACE,
): string {
  const script = bundleHeader(names, namespace) + escapePreviewScript(code);
  const bytes = Buffer.byteLength(script);
  if (bytes > BUNDLE_SCRIPT_CAP) {
    throw new Error(`bundle.js is ${bytes} bytes, over the ${BUNDLE_SCRIPT_CAP}-byte cap`);
  }
  return script;
}
