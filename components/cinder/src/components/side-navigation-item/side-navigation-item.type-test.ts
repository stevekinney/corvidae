/**
 * Compile-time regression tests for SideNavigationItemProps: a button-form row (no `href`) needs
 * `onclick` only while it can be activated. A disabled row never calls its handler, so it takes
 * none; an enabled row, or one whose `disabled` is a plain boolean, still must. svelte-check
 * processes this file; tsc does not (it excludes .svelte imports).
 */
import type { Snippet } from 'svelte';

import type { SideNavigationItemProps } from './side-navigation-item.types.ts';

declare const children: Snippet;
declare const someBoolean: boolean;
const onclick = (_event: MouseEvent): void => {};

// A disabled button-form row needs no handler.
const disabledWithoutHandler: SideNavigationItemProps = { disabled: true, children };

// An enabled button-form row must still take one.
// @ts-expect-error - an enabled button-form row requires onclick
const enabledWithoutHandler: SideNavigationItemProps = { children };
// @ts-expect-error - disabled: false is enabled, so onclick is required
const explicitlyEnabledWithoutHandler: SideNavigationItemProps = { disabled: false, children };

// A plain boolean may be either, so the handler stays required.
const booleanWithHandler: SideNavigationItemProps = { disabled: someBoolean, onclick, children };
// @ts-expect-error - a boolean disabled may be false, so onclick is required
const booleanWithoutHandler: SideNavigationItemProps = { disabled: someBoolean, children };

// The link arm is unchanged.
const link: SideNavigationItemProps = { href: '/workers', children };
const disabledLink: SideNavigationItemProps = { href: '/workers', disabled: true, children };

void disabledWithoutHandler;
void enabledWithoutHandler;
void explicitlyEnabledWithoutHandler;
void booleanWithHandler;
void booleanWithoutHandler;
void link;
void disabledLink;
