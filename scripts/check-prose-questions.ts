#!/usr/bin/env bun
// Prose-question guard: a Claude Code `Stop` hook for the main session. An agent that needs the
// owner to decide something must ask with `AskUserQuestion`; ending a turn with the question buried
// in prose stops the work and hides the question. The hook reads the Stop payload from standard
// input, reads the transcript, takes the assistant text since the last genuine user message, and
// blocks the stop when that text asks the owner for a decision and the turn has no `AskUserQuestion`
// tool call.
//
// It does not run for subagents: `SubagentStop` is a separate event and is not wired.
// It allows the stop when `stop_hook_active` is true (the agent is already continuing because of a
// hook, so blocking again would loop), and it fails open on every error: a missing or unreadable
// transcript or malformed JSON prints a message on standard error and exits 0 without blocking.
//
// Output: `{"decision":"block","reason":...}` on standard output with exit 0 when it blocks.

export const reason =
  'You asked the owner to decide something in prose. Ask it with AskUserQuestion (one question, recommended option first), then keep working on everything that does not depend on the answer.';

/** A sentence that ends in `?` and opens by addressing the reader. */
const questionOpeners =
  /^(?:want me to|should i|should we|do you want|do you need|would you like|would you prefer|shall i|shall we|which|can i|may i|how would you like|what would you like)\b/i;

/** Phrases that hand a decision to the owner, anywhere in a sentence. */
export const decisionPhrases: readonly RegExp[] = [
  /\bneeds? your (?:ok|okay|approval|decision|sign-?off|go-?ahead|confirmation)\b/i,
  /\brequires? your (?:ok|okay|approval|decision|sign-?off|go-?ahead|confirmation)\b/i,
  /\byour call\b/i,
  /\bonly you can decide\b/i,
  /\bwaiting (?:on|for) your\b/i,
  /\blet me know (?:if|whether)\b/i,
  /\bif you(?:'d)? (?:want|like|prefer), i can\b/i,
  /\bsay the word\b/i,
];

export interface StopPayload {
  session_id?: unknown;
  transcript_path?: unknown;
  stop_hook_active?: unknown;
}

interface Block {
  type?: unknown;
  text?: unknown;
  name?: unknown;
}

interface Entry {
  type?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  message?: { content?: unknown };
}

/** Text that the harness injects as a user message rather than the owner typing it. */
const injected =
  /^\s*<(?:system-reminder|task-notification|command-|local-command|user-prompt-submit-hook|bash-)/;

function contentBlocks(entry: Entry): Block[] {
  const content = entry.message?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

/** True for a user entry the owner typed: not a tool result, meta, sidechain, or hook message. */
function isGenuineUserMessage(entry: Entry): boolean {
  if (entry.type !== 'user' || entry.isMeta === true || entry.isSidechain === true) return false;
  const texts = contentBlocks(entry).filter(
    (block) => block.type === 'text' && typeof block.text === 'string',
  );
  if (texts.length === 0) return false;
  return texts.some((block) => !injected.test(block.text as string));
}

export interface Turn {
  text: string;
  askedWithTool: boolean;
}

/** The assistant text and tool use since the last genuine user message. */
export function lastTurn(entries: readonly Entry[]): Turn {
  let start = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (isGenuineUserMessage(entries[index] as Entry)) {
      start = index + 1;
      break;
    }
  }
  const texts: string[] = [];
  let askedWithTool = false;
  for (const entry of entries.slice(start)) {
    if (entry.type !== 'assistant' || entry.isSidechain === true) continue;
    for (const block of contentBlocks(entry)) {
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      if (block.type === 'tool_use' && block.name === 'AskUserQuestion') askedWithTool = true;
    }
  }
  return { text: texts.join('\n\n'), askedWithTool };
}

/** The prose that counts: no fenced or inline code, no `>` quotes, no headings. */
function proseLines(text: string): string[] {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const raw of text.split('\n')) {
    const marker = /^\s*(```+|~~~+)/.exec(raw)?.[1];
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (marker !== undefined) {
      fence = marker;
      continue;
    }
    if (/^\s*>/.test(raw) || /^\s{0,3}#{1,6}\s/.test(raw)) continue;
    lines.push(raw.replace(/`[^`]*`/g, ' '));
  }
  return lines;
}

/** True when the prose asks the owner to decide something. */
export function asksForDecision(text: string): boolean {
  for (const line of proseLines(text)) {
    const sentences = line.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      const clean = sentence.replace(/^[\s*_\-•\d.)]+/, '').replace(/[*_]/g, '');
      if (decisionPhrases.some((pattern) => pattern.test(clean))) return true;
      if (clean.trimEnd().endsWith('?') && questionOpeners.test(clean)) return true;
    }
  }
  return false;
}

/** The block decision for a Stop payload and its transcript text, or undefined to allow. */
export function decide(
  payload: StopPayload,
  transcript: string,
): { decision: 'block'; reason: string } | undefined {
  if (payload.stop_hook_active === true) return undefined;
  const entries: Entry[] = [];
  for (const line of transcript.split('\n')) {
    if (line.trim() === '') continue;
    entries.push(JSON.parse(line) as Entry);
  }
  const turn = lastTurn(entries);
  if (turn.askedWithTool || !asksForDecision(turn.text)) return undefined;
  return { decision: 'block', reason };
}

if (import.meta.main) {
  try {
    const payload = JSON.parse(await Bun.stdin.text()) as StopPayload;
    if (payload.stop_hook_active !== true) {
      if (typeof payload.transcript_path !== 'string') throw new Error('no transcript_path');
      const decision = decide(payload, await Bun.file(payload.transcript_path).text());
      if (decision !== undefined) process.stdout.write(`${JSON.stringify(decision)}\n`);
    }
  } catch (error) {
    process.stderr.write(`check-prose-questions: allowing the stop (${String(error)})\n`);
  }
}
