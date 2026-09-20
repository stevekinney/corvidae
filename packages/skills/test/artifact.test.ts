import { describe, expect, it } from 'bun:test';

import {
  createSkillArtifact,
  decodeArtifactText,
  DEFAULT_SKILL_ADMISSION_LIMITS,
  findArtifactEntry,
  findArtifactManifest,
  normalizeArtifactPath,
  resolveAdmissionLimits,
  resolveMediaType,
  type SkillArtifactInputFile,
} from '../src/artifact';

const encoder = new TextEncoder();

function file(path: string, text: string): SkillArtifactInputFile {
  return { path, bytes: encoder.encode(text) };
}

const MANIFEST = file('SKILL.md', '---\nname: a-skill\ndescription: A skill.\n---\n\nBody.\n');

async function admit(files: readonly SkillArtifactInputFile[], name = 'a-skill') {
  return createSkillArtifact(name, files);
}

describe('normalizeArtifactPath', () => {
  it('collapses redundant segments', () => {
    expect(normalizeArtifactPath('./scripts//extract.py')).toEqual({
      ok: true,
      path: 'scripts/extract.py',
    });
  });

  it('refuses an absolute path', () => {
    expect(normalizeArtifactPath('/etc/passwd')).toMatchObject({
      ok: false,
      code: 'absolute-path',
    });
    expect(normalizeArtifactPath('C:/Windows/system32')).toMatchObject({
      ok: false,
      code: 'absolute-path',
    });
  });

  it('refuses a parent traversal anywhere in the path', () => {
    expect(normalizeArtifactPath('../secrets')).toMatchObject({
      ok: false,
      code: 'parent-traversal',
    });
    expect(normalizeArtifactPath('scripts/../../secrets')).toMatchObject({
      ok: false,
      code: 'parent-traversal',
    });
  });

  it('refuses a backslash rather than guessing what it means', () => {
    // Treating it as a literal is what lets `..\..\secrets` past a POSIX-only traversal check on a
    // host that later reads the same string as a Windows path.
    expect(normalizeArtifactPath('..\\..\\secrets')).toMatchObject({
      ok: false,
      code: 'invalid-path',
    });
  });

  it('refuses an empty path, a NUL byte, and a path that resolves to the root', () => {
    expect(normalizeArtifactPath('')).toMatchObject({ ok: false, code: 'invalid-path' });
    expect(normalizeArtifactPath('scripts/\0evil')).toMatchObject({
      ok: false,
      code: 'invalid-path',
    });
    expect(normalizeArtifactPath('./')).toMatchObject({ ok: false, code: 'invalid-path' });
  });
});

describe('resolveMediaType', () => {
  it('resolves by extension and falls back to opaque bytes', () => {
    expect(resolveMediaType('SKILL.md')).toBe('text/markdown');
    expect(resolveMediaType('scripts/extract.py')).toBe('text/x-python');
    expect(resolveMediaType('assets/diagram.png')).toBe('image/png');
    expect(resolveMediaType('assets/UPPER.PNG')).toBe('image/png');
    expect(resolveMediaType('LICENSE')).toBe('application/octet-stream');
    expect(resolveMediaType('scripts/.hidden')).toBe('application/octet-stream');
  });
});

describe('createSkillArtifact', () => {
  it('admits a nested bundle with deterministic ordering', async () => {
    const result = await admit([
      file('references/REFERENCE.md', '# Reference'),
      MANIFEST,
      file('scripts/extract.py', 'print("hello")'),
      file('assets/template.txt', 'template'),
    ]);

    expect(result.admitted).toBe(true);
    if (!result.admitted) return;

    expect(result.artifact.entries.map((entry) => entry.path)).toEqual([
      'SKILL.md',
      'assets/template.txt',
      'references/REFERENCE.md',
      'scripts/extract.py',
    ]);
  });

  it('produces the same digest regardless of the order files were offered in', async () => {
    const files = [MANIFEST, file('scripts/a.py', 'a'), file('references/b.md', 'b')];
    const forward = await admit(files);
    const reversed = await admit(files.toReversed());

    expect(forward.admitted && reversed.admitted).toBe(true);
    if (!forward.admitted || !reversed.admitted) return;

    // The digest is derived from ordered path/content pairs precisely so a filesystem that
    // enumerates entries in a different order cannot produce a different artifact identity.
    expect(forward.artifact.digest).toBe(reversed.artifact.digest);
  });

  it('changes the digest when any file at any path changes', async () => {
    const before = await admit([MANIFEST, file('scripts/a.py', 'a')]);
    const after = await admit([MANIFEST, file('scripts/a.py', 'b')]);
    const moved = await admit([MANIFEST, file('scripts/moved.py', 'a')]);

    expect(before.admitted && after.admitted && moved.admitted).toBe(true);
    if (!before.admitted || !after.admitted || !moved.admitted) return;

    expect(after.artifact.digest).not.toBe(before.artifact.digest);
    expect(moved.artifact.digest).not.toBe(before.artifact.digest);
  });

  it('round-trips binary content byte for byte', async () => {
    // A PNG header followed by bytes that are not valid UTF-8. Reading this as text — which is
    // what the previous ingestion path did for every resource — replaces them with U+FFFD and
    // silently corrupts the asset.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00]);
    const result = await admit([MANIFEST, { path: 'assets/logo.png', bytes: png }]);

    expect(result.admitted).toBe(true);
    if (!result.admitted) return;

    const entry = findArtifactEntry(result.artifact, 'assets/logo.png');
    expect(entry?.mediaType).toBe('image/png');
    expect(entry?.bytes).toEqual(png);
    expect(decodeArtifactText(entry!)).not.toEqual(String.fromCharCode(...png));
  });

  it('digests each entry independently of its neighbours', async () => {
    // A `Uint8Array` that is a view into a larger buffer must hash only its own window.
    const shared = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const view = shared.subarray(2, 4);
    const standalone = new Uint8Array([3, 4]);

    const viewed = await admit([MANIFEST, { path: 'assets/view.bin', bytes: view }]);
    const copied = await admit([MANIFEST, { path: 'assets/view.bin', bytes: standalone }]);

    expect(viewed.admitted && copied.admitted).toBe(true);
    if (!viewed.admitted || !copied.admitted) return;

    expect(findArtifactEntry(viewed.artifact, 'assets/view.bin')?.digest).toBe(
      findArtifactEntry(copied.artifact, 'assets/view.bin')?.digest,
    );
  });

  it('refuses the whole bundle when any path is unsafe', async () => {
    const result = await admit([MANIFEST, file('../escape.txt', 'nope')]);

    expect(result.admitted).toBe(false);
    if (result.admitted) return;

    // Whole-bundle refusal rather than a partial admission: a caller holding half a skill cannot
    // tell which half of its instructions is missing.
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('parent-traversal');
  });

  it('reports every failure at once', async () => {
    const result = await admit([MANIFEST, file('/absolute', 'a'), file('../escape', 'b')]);

    expect(result.admitted).toBe(false);
    if (result.admitted) return;

    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('absolute-path');
    expect(codes).toContain('parent-traversal');
  });

  it('refuses two files that normalize to the same path', async () => {
    const result = await admit([MANIFEST, file('scripts/a.py', 'a'), file('./scripts/a.py', 'b')]);

    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('duplicate-path');
  });

  it('refuses a bundle with no SKILL.md, and accepts the lowercase fallback', async () => {
    const missing = await admit([file('scripts/a.py', 'a')]);
    expect(missing.admitted).toBe(false);
    if (!missing.admitted) {
      expect(missing.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        'missing-skill-file',
      );
    }

    const lowercase = await admit([file('skill.md', 'body')]);
    expect(lowercase.admitted).toBe(true);
    if (lowercase.admitted) {
      expect(findArtifactManifest(lowercase.artifact)?.path).toBe('skill.md');
    }
  });

  it('prefers SKILL.md over skill.md, as the reference parser does', async () => {
    const result = await admit([MANIFEST, file('skill.md', 'other')]);
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    expect(findArtifactManifest(result.artifact)?.path).toBe('SKILL.md');
  });

  it('enforces the per-file, total-size and file-count limits', async () => {
    const oversized = await createSkillArtifact(
      'a-skill',
      [MANIFEST, file('assets/big', 'xxxxx')],
      {
        limits: { maximumFileBytes: 4 },
      },
    );
    expect(oversized.admitted).toBe(false);
    if (!oversized.admitted) {
      expect(oversized.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        'file-too-large',
      );
    }

    const tooLarge = await createSkillArtifact('a-skill', [MANIFEST, file('assets/big', 'xxxxx')], {
      limits: { maximumTotalBytes: 10 },
    });
    expect(tooLarge.admitted).toBe(false);
    if (!tooLarge.admitted) {
      expect(tooLarge.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        'artifact-too-large',
      );
    }

    const tooMany = await createSkillArtifact(
      'a-skill',
      [MANIFEST, file('a', 'a'), file('b', 'b')],
      { limits: { maximumFileCount: 2 } },
    );
    expect(tooMany.admitted).toBe(false);
    if (!tooMany.admitted) {
      expect(tooMany.diagnostics.map((diagnostic) => diagnostic.code)).toContain('too-many-files');
    }
  });

  it('reports the total size it admitted', async () => {
    const result = await admit([MANIFEST, file('scripts/a.py', 'abc')]);
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;

    expect(result.artifact.totalBytes).toBe(MANIFEST.bytes.byteLength + 3);
  });

  it('can assemble a partial bundle when a caller explicitly asks for one', async () => {
    const result = await createSkillArtifact('a-skill', [file('references/only.md', 'x')], {
      requireManifest: false,
    });
    expect(result.admitted).toBe(true);
  });
});

describe('resolveAdmissionLimits', () => {
  it('fills in each default independently', () => {
    expect(resolveAdmissionLimits()).toEqual(DEFAULT_SKILL_ADMISSION_LIMITS);
    expect(resolveAdmissionLimits({ maximumFileCount: 7 })).toEqual({
      ...DEFAULT_SKILL_ADMISSION_LIMITS,
      maximumFileCount: 7,
    });
  });
});

describe('findArtifactEntry', () => {
  it('normalizes the lookup path and refuses an unsafe one', async () => {
    const result = await admit([MANIFEST, file('scripts/a.py', 'a')]);
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;

    expect(findArtifactEntry(result.artifact, './scripts/a.py')?.path).toBe('scripts/a.py');
    expect(findArtifactEntry(result.artifact, '../scripts/a.py')).toBeUndefined();
    expect(findArtifactEntry(result.artifact, 'scripts/missing.py')).toBeUndefined();
  });
});
