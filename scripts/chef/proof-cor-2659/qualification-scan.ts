import { unzipSync, zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { sanitizeJUnit } from './ci-replay.ts';

const marker = process.env['QUALIFICATION_MARKER'];
const [stage, positiveImage, successDir, failureDir, logPath, junitPath, replayPath, base, successLogPath, successJunitPath] = process.argv.slice(2);
if (!marker || !stage || !positiveImage || !successDir || !failureDir || !logPath || !junitPath || !replayPath || !base || !successLogPath || !successJunitPath || !/^[a-f0-9]{40}$/.test(base)) throw new Error('Missing qualification input');
const bytes = Buffer.from(marker);
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
async function ocr(path: string) {
  const child = Bun.spawn(['tesseract', path, 'stdout', '--psm', '6'], { stdout: 'pipe', stderr: 'pipe' });
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  if (await child.exited !== 0) throw new Error(`OCR failed (${errors.length} diagnostic bytes)`);
  return output.includes(marker!);
}
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : entry.isFile() ? [join(directory, entry.name)] : []));
  return nested.flat();
}
const versionProcess = Bun.spawn(['tesseract', '--version'], { stdout: 'pipe', stderr: 'pipe' });
const version = (await new Response(versionProcess.stdout).text()).split('\n')[0];
if (await versionProcess.exited !== 0 || !version) throw new Error('OCR version unavailable');
const positive = await ocr(positiveImage);
const textPositive = Buffer.from(`credential=${marker}`).includes(bytes);
const archivePositive = Object.values(unzipSync(zipSync({ 'control.txt': bytes }))).some((value) => Buffer.from(value).includes(bytes));
if (!positive || !textPositive || !archivePositive) throw new Error('Positive detector control failed');
const retained = await Promise.all([logPath, junitPath, replayPath, successLogPath, successJunitPath].map((path) => readFile(path)));
if (retained.some((data) => data.includes(bytes))) throw new Error('Marker in retained diagnostic');
await mkdir(stage, { recursive: false, mode: 0o700 });
const rawOcrDirectory = join(dirname(stage), 'trace-ocr-private');
await mkdir(rawOcrDirectory, { recursive: false, mode: 0o700 });
const lanes: Record<string, unknown> = {};
for (const [lane, directory] of [['success', successDir], ['failure', failureDir]] as const) {
  const all = await files(directory);
  function one(name: string) {
    const matches = all.filter((path) => basename(path) === name);
    if (matches.length !== 1) throw new Error(`Expected one ${lane} ${name}`);
    return matches[0]!;
  }
  const images: Record<string, string> = {};
  for (const name of ['credential-masked.png', 'credential-success.png', 'credential-error.png']) {
    const path = one(name);
    if (await ocr(path)) throw new Error('Marker visible in screenshot');
    const data = await readFile(path);
    if (data.includes(bytes)) throw new Error('Marker bytes in screenshot');
    images[name] = hash(data);
    await writeFile(join(stage, `${lane}-${name}`), data, { flag: 'wx', mode: 0o600 });
  }
  const tracePath = one('trace.zip');
  const traceData = await readFile(tracePath);
  const members = Object.entries(unzipSync(traceData));
  if (members.length === 0) throw new Error('Empty trace');
  const contaminated = members.filter(([, value]) => Buffer.from(value).includes(bytes));
  let imageMembers = 0;
  for (const [, value] of members) {
    const image = Buffer.from(value);
    const png = image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = image[0] === 255 && image[1] === 216 && image[2] === 255;
    if (!png && !jpeg) continue;
    const path = join(rawOcrDirectory, `${lane}-${imageMembers++}.${png ? 'png' : 'jpg'}`);
    await writeFile(path, image, { flag: 'wx', mode: 0o600 });
    if (await ocr(path)) throw new Error('Marker visible in trace image');
  }
  const clean = members.find(([name, value]) => name.endsWith('.stacks') && !name.includes(marker!) && value.length > 0 && !Buffer.from(value).includes(bytes));
  if (!clean) throw new Error('No useful marker-free trace member');
  await writeFile(join(stage, `${lane}-trace-stacks`), clean[1], { flag: 'wx', mode: 0o600 });
  lanes[lane] = { images, traceSha256: hash(traceData), traceMembers: members.length, imageMembers, contaminatedMembers: contaminated.length, retainedTraceMember: basename(clean[0]) };
}
await writeFile(join(stage, 'failure-junit.xml'), await sanitizeJUnit(retained[1]!.toString()), { flag: 'wx', mode: 0o600 });
await writeFile(join(stage, 'success-junit.xml'), await sanitizeJUnit(retained[4]!.toString()), { flag: 'wx', mode: 0o600 });
await writeFile(join(stage, 'replay.json'), retained[2]!, { flag: 'wx', mode: 0o600 });
await writeFile(join(stage, 'receipt.json'), JSON.stringify({ base, head: process.env['GITHUB_SHA'], command: process.env['CI_REPLAY_COMMAND'], successExit: 0, plantedFailureExit: 1, ocrVersion: version, positive, textPositive, archivePositive, lanes }, null, 2));
const inventory = (await readdir(stage)).toSorted();
const expected = ['failure-junit.xml', 'success-junit.xml', 'receipt.json', 'replay.json', ...['success', 'failure'].flatMap((lane) => [`${lane}-credential-masked.png`, `${lane}-credential-success.png`, `${lane}-credential-error.png`, `${lane}-trace-stacks`])].toSorted();
if (JSON.stringify(inventory) !== JSON.stringify(expected)) throw new Error('Unexpected staged inventory');
for (const name of inventory) if ((await readFile(join(stage, name))).includes(bytes)) throw new Error('Marker in staged inventory');
