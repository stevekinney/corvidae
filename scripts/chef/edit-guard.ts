#!/usr/bin/env bun
// Chef edit guard: a Claude Code `PreToolUse` hook for Bash that denies editing files from the
// shell in the two ways that leave an edit half applied. In one day's run workers twice used a
// Python heredoc for a multi-site edit, a later assertion in the script failed, and the earlier
// replacements were lost or left in place with nobody told. Edit and Write fail loudly, one site
// at a time. This is a Claude Code hook (`.claude/settings.json`), not a Git hook.
//
// It reads the hook input from standard input and looks at `tool_input.command`.
//   - DENIED: an interpreter fed a script on standard input by a heredoc (`python3 - <<'EOF'`,
//     `node <<EOF`, `bun - <<EOF`, `ruby`, `perl`) when that script writes a file; and `sed` or
//     `perl` with an in-place flag (`sed -i`, `sed --in-place`, `perl -pi -e`, `perl -i.bak`),
//     wherever it sits in a pipeline (`find … -exec sed -i`, `xargs perl -pi`).
//   - ALLOWED: a heredoc script that only reads and prints, a heredoc into `cat` or `git commit`,
//     `sed` and `perl` that print to standard output, a script file run by name, and everything
//     else. Text inside a heredoc's body is never read as a command.
//
// It fails open: malformed input, a missing command, or any unexpected error prints nothing. A
// script kept in a file and run by name is not caught; the guard stops the habit, not the intent.
//
// Output: JSON on standard output with exit 0 when it denies, nothing otherwise. Exit codes: always 0.

export interface HookInput {
  tool_name?: unknown;
  tool_input?: unknown;
}

export interface HookDecision {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

const reason =
  'Editing files with an interpreter heredoc or an in-place `sed -i` or `perl -i` is denied: a multi-site script that fails partway leaves the edit half applied, and an in-place substitution that matches nothing reports success. Edit each site with the Edit tool, or write the whole file with Write; both fail loudly when the text is not there. To read or measure, print to standard output instead of writing a file.';

const interpreters = new Set(['python', 'python3', 'node', 'bun', 'ruby', 'perl', 'deno']);

/** Words that run the command after them. */
const wrappers = new Set(['command', 'sudo', 'env', 'time', 'exec', 'nohup', 'nice']);

/** `find` options whose next word is a command. */
const launchers = new Set(['-exec', '-execdir', '-ok', '-okdir']);

/** What a script does when it writes a file, in the languages above. */
const writes = [
  /\bopen\s*\([^)]*,\s*['"][wax]\+?[bt]?['"]/,
  // Printing through `sys.stdout.write` or `process.stderr.write` writes no file.
  /(?<!std(?:out|err))\.write\s*\(/,
  /\bwrite_text\s*\(/,
  /\bwrite_bytes\s*\(/,
  /\bwriteFile(Sync)?\s*\(/,
  /\bBun\.write\s*\(/,
  /\bFile\.write\s*\(/,
  /\bopen\s*\(\s*[A-Z_a-z$]*\s*,\s*['"]>/,
];

interface Heredoc {
  /** The command line the heredoc is attached to, up to the `<<`. */
  readonly before: string;
  readonly body: string;
}

/** Splits a command into its heredocs and the command text with their bodies removed. */
function heredocs(command: string): { readonly found: Heredoc[]; readonly rest: string } {
  const lines = command.split('\n');
  const found: Heredoc[] = [];
  const rest: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    rest.push(line);
    const opener = /<<-?\s*(['"]?)([A-Z_a-z][\w-]*)\1/.exec(line);
    if (opener === null) continue;
    const delimiter = opener[2] ?? '';
    const body: string[] = [];
    index += 1;
    while (index < lines.length && (lines[index] ?? '').trim() !== delimiter) {
      body.push(lines[index] ?? '');
      index += 1;
    }
    found.push({ before: line.slice(0, opener.index), body: body.join('\n') });
  }
  return { found, rest: rest.join('\n') };
}

function words(segment: string): string[] {
  return segment
    .replace(/[`(){}]/g, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^['"]+|['"]+$/g, ''))
    .filter((word) => word !== '');
}

/** The last path segment of a command word: `/usr/bin/python3` is `python3`. */
function program(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

/** Whether a heredoc feeds an interpreter a script that writes a file. */
function writingHeredoc(heredoc: Heredoc): boolean {
  const segment = heredoc.before.split(/&&|\|\||;|\|/).at(-1) ?? '';
  const tokens = words(segment);
  const at = tokens.findIndex((word) => interpreters.has(program(word)));
  if (at === -1) return false;
  // With a script named on the line (`bun scripts/x.ts <<EOF`), the heredoc is that script's data.
  if (tokens.slice(at + 1).some((word) => word !== '-' && !word.startsWith('-'))) return false;
  return writes.some((pattern) => pattern.test(heredoc.body));
}

/**
 * Whether the words after `sed` or `perl` hold an in-place flag. Short flags group (`-pi`, `-ni`,
 * `-0pi`, `-i.bak`), and a letter that takes a value ends the group: the rest of the word is that
 * value, as in `-Mstrict`, `-Ilib` and `-pie`.
 */
function inPlaceFlags(name: string, rest: readonly string[]): boolean {
  // BSD sed spells in-place `-I` as well; for perl `-I` is an include directory.
  const inPlace = name === 'sed' ? 'iI' : 'i';
  const takesValue = name === 'sed' ? 'efl' : 'eEMmIFxCDV';
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index] ?? '';
    if (flag === '--in-place' || flag.startsWith('--in-place=')) return true;
    if (flag.startsWith('--')) continue;
    if (!flag.startsWith('-')) {
      // Perl's first plain word is its script, and what follows belongs to that script.
      if (name === 'perl') return false;
      continue;
    }
    for (const letter of flag.slice(1)) {
      if (inPlace.includes(letter)) return true;
      if (takesValue.includes(letter)) {
        // A value-taking letter at the end of the word takes the next word (`-e 's/a/b/'`).
        if (flag.endsWith(letter)) index += 1;
        break;
      }
    }
  }
  return false;
}

/** Whether one command segment runs `sed` or `perl` with an in-place flag. */
function inPlaceSegment(segment: string): boolean {
  const tokens = words(segment);
  for (let index = 0; index < tokens.length; index += 1) {
    const name = program(tokens[index] ?? '');
    if (name !== 'sed' && name !== 'perl') continue;
    // The word has to be the command, not an argument: `grep sed -i notes.md` searches for "sed".
    const before = tokens.slice(0, index);
    const previous = before.at(-1);
    const runs =
      before.every((word) => /^[A-Z_a-z]\w*=/.test(word) || wrappers.has(word)) ||
      (previous !== undefined && launchers.has(previous)) ||
      before.includes('xargs');
    if (!runs) continue;
    if (inPlaceFlags(name, tokens.slice(index + 1))) return true;
  }
  return false;
}

/** The hook's answer for `input`, or `undefined` to say nothing (allow silently). */
export function decide(input: HookInput): HookDecision | undefined {
  if (input.tool_name !== undefined && input.tool_name !== 'Bash') return undefined;
  const toolInput = input.tool_input;
  if (toolInput === null || typeof toolInput !== 'object') return undefined;
  const command = (toolInput as { command?: unknown }).command;
  if (typeof command !== 'string') return undefined;
  const { found, rest } = heredocs(command);
  const denied = found.some(writingHeredoc) || rest.split(/&&|\|\||;|\||&|\n/).some(inPlaceSegment);
  if (!denied) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

if (import.meta.main) {
  try {
    const input = JSON.parse(await Bun.stdin.text()) as HookInput;
    const decision = decide(input);
    if (decision !== undefined) process.stdout.write(`${JSON.stringify(decision)}\n`);
  } catch {
    // Fail open: a hook that cannot read its input must not stop the session's work.
  }
}
