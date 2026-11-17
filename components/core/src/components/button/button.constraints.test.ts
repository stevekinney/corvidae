import { describe, expect, it } from 'bun:test';

import { evaluateConstraints, type ConstraintsDocument } from '../../_internal/constraints.ts';
import { invalid, valid } from './button.constraints.fixtures.ts';
import buttonConstraintsJson from './button.constraints.json' with { type: 'json' };

// The authored JSON, typed: its string literals widen to `string` on import.
const buttonConstraints = buttonConstraintsJson as ConstraintsDocument;

describe('button constraints — valid fixtures', () => {
  for (const attributes of valid) {
    it(`produces zero violations for: ${JSON.stringify(attributes)}`, () => {
      const violations = evaluateConstraints(buttonConstraints, attributes);
      expect(violations).toHaveLength(0);
    });
  }
});

describe('button constraints — invalid fixtures', () => {
  for (const { attributes, violates } of invalid) {
    it(`produces a violation containing rule "${violates}" for: ${JSON.stringify(attributes)}`, () => {
      const violations = evaluateConstraints(buttonConstraints, attributes);
      const ruleIds = violations.map((v) => v.rule);
      expect(ruleIds).toContain(violates);
    });
  }
});
