/**
 * Exhaustive tests for template placeholder domain logic.
 * DEP-582: Pure functions with no ProseMirror or DOM dependencies.
 * DEP-625: Comprehensive security tests for prototype pollution and XSS prevention.
 */

import { describe, expect, it } from 'bun:test';

import { resolveTemplatePlaceholders } from './template-placeholders.js';

describe('DEP-625: Prototype pollution prevention', () => {
  describe('reserved segment blocking', () => {
    it('blocks __proto__ access', () => {
      const result = resolveTemplatePlaceholders('{{__proto__}}', {});
      expect(result.text).toBe('');
    });

    it('blocks constructor access', () => {
      const result = resolveTemplatePlaceholders('{{constructor}}', {});
      expect(result.text).toBe('');
    });

    it('blocks prototype access', () => {
      const result = resolveTemplatePlaceholders('{{prototype}}', {});
      expect(result.text).toBe('');
    });

    it('blocks nested __proto__ path (user.__proto__.isAdmin)', () => {
      const result = resolveTemplatePlaceholders('{{user.__proto__.isAdmin}}', {
        user: { name: 'Alice' },
      });
      expect(result.text).toBe('');
    });

    it('blocks nested constructor.prototype path', () => {
      const result = resolveTemplatePlaceholders('{{data.constructor.prototype}}', {
        data: { value: 42 },
      });
      expect(result.text).toBe('');
    });

    it('blocks __defineGetter__ access', () => {
      const result = resolveTemplatePlaceholders('{{__defineGetter__}}', {});
      expect(result.text).toBe('');
    });

    it('blocks __defineSetter__ access', () => {
      const result = resolveTemplatePlaceholders('{{__defineSetter__}}', {});
      expect(result.text).toBe('');
    });

    it('blocks __lookupGetter__ access', () => {
      const result = resolveTemplatePlaceholders('{{__lookupGetter__}}', {});
      expect(result.text).toBe('');
    });

    it('blocks __lookupSetter__ access', () => {
      const result = resolveTemplatePlaceholders('{{__lookupSetter__}}', {});
      expect(result.text).toBe('');
    });

    it('blocks hasOwnProperty access', () => {
      const result = resolveTemplatePlaceholders('{{hasOwnProperty}}', {});
      expect(result.text).toBe('');
    });

    it('blocks isPrototypeOf access', () => {
      const result = resolveTemplatePlaceholders('{{isPrototypeOf}}', {});
      expect(result.text).toBe('');
    });

    it('blocks propertyIsEnumerable access', () => {
      const result = resolveTemplatePlaceholders('{{propertyIsEnumerable}}', {});
      expect(result.text).toBe('');
    });

    it('blocks toString access', () => {
      const result = resolveTemplatePlaceholders('{{toString}}', {});
      expect(result.text).toBe('');
    });

    it('blocks toLocaleString access', () => {
      const result = resolveTemplatePlaceholders('{{toLocaleString}}', {});
      expect(result.text).toBe('');
    });

    it('blocks valueOf access', () => {
      const result = resolveTemplatePlaceholders('{{valueOf}}', {});
      expect(result.text).toBe('');
    });
  });

  describe('case-insensitive reserved segment blocking', () => {
    it('blocks __PROTO__ (uppercase)', () => {
      const result = resolveTemplatePlaceholders('{{__PROTO__}}', {});
      expect(result.text).toBe('');
    });

    it('blocks Constructor (mixed case)', () => {
      const result = resolveTemplatePlaceholders('{{Constructor}}', {});
      expect(result.text).toBe('');
    });

    it('blocks PROTOTYPE (uppercase)', () => {
      const result = resolveTemplatePlaceholders('{{PROTOTYPE}}', {});
      expect(result.text).toBe('');
    });

    it('blocks ToStRiNg (mixed case)', () => {
      const result = resolveTemplatePlaceholders('{{ToStRiNg}}', {});
      expect(result.text).toBe('');
    });

    it('blocks nested case-variant path (user.__PROTO__.isAdmin)', () => {
      const result = resolveTemplatePlaceholders('{{user.__PROTO__.isAdmin}}', {
        user: { name: 'Alice' },
      });
      expect(result.text).toBe('');
    });
  });

  describe('dunder property blocking', () => {
    it('blocks any segment starting with __ (custom dunder)', () => {
      const result = resolveTemplatePlaceholders('{{__custom__}}', {});
      expect(result.text).toBe('');
    });

    it('blocks nested path with dunder segment (user.__secret__.data)', () => {
      const result = resolveTemplatePlaceholders('{{user.__secret__.data}}', {
        user: { name: 'Alice' },
      });
      expect(result.text).toBe('');
    });

    it('blocks __proto__ via dunder prefix check', () => {
      const result = resolveTemplatePlaceholders('{{__proto__}}', {});
      expect(result.text).toBe('');
    });

    it('blocks __defineGetter__ via dunder prefix check', () => {
      const result = resolveTemplatePlaceholders('{{__defineGetter__}}', {});
      expect(result.text).toBe('');
    });
  });

  describe('empty segment blocking', () => {
    it('blocks empty segments from double dots (user..name)', () => {
      const result = resolveTemplatePlaceholders('{{user..name}}', {
        user: { name: 'Alice' },
      });
      expect(result.text).toBe('');
    });

    it('blocks leading dot (.user.name)', () => {
      const result = resolveTemplatePlaceholders('{{.user.name}}', {
        user: { name: 'Alice' },
      });
      expect(result.text).toBe('');
    });

    it('blocks trailing dot (user.name.)', () => {
      const result = resolveTemplatePlaceholders('{{user.name.}}', {
        user: { name: 'Alice' },
      });
      expect(result.text).toBe('');
    });

    it('blocks multiple consecutive dots (user...name)', () => {
      const result = resolveTemplatePlaceholders('{{user...name}}', {
        user: { name: 'Alice' },
      });
      expect(result.text).toBe('');
    });
  });

  describe('legitimate paths still resolve', () => {
    it('resolves valid simple path', () => {
      const result = resolveTemplatePlaceholders('{{name}}', { name: 'Alice' });
      expect(result.text).toBe('Alice');
    });

    it('resolves valid nested path', () => {
      const result = resolveTemplatePlaceholders('{{user.name}}', {
        user: { name: 'Alice' },
      });
      expect(result.text).toBe('Alice');
    });

    it('resolves deeply nested path (3+ levels)', () => {
      const result = resolveTemplatePlaceholders('{{a.b.c.d}}', {
        a: { b: { c: { d: 'value' } } },
      });
      expect(result.text).toBe('value');
    });

    it('resolves path with underscores (user_data.field_name)', () => {
      const result = resolveTemplatePlaceholders('{{user_data.field_name}}', {
        user_data: { field_name: 'test' },
      });
      expect(result.text).toBe('test');
    });

    it('resolves path starting with underscore (_private.data)', () => {
      const result = resolveTemplatePlaceholders('{{_private.data}}', {
        _private: { data: 'secret' },
      });
      expect(result.text).toBe('secret');
    });

    it('resolves legitimate single underscore properties', () => {
      const result = resolveTemplatePlaceholders('{{_value}}', { _value: 42 });
      expect(result.text).toBe('42');
    });
  });

  describe('edge cases', () => {
    it('returns empty string for null context with reserved segment', () => {
      const result = resolveTemplatePlaceholders('{{__proto__}}', {});
      expect(result.text).toBe('');
    });

    it('blocks reserved segments even when they exist in data', () => {
      // Even if someone manages to set these keys, they should not resolve
      const maliciousData = Object.create(null);
      maliciousData.constructor = 'evil';
      const result = resolveTemplatePlaceholders('{{constructor}}', maliciousData);
      expect(result.text).toBe('');
    });

    it('blocks reserved segments in complex nested paths', () => {
      const result = resolveTemplatePlaceholders('{{a.b.__proto__.c.d}}', {
        a: { b: { c: { d: 'value' } } },
      });
      expect(result.text).toBe('');
    });

    it('allows properties that contain reserved words but are not exact matches', () => {
      const result = resolveTemplatePlaceholders('{{constructor_id}}', {
        constructor_id: '12345',
      });
      expect(result.text).toBe('12345');
    });

    it('allows properties that end with reserved words', () => {
      const result = resolveTemplatePlaceholders('{{my_constructor}}', {
        my_constructor: 'Builder',
      });
      expect(result.text).toBe('Builder');
    });
  });

  describe('multiple tokens with mixed valid and blocked paths', () => {
    it('resolves valid paths and blocks reserved segments in same template', () => {
      const result = resolveTemplatePlaceholders(
        '{{name}} is {{age}} years old and {{__proto__}} is blocked',
        {
          name: 'Alice',
          age: 30,
        },
      );
      expect(result.text).toBe('Alice is 30 years old and  is blocked');
    });

    it('handles template with all blocked segments', () => {
      const result = resolveTemplatePlaceholders('{{__proto__}} {{constructor}} {{prototype}}', {});
      expect(result.text).toBe('  ');
    });

    it('handles template with all valid segments', () => {
      const result = resolveTemplatePlaceholders('{{a}} {{b}} {{c}}', { a: '1', b: '2', c: '3' });
      expect(result.text).toBe('1 2 3');
    });
  });
});
