// Turns the Vite build in dist/ into a claude.ai Artifact page: dist/artifact.html.
// The Artifact host wraps the page in its own <!doctype>/<html>/<head>/<body>,
// so this strips those tags and keeps the rest. The page loads its scripts and
// styles from ./assets/, which are published next to it as the artifact's files.
//   npm run build && node tools/artifact.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const html = readFileSync('dist/index.html', 'utf8');
const head = /<head>([\s\S]*?)<\/head>/.exec(html)[1];
const body = /<body>([\s\S]*?)<\/body>/.exec(html)[1];

const keep = head
  .split('\n')
  .map((l) => l.trim())
  // the host supplies charset and viewport; the artifact's own icon replaces the favicon
  .filter((l) => l && !/<meta (charset|name="viewport")|rel="icon"/.test(l));

// <title> first: the host only scans the start of the page for it
keep.sort((a, b) => (b.startsWith('<title>') ? 1 : 0) - (a.startsWith('<title>') ? 1 : 0));

writeFileSync('dist/artifact.html', `${keep.join('\n')}\n${body.trim()}\n`);
console.log('dist/artifact.html');
for (const f of readdirSync('dist/assets')) console.log(`  assets/${f}`);
