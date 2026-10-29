/**
 * AB-64 — the provider-neutral model alias registry.
 *
 * Covers, for each of the three shipped providers (Anthropic, OpenAI, Gemini):
 *   - Every model alias resolves to its documented concrete model ID.
 *   - Full provider-native IDs pass through untouched.
 *   - `'inherit'` is never resolved (caller-side concern).
 *
 * The effort tiers, and the alias actually reaching the request, are provider behavior and live in
 * `test/<provider>/effort-model-aliases.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import {
  ANTHROPIC_MODEL_ALIASES,
  GEMINI_MODEL_ALIASES,
  OPENAI_MODEL_ALIASES,
  resolveAnthropicModel,
  resolveGeminiModel,
  resolveOpenAIModel,
} from '../src/providers/shared/model-registry.ts';

// ── Model alias registry ────────────────────────────────────────────

describe('model alias registry — Anthropic', () => {
  it.each(Object.entries(ANTHROPIC_MODEL_ALIASES))('resolves alias %s to %s', (alias, expected) => {
    expect(resolveAnthropicModel(alias)).toBe(expected);
  });

  it('passes a full provider-native ID through unchanged', () => {
    expect(resolveAnthropicModel('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(resolveAnthropicModel('claude-sonnet-4-6-20251114')).toBe('claude-sonnet-4-6-20251114');
  });

  it('never resolves the inherit alias — caller-side concern', () => {
    expect(resolveAnthropicModel('inherit')).toBe('inherit');
  });
});

describe('model alias registry — OpenAI', () => {
  it.each(Object.entries(OPENAI_MODEL_ALIASES))('resolves alias %s to %s', (alias, expected) => {
    expect(resolveOpenAIModel(alias)).toBe(expected);
  });

  it('passes a full provider-native ID through unchanged', () => {
    expect(resolveOpenAIModel('gpt-4o')).toBe('gpt-4o');
  });

  it('never resolves the inherit alias — caller-side concern', () => {
    expect(resolveOpenAIModel('inherit')).toBe('inherit');
  });
});

describe('model alias registry — Gemini', () => {
  it.each(Object.entries(GEMINI_MODEL_ALIASES))('resolves alias %s to %s', (alias, expected) => {
    expect(resolveGeminiModel(alias)).toBe(expected);
  });

  it('passes a full provider-native ID through unchanged', () => {
    expect(resolveGeminiModel('gemini-2.5-pro')).toBe('gemini-2.5-pro');
  });

  it('never resolves the inherit alias — caller-side concern', () => {
    expect(resolveGeminiModel('inherit')).toBe('inherit');
  });
});
