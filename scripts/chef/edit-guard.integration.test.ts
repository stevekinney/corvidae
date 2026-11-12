import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { runWithHangGuard } from '../../testing/testing/src/hang-guard.ts';
import { decide } from './edit-guard.ts';

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });
const denied = (command: string) => decide(bash(command)) !== undefined;

/** The multi-site edit two workers lost: a later assertion fails after an earlier replacement. */
const pythonEdit = [
  "python3 - <<'EOF'",
  "p='src/a.ts'",
  's=open(p).read()',
  "assert s.count('one')==1",
  "s=s.replace('one','two')",
  "open(p,'w').write(s)",
  'EOF',
].join('\n');

describe('edit-guard decide', () => {
  test('denies an interpreter heredoc that writes a file', () => {
    for (const command of [
      pythonEdit,
      `cd applications/interborough && ${pythonEdit}\ngrep -n two src/a.ts`,
      "python - <<EOF\nfrom pathlib import Path\nPath('a.md').write_text('x')\nEOF",
      "/usr/bin/python3 <<'PY'\nwith open('a.txt', 'a') as f:\n  f.write('x')\nPY",
      "node - <<'EOF'\nrequire('fs').writeFileSync('a.json', '{}')\nEOF",
      "bun - <<'EOF'\nawait Bun.write('a.ts', 'x')\nEOF",
      "ruby <<-EOF\nFile.write('a.rb', 'x')\nEOF",
      'perl <<\'EOF\'\nopen(F, ">a.txt"); print F "x";\nEOF',
    ]) {
      expect(denied(command)).toBe(true);
    }
  });

  test('denies sed and perl with an in-place flag, wherever they run', () => {
    for (const command of [
      "sed -i 's/one/two/' src/a.ts",
      "sed -i '' -e 's/one/two/' src/a.ts",
      "sed -i.bak 's/one/two/' src/a.ts",
      "sed -Ei 's/one/two/' src/a.ts",
      "sed --in-place 's/one/two/' src/a.ts",
      "sed --in-place=.bak 's/one/two/' src/a.ts",
      "perl -pi -e 's/one/two/' src/a.ts",
      "perl -i -pe 's/one/two/' src/a.ts",
      "perl -0pi -e 's/one/two/' src/a.ts",
      "perl -pie 's/one/two/' src/a.ts",
      "perl -e 's/one/two/' -pi src/a.ts",
      "perl -Mstrict -pi -e 's/one/two/' src/a.ts",
      "sed -I '' 's/one/two/' src/a.ts",
      "sed -e 's/one/two/' -i src/a.ts",
      "sed 's/one/two/' -i src/a.ts",
      "LC_ALL=C sed -i 's/one/two/' src/a.ts",
      "grep -rl one src | xargs sed -i 's/one/two/'",
      "grep -rlZ one src | xargs -0 perl -pi -e 's/one/two/'",
      "find src -name '*.ts' -exec sed -i 's/one/two/' {} +",
      "git status && sed -i 's/one/two/' src/a.ts",
      "/usr/bin/sed -i 's/one/two/' src/a.ts",
    ]) {
      expect(denied(command)).toBe(true);
    }
  });

  test('the reason names the tools to use instead', () => {
    const decision = decide(bash("sed -i 's/one/two/' src/a.ts"));
    expect(decision?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(decision?.hookSpecificOutput.permissionDecisionReason).toContain('Edit tool');
    expect(decision?.hookSpecificOutput.permissionDecisionReason).toContain('Write');
  });

  test('allows scripts that only read, heredocs into other commands, and sed and perl that print', () => {
    for (const command of [
      "python3 - <<'EOF'\nimport json, sys\nprint(len(json.load(open('a.json'))))\nsys.stdout.write('done')\nEOF",
      "node - <<'EOF'\nprocess.stdout.write(String(require('./a.json').length))\nEOF",
      "cat > /tmp/notes.md <<'EOF'\nRun sed -i 's/a/b/' by hand, or open(p,'w').write(s) in Python.\nEOF",
      "git commit -F - <<'EOF'\nReplace perl -pi -e with Edit\nEOF",
      "sed -n '1,20p' src/a.ts",
      "sed -E 's/one/two/' src/a.ts",
      "sed -e 's/-i/x/' src/a.ts > /tmp/b.ts",
      "perl -ne 'print if /one/' src/a.ts",
      "perl -e 'print 1'",
      "bun scripts/chef/note.ts <<'EOF'\nThe fix calls Bun.write( after open(p,'w').write(s) failed.\nEOF",
      "python3 scripts/measure.py - <<'EOF'\nopen('a','w').write('x')\nEOF",
      "perl -Mstrict -e 'print 1'",
      'perl -Ilib t/run.pl',
      'perl t/run.pl -i',
      "perl -e 'print 1' src/a.ts",
      'grep -rn sed -i notes.md',
      'grep -n "perl" -i notes.md',
      'git log -i --grep=sed',
      'bun scripts/rewrite.ts',
      'python3 scripts/measure.py',
      'ls',
    ]) {
      expect(denied(command)).toBe(false);
    }
  });

  test('ignores other tools, a missing command and malformed input', () => {
    const command = "sed -i 's/one/two/' src/a.ts";
    expect(decide({ tool_name: 'Read', tool_input: { command } })).toBeUndefined();
    expect(decide({ tool_name: 'Bash', tool_input: {} })).toBeUndefined();
    expect(decide({ tool_name: 'Bash', tool_input: { command: 5 } })).toBeUndefined();
    expect(decide({ tool_name: 'Bash' })).toBeUndefined();
    expect(decide({})).toBeUndefined();
  });
});

/** The `import.meta.main` block, run at module scope: a child per case, assertions below. */
async function runHook(stdin: string) {
  const result = await runWithHangGuard(['bun', join(import.meta.dir, 'edit-guard.ts')], {
    stdin: Buffer.from(stdin),
  });
  return { code: result.exitCode, stdout: result.stdout.toString() };
}

const denial = await runHook(JSON.stringify(bash(pythonEdit)));
const allowance = await runHook(JSON.stringify(bash("sed -n '1,20p' src/a.ts")));
const garbage = await runHook('not json');

describe('edit-guard command line', () => {
  test('prints a deny decision for a heredoc edit', () => {
    expect(denial.code).toBe(0);
    expect(JSON.parse(denial.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('prints nothing for an allowed command or garbage', () => {
    expect(allowance).toEqual({ code: 0, stdout: '' });
    expect(garbage).toEqual({ code: 0, stdout: '' });
  });
});
