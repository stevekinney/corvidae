// E3 — Confirm skills stays a package (runtime behavioral tests)
//
// This file verifies the architectural decision documented in architecture.md
// and plan.md Phase E3: the `skills` package is a coherent subsystem at the
// correct layer of the dependency graph — same layer as `memory`, below
// `operative` and above `bureau`.
//
// The acceptance criterion from plan.md E3:
//   package graph: tool-protocol/cryptography/lifecycle → armorer/conversationalist →
//     operative(+herald subpaths) → memory/skills → bureau → gateway
//
// Runtime tests (this file) verify that the skills package has the correct
// workspace dependencies and no forbidden ones.
//
// Type-level assertions (structural compatibility) live in package-graph.test-d.ts.

import { describe, expect, it } from 'bun:test';

// ── 1. Package Graph Position ─────────────────────────────────────────────────

describe('E3: skills package graph position', () => {
  it('has no forbidden workspace dependencies', async () => {
    // Read the skills package.json from disk to assert its dependency surface.
    const packageJson = (await import('../package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const deps = Object.keys(packageJson.dependencies ?? {});

    // Forbidden workspace dependencies — these would break the layer contract.
    // Skills is at the memory layer: deps are armorer, tool-protocol, cryptography, and
    // lifecycle (the RuntimeServices seam every layer routes reads through
    // per AB-324/AB-326 — same relationship bureau has with lifecycle).
    const forbiddenWorkspaceDeps = [
      '@corvidae/operative', // skills is ABOVE operative's layer
      '@corvidae/memory', // same layer — no intra-layer import
      '@corvidae/conversationalist', // skills is above conversationalist
      '@corvidae/bureau', // bureau is above skills
      'gateway', // gateway is above skills
      'sentinel', // unrelated
      'evaluation', // unrelated
      'integration', // unrelated
    ];

    for (const forbidden of forbiddenWorkspaceDeps) {
      expect(deps).not.toContain(forbidden);
    }
  });

  it('depends on armorer, tool-protocol, cryptography, and lifecycle', async () => {
    const packageJson = (await import('../package.json')) as {
      dependencies?: Record<string, string>;
    };

    const deps = Object.keys(packageJson.dependencies ?? {});

    // These are the ALLOWED workspace deps for this layer.
    expect(deps).toContain('@corvidae/armorer');
    expect(deps).toContain('@corvidae/tool-protocol');
    expect(deps).toContain('@corvidae/cryptography');
    expect(deps).toContain('@corvidae/lifecycle');
    expect(deps).not.toContain('@corvidae/embeddings');
    expect(deps).not.toContain('@corvidae/interoperability');
  });
});

// The `SkillProvider` ⊇ `SkillProviderLike` behavioural proof that used to follow went with the
// seam it described. Bureau no longer consumes a provider — COR-892 replaced that seam with a
// catalog revision it imports as a type — so there is no duck-typed contract left to exercise.
//
// The `ToolPolicy` deny-wins tests that followed it went to the same place. They drove
// `createSkillSession`, which is deleted; the merging they asserted is now the client's
// `narrowedTools()`, covered by `test/client/skill-client.test.ts` and
// `test/client/delegation.test.ts` against the path production actually takes. The type-level
// `ToolPolicy` ≡ `ToolPolicyLike` proof survives in `src/package-graph.test-d.ts`.
