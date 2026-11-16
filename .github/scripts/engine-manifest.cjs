// Writes engine-manifest.json (package root) and SHA256SUMS (next to the binaries) for a
// release: each explore engine binary's file name, sha256 and size. `pixelgate explore`
// checks a downloaded engine against this manifest. Used by .github/workflows/release.yml.
//
//   node .github/scripts/engine-manifest.cjs <dir with pixelgate-engine-*> <manifest path>
'use strict';
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const [dir, out] = process.argv.slice(2);
if (!dir || !out) {
  console.error('usage: engine-manifest.cjs <binaries dir> <manifest path>');
  process.exit(2);
}

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const targets = {
  'x86_64-pc-windows-msvc': 'pixelgate-engine-x86_64-pc-windows-msvc.exe',
  'x86_64-unknown-linux-gnu': 'pixelgate-engine-x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu': 'pixelgate-engine-aarch64-unknown-linux-gnu',
  'aarch64-apple-darwin': 'pixelgate-engine-aarch64-apple-darwin',
};

// Exactly the four binaries: a missing platform must not ship as a manifest without it.
const present = fs.readdirSync(dir).filter((f) => f.startsWith('pixelgate-engine-')).sort();
const expected = Object.values(targets).sort();
if (JSON.stringify(present) !== JSON.stringify(expected)) {
  console.error(`::error::engine binaries: expected ${expected.join(', ')}; found ${present.join(', ') || 'none'}`);
  process.exit(1);
}

const binaries = {};
const sums = [];
for (const [target, file] of Object.entries(targets)) {
  const data = fs.readFileSync(path.join(dir, file));
  if (data.length === 0) {
    console.error(`::error::${file} is empty`);
    process.exit(1);
  }
  const sha256 = createHash('sha256').update(data).digest('hex');
  binaries[target] = { file, sha256, size: data.length };
  sums.push(`${sha256}  ${file}`);
}

fs.writeFileSync(out, `${JSON.stringify({ version, binaries }, null, 2)}\n`);
fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
console.log(fs.readFileSync(out, 'utf8'));
