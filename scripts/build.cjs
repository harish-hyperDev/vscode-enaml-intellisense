const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

Promise.all([
  esbuild.build({ entryPoints: ['src/extension.cjs'], outfile: 'dist/extension.cjs', bundle: true,
    platform: 'node', target: 'node18', external: ['vscode'], legalComments: 'eof', metafile: true }),
  esbuild.build({ entryPoints: ['src/server.cjs'], outfile: 'dist/server.cjs', bundle: true,
    platform: 'node', target: 'node18', legalComments: 'eof', metafile: true })
]).then(results => {
  const packages = new Set();
  for (const result of results) for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.includes('node_modules/')) continue;
    let folder = path.dirname(path.resolve(input));
    while (!fs.existsSync(path.join(folder, 'package.json')) ||
           !JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')).name) {
      const parent = path.dirname(folder);
      if (parent === folder) throw new Error(`Missing package metadata for ${input}`);
      folder = parent;
    }
    packages.add(folder);
  }
  const notices = ['Third-party packages bundled in the Enaml extension and language server.\n'];
  for (const folder of [...packages].sort()) {
    const metadata = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
    const licenses = fs.readdirSync(folder).filter(file => /^(?:licen[sc]e|copyright)(?:\..*)?$/i.test(file));
    if (!licenses.length) throw new Error(`Missing license for ${metadata.name}`);
    notices.push(`${metadata.name} ${metadata.version}\n${'='.repeat(60)}\n` +
      licenses.map(file => fs.readFileSync(path.join(folder, file), 'utf8')).join('\n'));
  }
  fs.writeFileSync('THIRD_PARTY_NOTICES.txt', notices.join('\n\n'));
}).catch(error => { console.error(error); process.exitCode = 1; });
