const { performance } = require('node:perf_hooks');
const { Project } = require('../src/analysis.cjs');

// Synthetic editing workload, reproducible without Python or external packages.
const project = new Project();
const source = 'enamldef View(Container):\n' + Array.from({ length: 2000 }, (_, i) =>
  `    func render_${i}(value):\n        return str(value)\n    result_${i} = render_${i}(${i})\n`).join('');
const begin = performance.now();
const doc = project.update('file:///benchmark/view.enaml', source);
const indexed = performance.now();
const issues = project.diagnostics(doc, { unresolvedImports: false });
const checked = performance.now();
let resolved = 0;
for (const token of doc.tokens) if (token.value.startsWith('render_') && project.at(doc, doc.position(token.start))) resolved++;
const end = performance.now();
console.log(JSON.stringify({ lines: doc.offsets.length, tokens: doc.tokens.length, symbols: doc.symbols.length,
  indexMs: +(indexed - begin).toFixed(1), diagnosticsMs: +(checked - indexed).toFixed(1), resolutionMs: +(end - checked).toFixed(1), resolved, issues: issues.length }, null, 2));
if (issues.length || resolved !== 4000) process.exitCode = 1;
