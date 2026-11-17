/**
 * The runtime of the design system's `components/bundle.js`, which assigns `window.Cinder`.
 *
 * Every component is exposed twice over: `Cinder.<Export>` is a React component, for a design
 * canvas that mounts it with `<x-import component-from-global-scope="Cinder.Button">`, and
 * `Cinder.mount(name, target, props, children)` mounts one into a DOM element without React. The
 * canvas supplies React 18 as `window.React` and `window.ReactDOM`; the bundle carries no React of
 * its own and reads those globals only when a React component renders.
 *
 * Props update in place: they live in reactive state, so a new prop value re-renders the mounted
 * component rather than mounting it again, and its internal state survives.
 */

import { flushSync, mount, unmount, type Component } from 'svelte';

import { contextsFor, type FillChildren } from './bundle-host.ts';
import BundleRoot from './bundle-root.svelte';

/** A component the bundle exposes, as its module exports it. */
export type CinderComponent = Component<Record<string, unknown>>;

/** A component whose module the bundle loads on its first mount, keeping heavy code off start-up. */
export type LazyCinderComponent = { load: () => Promise<CinderComponent> };

/** What the bundle registers under each export name. */
export type CinderEntry = CinderComponent | LazyCinderComponent;

/** A component's `children`: text, a DOM node, or a function that fills the children host. */
export type CinderChildren = string | Node | FillChildren;

/** A mounted component. */
export type MountedCinder = {
  /** Replaces the component's props in place; a prop missing from `next` is removed. */
  update(next: Record<string, unknown>): void;
  /** Unmounts the component. */
  destroy(): void;
};

/** The `window.Cinder` global: a React component per export name, and a plain DOM mount. */
export type CinderGlobal = {
  [exportName: string]: unknown;
  /** Every exposed export name, in manifest order. */
  readonly componentNames: readonly string[];
  /** Mounts the component named `name` into `target` without React. */
  mount(
    name: string,
    target: Element,
    props?: Record<string, unknown>,
    children?: CinderChildren,
  ): MountedCinder;
};

/** The global names `createCinderGlobal` keeps for itself, which no component may take. */
const RESERVED_NAMES = new Set(['componentNames', 'mount']);

function fillFor(children: CinderChildren | undefined): FillChildren | undefined {
  if (children === undefined || typeof children === 'function') return children;
  return (host) => {
    const node = typeof children === 'string' ? document.createTextNode(children) : children;
    host.append(node);
    return () => node.parentNode?.removeChild(node);
  };
}

/**
 * Mounts a component into `target` with `props`, and with `children` rendered into a children
 * host when given. A target inside another bundled component's children joins that component's
 * Svelte context. The mount is flushed before this returns, so the DOM is complete.
 */
export function mountCinder(
  component: CinderComponent,
  target: Element,
  props: Record<string, unknown>,
  children?: CinderChildren,
): MountedCinder {
  const live = $state<Record<string, unknown>>({ ...props });
  const last = new Map(Object.entries(props));
  const options = { target, props: { component, props: live, fill: fillFor(children) } };
  const context = contextsFor(target);
  const instance =
    context === undefined ? mount(BundleRoot, options) : mount(BundleRoot, { ...options, context });
  flushSync();
  return {
    update(next) {
      for (const key of last.keys()) {
        if (Object.hasOwn(next, key)) continue;
        last.delete(key);
        Reflect.deleteProperty(live, key);
      }
      for (const [key, value] of Object.entries(next)) {
        if (last.has(key) && Object.is(last.get(key), value)) continue;
        last.set(key, value);
        live[key] = value;
      }
      flushSync();
    },
    destroy() {
      void unmount(instance);
    },
  };
}

/** Wraps a loader as a lazy component that loads its module once, on its first mount. */
export function lazyComponent(load: () => Promise<CinderComponent>): LazyCinderComponent {
  let loading: Promise<CinderComponent> | undefined;
  return { load: () => (loading ??= load()) };
}

/** Whether a value is something the bundle can register: a component or a lazy one. */
export function isCinderEntry(value: unknown): value is CinderEntry {
  if (typeof value === 'function') return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    'load' in value &&
    typeof value.load === 'function'
  );
}

/**
 * Mounts a registered entry. A lazy entry mounts once its module loads; updates made before then
 * are kept for the mount, and one destroyed before then never mounts. A module that fails to
 * load leaves a line of text in `target` and reports the error.
 */
export function mountEntry(
  entry: CinderEntry,
  target: Element,
  props: Record<string, unknown>,
  children?: CinderChildren,
): MountedCinder {
  if (typeof entry === 'function') return mountCinder(entry, target, props, children);
  let mounted: MountedCinder | undefined;
  let pending = props;
  let destroyed = false;
  void entry.load().then(
    (component) => {
      if (!destroyed) mounted = mountCinder(component, target, pending, children);
      return undefined;
    },
    (error: unknown) => {
      if (destroyed) return;
      target.textContent = 'This component could not load.';
      reportError(error);
    },
  );
  return {
    update(next) {
      if (mounted === undefined) pending = next;
      else mounted.update(next);
    },
    destroy() {
      destroyed = true;
      mounted?.destroy();
    },
  };
}

type ReactReference<T> = { current: T };

/** The parts of React 18 the canvas wrapper uses. */
type ReactGlobal = {
  createElement(
    type: string,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown;
  useRef<T>(initial: T): ReactReference<T>;
  useState<T>(initial: T): [T, (next: T | ((current: T) => T)) => void];
  useLayoutEffect(effect: () => (() => void) | undefined, dependencies?: unknown[]): void;
};

/** The part of ReactDOM 18 the canvas wrapper uses. */
type ReactDomGlobal = { createPortal(children: unknown, container: Element): unknown };

function reactGlobals(): { React: ReactGlobal; ReactDOM: ReactDomGlobal } {
  const scope = globalThis as unknown as { React?: ReactGlobal; ReactDOM?: ReactDomGlobal };
  if (scope.React === undefined || scope.ReactDOM === undefined) {
    throw new Error('Cinder components need window.React and window.ReactDOM (React 18).');
  }
  return { React: scope.React, ReactDOM: scope.ReactDOM };
}

function hasContent(children: unknown): boolean {
  return children !== undefined && children !== null && children !== false;
}

/**
 * A React component that mounts `entry` into a `display: contents` element and portals its React
 * `children` into the component's children host. Its props reach the Svelte component as they
 * are, so callbacks are props such as `onclick`; React elements passed as other props are not
 * rendered.
 */
export function reactComponent(
  name: string,
  entry: CinderEntry,
): (props: Record<string, unknown>) => unknown {
  function CinderReactComponent(allProps: Record<string, unknown>): unknown {
    const { React, ReactDOM } = reactGlobals();
    const { children, ...props } = allProps;
    const withChildren = hasContent(children);
    const element = React.useRef<HTMLElement | null>(null);
    const mounted = React.useRef<MountedCinder | null>(null);
    const [childHost, setChildHost] = React.useState<HTMLElement | null>(null);

    React.useLayoutEffect(() => {
      const target = element.current;
      if (target === null) return undefined;
      const fill: FillChildren | undefined = withChildren
        ? (host) => {
            setChildHost(host);
            return () => setChildHost((current) => (current === host ? null : current));
          }
        : undefined;
      const instance = mountEntry(entry, target, props, fill);
      mounted.current = instance;
      return () => {
        instance.destroy();
        mounted.current = null;
      };
      // The component mounts again only when it gains or loses children; props update in place.
    }, [withChildren]);

    React.useLayoutEffect(() => {
      mounted.current?.update(props);
      return undefined;
    });

    return React.createElement(
      'div',
      { ref: element, style: { display: 'contents' }, 'data-cinder-component': name },
      withChildren && childHost !== null ? ReactDOM.createPortal(children, childHost) : null,
    );
  }
  Object.defineProperty(CinderReactComponent, 'displayName', { value: `Cinder.${name}` });
  return CinderReactComponent;
}

/**
 * Builds the `window.Cinder` global from each export name's component, failing on a value that
 * is not a component (an export the source module does not have) and on a reserved name.
 */
export function createCinderGlobal(entries: Record<string, unknown>): CinderGlobal {
  const registry = new Map<string, CinderEntry>();
  for (const [name, value] of Object.entries(entries)) {
    if (RESERVED_NAMES.has(name)) throw new Error(`Cinder cannot expose a component named ${name}`);
    if (!isCinderEntry(value)) throw new Error(`Cinder has no component export ${name}`);
    registry.set(name, value);
  }
  const cinder: CinderGlobal = {
    componentNames: [...registry.keys()],
    mount(name, target, props = {}, children) {
      const entry = registry.get(name);
      if (entry === undefined) throw new Error(`Cinder has no component ${name}`);
      return mountEntry(entry, target, props, children);
    },
  };
  for (const [name, entry] of registry) cinder[name] = reactComponent(name, entry);
  return cinder;
}
