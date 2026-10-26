/**
 * Compile-time regression test for DatePickerProps' `labelVisible`: it is a boolean prop, like
 * every other labelled control's, and not an arbitrary HTML attribute.
 * svelte-check processes this file; tsc does not (it excludes .svelte imports).
 */
import type { DatePickerProps } from './date-picker.svelte';

const hiddenLabel: DatePickerProps = { id: 'since', label: 'Since', labelVisible: false };

// @ts-expect-error - labelVisible is a boolean
const wrongLabelVisible: DatePickerProps = { id: 'since', labelVisible: 'no' };

void hiddenLabel;
void wrongLabelVisible;
