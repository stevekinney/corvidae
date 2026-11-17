import { describe, expect, it } from 'bun:test';

import { findNeighbourRationaleViolations } from './check-component-inventory.ts';

describe('findNeighbourRationaleViolations', () => {
  const knownComponentIds = new Set(['button', 'new-component']);
  const entry = (rationale: string | undefined) => ({
    id: 'new-component',
    related: [],
    avoidWhen: [],
    ...(rationale === undefined ? {} : { rationale }),
  });

  it('rejects a component with no neighbour rationale', () => {
    const violations = findNeighbourRationaleViolations(entry(undefined), knownComponentIds);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.id).toBe('new-component');
    expect(violations[0]?.reason).toContain('related and avoidWhen');
  });

  it('accepts related and avoidWhen metadata', () => {
    expect(
      findNeighbourRationaleViolations(
        {
          id: 'new-component',
          related: ['button'],
          avoidWhen: [{ reason: 'Use a button instead.' }],
        },
        knownComponentIds,
      ),
    ).toEqual([]);
  });

  it('rejects an unedited avoidWhen scaffold placeholder even with a valid related id', () => {
    expect(
      findNeighbourRationaleViolations(
        {
          id: 'new-component',
          related: ['button'],
          avoidWhen: [{ reason: 'TODO: describe when a different component fits better.' }],
        },
        knownComponentIds,
      ),
    ).toHaveLength(1);
  });

  it('rejects a related id that is not a known component, even with a real avoidWhen', () => {
    expect(
      findNeighbourRationaleViolations(
        {
          id: 'new-component',
          related: ['buton'],
          avoidWhen: [{ reason: 'Use a button instead for simple actions.' }],
        },
        knownComponentIds,
      ),
    ).toHaveLength(1);
  });

  it('rejects a self-reference in related metadata', () => {
    expect(
      findNeighbourRationaleViolations(
        {
          id: 'new-component',
          related: ['new-component'],
          avoidWhen: [{ reason: 'Use something else.' }],
        },
        knownComponentIds,
      ),
    ).toHaveLength(1);
  });

  it('accepts an explicit rationale naming the nearest alternative', () => {
    expect(
      findNeighbourRationaleViolations(
        entry('Nearest alternative: button, which has a different interaction contract.'),
        knownComponentIds,
      ),
    ).toEqual([]);
  });

  // A rationale names its alternative as the component is exported. Lowercasing alone turned
  // `DescriptionList` into `descriptionlist`, an id no component has, so only one-word names
  // (`Badge`) ever matched.
  it('accepts a rationale that names a multi-word alternative by its exported name', () => {
    const named = entry('Nearest alternative: DescriptionList — it shows labelled pairs.');
    expect(
      findNeighbourRationaleViolations(named, new Set(['description-list', 'new-component'])),
    ).toEqual([]);
    expect(
      findNeighbourRationaleViolations(named, new Set(['button', 'new-component'])),
    ).toHaveLength(1);
  });

  it('rejects a rationale that names the component itself, by id or exported name', () => {
    for (const rationale of [
      'Nearest alternative: NewComponent.',
      'Nearest alternative: new-component.',
    ]) {
      expect(findNeighbourRationaleViolations(entry(rationale), knownComponentIds)).toHaveLength(1);
    }
  });

  it('preserves punctuation and emphasis in a rationale', () => {
    expect(
      findNeighbourRationaleViolations(
        entry('Nearest alternative: **button** — use it for emphasis.'),
        knownComponentIds,
      ),
    ).toEqual([]);
  });

  it('rejects an empty explicit alternative marker', () => {
    expect(
      findNeighbourRationaleViolations(entry('Nearest alternative:'), knownComponentIds),
    ).toHaveLength(1);
  });

  it('accepts natural prose that names the nearest alternative, across a wrapped line', () => {
    for (const rationale of [
      'The nearest alternative is button, but it has a different contract.',
      'Nearest alternative: button has a different interaction contract.',
    ]) {
      expect(findNeighbourRationaleViolations(entry(rationale), knownComponentIds)).toEqual([]);
    }
  });

  it('rejects a rationale whose named alternative is not a known component', () => {
    expect(
      findNeighbourRationaleViolations(
        entry('Nearest alternative: buton, which has a different contract.'),
        knownComponentIds,
      ),
    ).toHaveLength(1);
  });

  it('rejects the scaffold placeholder until an author names a known neighbour', () => {
    expect(
      findNeighbourRationaleViolations(
        {
          ...entry('Nearest alternative: TODO — name the nearest component.'),
          avoidWhen: [{ reason: 'TODO: describe when a different component fits better.' }],
        },
        knownComponentIds,
      ),
    ).toHaveLength(1);
  });
});
