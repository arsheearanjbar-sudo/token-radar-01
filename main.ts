// Token launch radar entrypoint (Node 22+, standard library only).
//
// Reads the sealed snapshot, scores every rankable pre-token protocol with
// the model in lib/model.ts, and writes the graded output: board.json, the
// dashboard's data.js, copies of dashboard/ and screenshots/, and dossier.json
// built with the vendored make.fun library. Runs twice must write the same
// bytes: every step below is deterministic (sorted copies, no timestamps,
// no randomness, no network).
//
// Local run:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_MAX = 4;
const SCREENSHOT_MAX_BYTES = 524_288;
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function fail(message: string): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(1);
}

/** `--name value` or `--name=value` from the arguments, else the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile} (pass --input <snapshot.json|directory>)\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`);

/** Copy a directory tree's regular files, in sorted order, skipping dot-names. */
function copyTree(from: string, to: string): string[] {
  const copied: string[] = [];
  const walk = (src: string, dst: string): void => {
    if (!existsSync(src)) return;
    mkdirSync(dst, { recursive: true });
    for (const name of readdirSync(src).sort()) {
      if (name.startsWith('.')) continue;
      const srcPath = join(src, name);
      const dstPath = join(dst, name);
      const st = statSync(srcPath);
      if (st.isDirectory()) walk(srcPath, dstPath);
      else if (st.isFile()) {
        copyFileSync(srcPath, dstPath);
        copied.push(name);
      }
    }
  };
  walk(from, to);
  return copied;
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

const dashboardFiles = copyTree(join(here, 'dashboard'), join(out, 'dashboard'));
if (!dashboardFiles.includes('index.html')) fail('dashboard/ holds no index.html');
if (!dashboardFiles.some((n) => n.endsWith('.css'))) fail('dashboard/ holds no .css file');
if (!dashboardFiles.some((n) => n.endsWith('.js'))) fail('dashboard/ holds no .js file');

const shots = copyTree(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) fail(`screenshots/ holds ${shots.length} image(s): hand in 3, the board, a detail view, and a filtered view`);
if (shots.length > SCREENSHOT_MAX) fail(`screenshots/ holds ${shots.length} images: at most ${SCREENSHOT_MAX}`);
for (const name of shots) {
  if (!FILE_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
  const bytes = readFileSync(join(out, 'screenshots', name));
  if (bytes.length > SCREENSHOT_MAX_BYTES) fail(`screenshots/${name} is ${bytes.length} bytes, over the 512 KiB cap`);
  const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isPng && !isJpeg) fail(`screenshots/${name} is neither a PNG nor a JPEG`);
}

// The dossier is written last: the scorer rebuilds it from this output and compares bytes.
const dossier = buildDossier(out, {
  text_max_bytes: TEXT_MAX_BYTES,
  screenshots: { max: SCREENSHOT_MAX, max_bytes: SCREENSHOT_MAX_BYTES },
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
});
if (dossier.length > 1_572_864) fail(`dossier.json is ${dossier.length} bytes, over the 1.5 MiB cap: shrink the screenshots or the dashboard text`);
writeFileSync(join(out, 'dossier.json'), dossier);

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote board.json, data.js, dashboard/ (${dashboardFiles.length} files), screenshots/ (${shots.length} images), dossier.json\n`,
);
