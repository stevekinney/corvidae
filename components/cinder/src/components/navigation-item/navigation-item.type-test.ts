/**
 * Compile-time regression tests for NavigationItemProps: a button-form item (no `href`) needs
 * `onclick` only while it can be activated. A disabled item never calls its handler, so it takes
 * none; an enabled item, or one whose `disabled` is a plain boolean, still must. svelte-check
 * processes this file; tsc does not (it excludes .svelte imports).
 */
import type { Snippet } from 'svelte';

import type { NavigationItemProps } from './navigation-item.types.ts';

declare const children: Snippet;
declare const someBoolean: boolean;
const onclick = (_event: MouseEvent): void => {};

const disabledWithoutHandler: NavigationItemProps = { disabled: true, children };

// @ts-expect-error - an enabled button-form item requires onclick
const enabledWithoutHandler: NavigationItemProps = { children };
// @ts-expect-error - disabled: false is enabled, so onclick is required
const explicitlyEnabledWithoutHandler: NavigationItemProps = { disabled: false, children };

const booleanWithHandler: NavigationItemProps = { disabled: someBoolean, onclick, children };
// @ts-expect-error - a boolean disabled may be false, so onclick is required
const booleanWithoutHandler: NavigationItemProps = { disabled: someBoolean, children };

const link: NavigationItemProps = { href: '/billing', children };
const disabledLink: NavigationItemProps = { href: '/billing', disabled: true, children };

void disabledWithoutHandler;
void enabledWithoutHandler;
void explicitlyEnabledWithoutHandler;
void booleanWithHandler;
void booleanWithoutHandler;
void link;
void disabledLink;
