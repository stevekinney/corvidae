import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import WorkerInheritanceNote from './worker-inheritance-note.svelte';
import {
  WORKER_INHERITANCE_RULES,
  type WorkerInheritanceSurface,
} from './worker-inheritance-rules.ts';

const SURFACES = Object.keys(WORKER_INHERITANCE_RULES) as WorkerInheritanceSurface[];

describe('WorkerInheritanceNote', () => {
  test.each(SURFACES)('renders the %s rule as a labelled note', (surface) => {
    const { getByRole, container } = render(WorkerInheritanceNote, { props: { surface } });
    const rule = WORKER_INHERITANCE_RULES[surface];
    expect(getByRole('note')).toBeTruthy();
    expect(container.textContent).toContain(rule.heading);
    expect(container.textContent).toContain(rule.text);
  });
});
