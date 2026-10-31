// Sets the GitHub repository in every place that needs it.
// Usage: node scripts/set-repo.mjs dono/nome [pasta-do-projeto]
import fs from 'node:fs';
import path from 'node:path';

const repo = process.argv[2];
const root = path.resolve(process.argv[3] ?? path.join(import.meta.dirname, '..'));

if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(repo ?? '') || repo === 'SEU-USUARIO/bookflix') {
  console.error('Uso: node scripts/set-repo.mjs dono/nome   (ex.: maria/bookflix)');
  process.exit(1);
}

const edits = [
  ['server/version.ts', /export const DEFAULT_REPO = '[^']*';/, `export const DEFAULT_REPO = '${repo}';`],
  ['package.json', /"homepage": "https:\/\/github\.com\/[^"]*"/, `"homepage": "https://github.com/${repo}"`],
  ['README.md', /https:\/\/github\.com\/SEU-USUARIO\/bookflix/g, `https://github.com/${repo}`],
];

let failed = false;
for (const [file, pattern, replacement] of edits) {
  const full = path.join(root, file);
  const before = fs.readFileSync(full, 'utf8');
  const after = before.replace(pattern, replacement);
  if (after === before && !before.includes(repo)) {
    console.error(`${file}: nada encontrado para trocar`);
    failed = true;
    continue;
  }
  fs.writeFileSync(full, after);
  console.log(`${file}: ok`);
}
process.exit(failed ? 1 : 0);
