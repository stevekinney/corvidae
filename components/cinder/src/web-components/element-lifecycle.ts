import { createRawSnippet } from 'svelte';
import type { SelectOption } from '../components/select/select.types.ts';

/* Svelte calls extend with the generated element class, which owns mounting and prop accessors. */
export type ElementConstructor<Element extends HTMLElement = HTMLElement> = new () => Element & {
  connectedCallback(): Promise<void>;
  disconnectedCallback(): void;
  attributeChangedCallback(
    name: string,
    previous: string | null,
    next: string | null | undefined,
  ): void;
};

/** Restore optional Svelte prop defaults when their HTML attributes are removed. */
export function withAttributeDefaults(Base: ElementConstructor) {
  return class extends Base {
    override attributeChangedCallback(name: string, previous: string | null, next: string | null) {
      super.attributeChangedCallback(name, previous, next ?? undefined);
    }
  };
}

const connections = new WeakMap<HTMLElement, Promise<void>>();

/** Give the enclosing element time to project authored children before they mount. */
export function withProjectedConnection(Base: ElementConstructor): ElementConstructor {
  return class extends Base {
    #generation = 0;

    override connectedCallback() {
      const connection = this.#connect(++this.#generation);
      connections.set(this, connection);
      return connection;
    }

    async #connect(generation: number) {
      // The parent may be upgraded later in the same registration pass.
      await Promise.resolve();
      for (let ancestor = this.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const connection = connections.get(ancestor);
        if (!connection) continue;
        await connection;
        break;
      }
      if (generation === this.#generation && this.isConnected) await super.connectedCallback();
    }

    override disconnectedCallback() {
      this.#generation += 1;
      super.disconnectedCallback();
    }
  };
}

/** Observe changes to authored children while ignoring the component's rendered subtree. */
export function observeAuthoredChildren<Child extends Element>(
  host: HTMLElement,
  read: () => Child[],
  attributes: string[],
  update: (children: Child[]) => void,
  watchContent = false,
) {
  const observer = new MutationObserver((records) => {
    const children = read();
    if (
      records.some(
        ({ target }) =>
          target === host ||
          children.some((child) => child === target || (watchContent && child.contains(target))),
      )
    )
      update(children);
  });
  observer.observe(host, {
    childList: true,
    subtree: true,
    characterData: watchContent,
    attributes: true,
    attributeFilter: attributes,
  });
  return () => observer.disconnect();
}

/** Project an authored DOM node into the compound component without cloning its contents. */
export function projectAuthoredChild(child: Element) {
  return createRawSnippet(() => ({
    render: () => '<slot></slot>',
    setup: (slot) => {
      if (slot instanceof HTMLSlotElement) slot.assign(child);
    },
  }));
}

function authoredOptions(element: HTMLElement): HTMLOptionElement[] {
  return Array.from(element.querySelectorAll<HTMLOptionElement>(':scope > option'));
}

type NativeSelectHost = HTMLElement & { value?: string | undefined; options: SelectOption[] };

/** Read authored options and synchronize native form reset with the compiled select. */
export function withNativeSelect(
  Base: ElementConstructor<NativeSelectHost>,
): ElementConstructor<NativeSelectHost> {
  return class extends Base {
    #connection: AbortController | undefined;
    #stopObserving: (() => void) | undefined;
    #hadAuthoredOptions = false;

    #setOptions(options: HTMLOptionElement[]) {
      if (options.length === 0 && !this.#hadAuthoredOptions) return;
      this.#hadAuthoredOptions = options.length > 0;
      this.options = options.map(({ value, label, disabled }) => ({ value, label, disabled }));
    }

    #defaultValue() {
      return (
        this.getAttribute('value') ??
        authoredOptions(this).findLast((option) => option.defaultSelected)?.value
      );
    }

    override async connectedCallback() {
      const connection = new AbortController();
      this.#connection?.abort();
      this.#connection = connection;
      // An upgraded host can be connected before its option children are parsed.
      await Promise.resolve();
      if (connection.signal.aborted) return;
      this.#setOptions(authoredOptions(this));
      if (this.value === undefined) this.value = this.#defaultValue();
      await super.connectedCallback();
      if (connection.signal.aborted) return;

      this.#stopObserving = observeAuthoredChildren(
        this,
        () => authoredOptions(this),
        ['value', 'label', 'disabled'],
        (options) => this.#setOptions(options),
        true,
      );

      this.ownerDocument.addEventListener(
        'reset',
        (event) => {
          const control = this.querySelector('select');
          if (!control || event.target !== control.form) return;
          queueMicrotask(() => {
            if (event.defaultPrevented || connection.signal.aborted) return;
            const initialValue = this.#defaultValue();
            if (initialValue !== undefined) control.value = initialValue;
            this.value = control.selectedIndex === -1 ? undefined : control.value;
          });
        },
        { capture: true, signal: connection.signal },
      );

      const control = this.querySelector('select');
      if (this.value === undefined && control && control.selectedIndex !== -1) {
        this.value = control.value;
      }
    }

    override disconnectedCallback() {
      this.#connection?.abort();
      this.#stopObserving?.();
      super.disconnectedCallback();
    }
  };
}
