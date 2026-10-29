const assert = require('node:assert/strict');
const { test } = require('node:test');
const { analyze, Project } = require('../src/analysis.cjs');
const { format, diagnostics, organizeImports } = require('../src/intelligence.cjs');
const { exportsFor } = require('../src/intelligence.cjs');
const { importEdit } = require('../src/editor-features.cjs');
const path = require('node:path');
const { URI } = require('vscode-uri');
const uri = 'file:///workspace/view.enaml';
const apply = (doc, edits) => edits.sort((a, b) => doc.offset(b.range.start) - doc.offset(a.range.start)).reduce((text, edit) => text.slice(0, doc.offset(edit.range.start)) + edit.newText + text.slice(doc.offset(edit.range.end)), doc.text);

test('indentation handles multiline declarations, backslashes, strings and comments', () => {
  const source = 'enamldef View(\n    Container\n):\n  """description\n          preserve me\n  """\n  values = (\n      1,\n           2,\n  )\n  total = 1 + \\\n          2\n  # comment\n  pass\n';
  const doc = analyze(uri, source);
  assert.deepEqual(doc.issues, []);
  const formatted = apply(doc, format(doc, { insertSpaces: true, tabSize: 4 }));
  assert.ok(formatted.includes('          preserve me'));
  assert.ok(formatted.includes('           2,'));
  assert.ok(formatted.includes('    values = ('));
  assert.ok(formatted.includes('          2\n'));
  assert.deepEqual(analyze(uri, formatted).issues, []);
  assert.deepEqual(format(analyze(uri, formatted), { insertSpaces: true, tabSize: 4 }), []);
});

test('indentation reports missing blocks, top-level indentation and invalid dedents', () => {
  for (const source of ['  pass\n', 'enamldef View(Container):\n', 'enamldef View(Container):\n    pass\n  pass\n']) {
    assert.ok(analyze(uri, source).issues.some(issue => /indent/i.test(issue.message)), source);
  }
});

test('diagnostics are independently configurable and distinguish unknown names and members', () => {
  const project = new Project();
  const doc = project.update(uri, 'class Person:\n    title: str\nenamldef View(Person):\n    attr user = Person()\n    attr title: str\n    attr title: str\n    result = user.typo\n    other = misspelled()\n');
  const issues = diagnostics(project, doc, { unresolvedMembers: true });
  assert.ok(issues.some(i => i.code === 'duplicate-declaration'));
  assert.ok(issues.some(i => i.code === 'unknown-member'));
  assert.ok(issues.some(i => i.code === 'unknown-name'));
  assert.deepEqual(diagnostics(project, doc, { enabled: false }), []);
  assert.equal(diagnostics(project, doc, { unresolvedNames: false, duplicates: false }).length, 0);
});

test('builtins and keyword arguments do not produce unknown-name errors', () => {
  const project = new Project();
  const doc = project.update(uri, 'enamldef View(Container):\n    func render(value):\n        return str(value)\n    result = render(value=len([]))\n');
  assert.deepEqual(diagnostics(project, doc), []);
});

test('formatter preserves multiline string bytes, CRLF, and uses bounded indentation settings', () => {
  const source = 'enamldef View(Container):\r\n  attr text = """first  \r\n  untouched   \r\n  """\r\n  value = 1   \r\n';
  const doc = analyze(uri, source), formatted = apply(doc, format(doc, { tabSize: 4 }));
  assert.ok(formatted.includes('"""first  \r\n  untouched   \r\n  """'));
  assert.ok(formatted.includes('    value = 1\r\n'));
});

test('optional type/binding checks validate known declarations and suppress dynamic bases', () => {
  const project = new Project();
  const doc = project.update(uri, 'class Base:\n    title: str\nenamldef View(Base):\n    title = "ok"\n    typo = "bad"\n    attr value: MisspelledType\nenamldef Dynamic(UnknownExternal):\n    generated = 1\n');
  const issues = diagnostics(project, doc, { bindings: true, unresolvedTypes: true });
  assert.ok(issues.some(i => i.code === 'invalid-binding' && i.message.includes('typo')));
  assert.ok(!issues.some(i => i.code === 'invalid-binding' && /title|generated/.test(i.message)));
  assert.ok(issues.some(i => i.code === 'unknown-type' && i.message.includes('MisspelledType')));
});

test('loop and comprehension targets are accepted without leaking new global declarations', () => {
  const project = new Project();
  const doc = project.update(uri, 'enamldef View(Container):\n    func build(values):\n        for value in values:\n            print(value)\n        result = [item for item in values]\n        return result\n');
  assert.deepEqual(diagnostics(project, doc), []);
  assert.equal(project.lookup(doc, 'item', doc.root), null);
});

test('import sorting preserves CRLF, comments, multiline imports and future imports', () => {
  const source = 'import zebra\r\nfrom __future__ import annotations\r\nimport alpha\r\n# keep this comment\r\nfrom pkg import (\r\n    Thing,\r\n)\r\n';
  const doc = analyze(uri, source), sorted = apply(doc, organizeImports(doc));
  assert.ok(sorted.startsWith('from __future__ import annotations\r\nimport alpha\r\nimport zebra\r\n'));
  assert.ok(sorted.endsWith('# keep this comment\r\nfrom pkg import (\r\n    Thing,\r\n)\r\n'));
});

test('auto-import placement preserves future imports, docstrings, comments and EOF boundaries', () => {
  const cases = [
    ['from __future__ import annotations\nvalue = Person()\n', 'from __future__ import annotations\nfrom models import Person\nvalue = Person()\n'],
    ['"""Docs"""', '"""Docs"""\nfrom models import Person\n'],
    ['# encoding: utf-8', '# encoding: utf-8\nfrom models import Person\n'],
    ['from __future__ import annotations', 'from __future__ import annotations\nfrom models import Person\n'],
    ['#!/usr/bin/python\r\n"""Docs"""\r\nfrom __future__ import (\r\n    annotations,\r\n)\r\nvalue = Person()\r\n', '#!/usr/bin/python\r\n"""Docs"""\r\nfrom __future__ import (\r\n    annotations,\r\n)\r\nfrom models import Person\r\nvalue = Person()\r\n'],
    ['from __future__ import \\\n    annotations\nvalue = Person()\n', 'from __future__ import \\\n    annotations\nfrom models import Person\nvalue = Person()\n']
  ];
  for (const [source, expected] of cases) {
    const doc = analyze(uri, source);
    assert.equal(apply(doc, [importEdit(doc, 'models', 'Person')]), expected);
  }
});

test('unknown receivers are diagnosed independently of member validation', () => {
  const project = new Project();
  const doc = project.update(uri, 'enamldef View(Container):\n    result = missing.method()\n    other = missing.deep.method()\n');
  const issues = diagnostics(project, doc, { unresolvedMembers: false });
  assert.equal(issues.filter(issue => issue.code === 'unknown-name' && issue.data.name === 'missing').length, 2);
  assert.equal(issues.length, 2);
  assert.deepEqual(diagnostics(project, doc, { unresolvedNames: false, unresolvedMembers: true }), []);
});

test('auto-import candidates are capped within a module and symbol scans can be cancelled', async () => {
  const project = new Project([process.cwd()]);
  const doc = project.update(URI.file(path.join(process.cwd(), 'completion_view.enaml')).toString(), '');
  const target = URI.file(path.join(process.cwd(), 'completion_exports.py')).toString();
  project.update(target, Array.from({ length: 250 }, (_, i) => `class Example${i}:\n    pass\n`).join(''));
  project.files = function* () { yield target; };
  assert.equal((await exportsFor(project, doc, 'Ex')).length, 40);
  const cancellation = { isCancellationRequested: false };
  setImmediate(() => { cancellation.isCancellationRequested = true; });
  assert.deepEqual(await exportsFor(project, doc, 'NoMatch', cancellation), []);
  assert.equal(cancellation.isCancellationRequested, true);
});
