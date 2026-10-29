const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { before, after, test } = require('node:test');
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node');
const { URI } = require('vscode-uri');
const { TextDocument } = require('vscode-languageserver-textdocument');

let root, child, connection, uri, document;
const notifications = [];
let configuration = { sourcePaths: [], diagnostics: { enabled: true } };
const source = 'from models import Person\n\nenamldef Page(Html): page:\n    attr user: Person\n    Body: body:\n        text << user.greet("world")\n    func render(value):\n        return value\n    result = render("hello")\n';
const model = 'class Person:\n    name: str = "User"\n    def greet(self, name: str = "world"):\n        return name\n';
const request = (method, params) => {
  let timer;
  return Promise.race([connection.sendRequest(method, params), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`LSP request timed out: ${method}`)), 8000);
  })]).finally(() => clearTimeout(timer));
};
const pos = (text, skip = 0) => {
  let index = -1;
  for (let i = 0; i <= skip; i++) index = source.indexOf(text, index + 1);
  assert.ok(index >= 0, text);
  return document.positionAt(index);
};
const params = position => ({ textDocument: { uri }, position });

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'enaml-protocol-'));
  fs.writeFileSync(path.join(root, 'models.py'), model);
  fs.writeFileSync(path.join(root, 'view.enaml'), source);
  uri = URI.file(path.join(root, 'view.enaml')).toString();
  document = TextDocument.create(uri, 'enaml', 1, source);
  child = spawn(process.execPath, [process.env.ENAML_TEST_SERVER || path.resolve(__dirname, '../dist/server.cjs'), '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => { throw error; });
  connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
  connection.onRequest('workspace/configuration', () => [configuration]);
  connection.onRequest('client/registerCapability', () => null);
  connection.onNotification('textDocument/publishDiagnostics', value => notifications.push(value));
  connection.listen();
  const init = await request('initialize', { processId: null, rootUri: URI.file(root).toString(),
    workspaceFolders: [{ uri: URI.file(root).toString(), name: 'test' }],
    capabilities: { workspace: { configuration: true, workspaceFolders: true } } });
  assert.equal(init.capabilities.definitionProvider, true, stderr);
  assert.equal(init.capabilities.completionProvider.triggerCharacters[0], '.');
  await connection.sendNotification('initialized', {});
  await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'enaml', version: 1, text: source } });
});
after(async () => {
  try {
    if (connection) { await request('shutdown', null); await connection.sendNotification('exit'); }
  } finally {
    connection?.dispose();
    child?.kill();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('actual LSP definition requests navigate to imported classes, methods and local functions', async () => {
  const cls = await request('textDocument/definition', params(pos('Person', 1)));
  assert.equal(cls.uri, URI.file(path.join(root, 'models.py')).toString());
  assert.deepEqual(cls.range.start, { line: 0, character: 6 });
  const method = await request('textDocument/definition', params(pos('greet')));
  assert.equal(method.uri, cls.uri);
  assert.deepEqual(method.range.start, { line: 2, character: 8 });
  const func = await request('textDocument/definition', params(pos('render', 1)));
  assert.equal(func.uri, uri);
  assert.deepEqual(func.range.start, pos('render'));
});

test('hover, member completion and signature help expose resolved declarations', async () => {
  const hover = await request('textDocument/hover', params(pos('greet')));
  assert.match(hover.contents.value, /def greet\(self, name/);
  const complete = await request('textDocument/completion', params(pos('greet')));
  assert.ok(complete.some(item => item.label === 'greet'));
  assert.ok(complete.some(item => item.label === 'name'));
  const signature = await request('textDocument/signatureHelp', params(document.positionAt(source.indexOf('greet(') + 6)));
  assert.equal(signature.signatures[0].parameters[0].label, 'name');
});

test('outline, workspace search, folding and references work over the wire', async () => {
  const outline = await request('textDocument/documentSymbol', { textDocument: { uri } });
  const page = outline.find(symbol => symbol.name === 'Page');
  assert.ok(page.children.some(symbol => symbol.name === 'render'));
  const search = await request('workspace/symbol', { query: 'Person' });
  assert.ok(search.some(symbol => symbol.name === 'Person'));
  const references = await request('textDocument/references', { ...params(pos('render')), context: { includeDeclaration: true } });
  assert.equal(references.length, 2);
  const highlights = await request('textDocument/documentHighlight', params(pos('render')));
  assert.equal(highlights.length, 2);
  const folds = await request('textDocument/foldingRange', { textDocument: { uri } });
  assert.ok(folds.some(range => range.startLine === 2 && range.endLine >= 8));
});

test('editor services provide rename, fixes, formatting, documentation, tokens and hierarchies', async () => {
  const featureUri = URI.file(path.join(root, 'features.enaml')).toString();
  const text = 'class Base:\n    title: str\n    def greet(self, name):\n        """Return a greeting."""\n        return name\nclass Child(Base):\n    pass\nenamldef View(Child): view:\n    attr person = Child()\n    func render(value):\n        return view.person.greet(value)\n    result = render("hello")\n    text << tittle\n';
  const featureDoc = TextDocument.create(featureUri, 'enaml', 1, text);
  const point = (word, occurrence = 0) => {
    let index = -1;
    for (let i = 0; i <= occurrence; i++) index = text.indexOf(word, index + 1);
    return { textDocument: { uri: featureUri }, position: featureDoc.positionAt(index) };
  };
  await connection.sendNotification('textDocument/didOpen', { textDocument: { uri: featureUri, languageId: 'enaml', version: 1, text } });
  try {
    const hover = await request('textDocument/hover', point('greet(value)'));
    assert.match(hover.contents.value, /Return a greeting/);
    const prepared = await request('textDocument/prepareRename', point('render'));
    assert.equal(prepared.placeholder, 'render');
    const rename = await request('textDocument/rename', { ...point('render'), newName: 'format_value' });
    const edits = rename.documentChanges.find(change => change.textDocument.uri === featureUri);
    assert.equal(edits.textDocument.version, 1);
    assert.equal(edits.edits.length, 2);
    await assert.rejects(request('textDocument/rename', { ...point('render'), newName: 'person' }), /conflict/);
    await assert.rejects(request('textDocument/rename', { ...point('render'), newName: 'class' }), /identifier/);
    const diagnostics = notifications.findLast(n => n.uri === featureUri).diagnostics;
    const fixes = await request('textDocument/codeAction', { textDocument: { uri: featureUri }, range: prepared.range, context: { diagnostics } });
    assert.ok(fixes.some(fix => fix.title === "Change to 'title'"));
    const tokens = await request('textDocument/semanticTokens/full', { textDocument: { uri: featureUri } });
    assert.ok(tokens.data.length > 0 && tokens.data.length % 5 === 0);
    const hierarchy = await request('textDocument/prepareTypeHierarchy', point('Child'));
    const bases = await request('typeHierarchy/supertypes', { item: hierarchy[0] });
    assert.equal(bases[0].name, 'Base');
    const subtypes = await request('typeHierarchy/subtypes', { item: bases[0] });
    assert.ok(subtypes.some(item => item.name === 'Child'));
    const calls = await request('textDocument/prepareCallHierarchy', point('render'));
    const outgoing = await request('callHierarchy/outgoingCalls', { item: calls[0] });
    assert.equal(outgoing[0].to.name, 'greet');
    const incoming = await request('callHierarchy/incomingCalls', { item: outgoing[0].to });
    assert.ok(incoming.some(item => item.from.name === 'render'));
    const snippets = await request('textDocument/completion', point('render'));
    assert.ok(snippets.some(item => item.kind === 15 && item.insertTextFormat === 2));
    configuration = { sourcePaths: [], diagnostics: { enabled: true }, inlayHints: { enabled: true }, codeLens: { enabled: true } };
    await connection.sendNotification('workspace/didChangeConfiguration', { settings: { enaml: configuration } });
    const hints = await request('textDocument/inlayHint', { textDocument: { uri: featureUri }, range: { start: { line: 0, character: 0 }, end: featureDoc.positionAt(text.length) } });
    assert.ok(hints.some(hint => hint.label === ': Child'));
    assert.ok(hints.some(hint => hint.label === 'value:'));
    const lenses = await request('textDocument/codeLens', { textDocument: { uri: featureUri } });
    const lens = await request('codeLens/resolve', lenses.find(lens => lens.range.start.line === 9));
    assert.equal(lens.command.title, '1 references');
    const formatting = await request('textDocument/formatting', { textDocument: { uri: featureUri }, options: { tabSize: 4, insertSpaces: true } });
    assert.deepEqual(formatting, []);
  } finally {
    await connection.sendNotification('textDocument/didClose', { textDocument: { uri: featureUri } });
  }
});

test('auto imports, import sorting and cross-file rename preserve explicit aliases', async () => {
  const testUri = URI.file(path.join(root, 'imports.enaml')).toString();
  const text = 'from models import Person as User\n\nenamldef View(Html):\n    user = User()\n    result = Person()\n';
  const doc = TextDocument.create(testUri, 'enaml', 1, text);
  await connection.sendNotification('textDocument/didOpen', { textDocument: { uri: testUri, languageId: 'enaml', version: 1, text } });
  try {
    const completion = await request('textDocument/completion', { textDocument: { uri: testUri }, position: doc.positionAt(text.lastIndexOf('Person') + 3) });
    assert.ok(completion.some(item => item.label === 'Person' && item.additionalTextEdits?.[0].newText.includes('from models import Person')));
    const diagnostics = notifications.findLast(n => n.uri === testUri).diagnostics;
    const actions = await request('textDocument/codeAction', { textDocument: { uri: testUri }, range: { start: { line: 4, character: 13 }, end: { line: 4, character: 19 } }, context: { diagnostics } });
    assert.ok(actions.some(action => action.title === "Import 'Person' from models"));
    const rename = await request('textDocument/rename', { ...params(pos('Person')), newName: 'Human' });
    const imported = rename.documentChanges.find(change => change.textDocument.uri === testUri);
    assert.equal(imported.edits.length, 1);
    assert.deepEqual(imported.edits[0].range.start, { line: 0, character: 19 });
    await assert.rejects(request('textDocument/rename', { textDocument: { uri: testUri }, position: doc.positionAt(text.indexOf('User()')), newName: 'Other' }), /alias/);
    await connection.sendNotification('textDocument/didChange', { textDocument: { uri: testUri, version: 2 }, contentChanges: [{ text: 'import zebra\nimport alpha\n' }] });
    const sorting = await request('textDocument/codeAction', { textDocument: { uri: testUri }, range: { start: { line: 0, character: 0 }, end: { line: 1, character: 12 } }, context: { diagnostics: [], only: ['source.organizeImports'] } });
    assert.equal(sorting[0].edit.documentChanges[0].edits[0].newText, 'import alpha\nimport zebra\n');
  } finally {
    await connection.sendNotification('textDocument/didClose', { textDocument: { uri: testUri } });
  }
});

test('rename updates nested keyword calls and rejects inherited property collisions', async () => {
  const testUri = URI.file(path.join(root, 'rename_regressions.enaml')).toString();
  const text = 'class Base:\n    title: str\nclass Child(Base):\n    caption: str\ndef render(value):\n    return value\ndef untouched(value):\n    return value\nresult = render(value=1)\nother = untouched(value=2)\ndef caller():\n    item = 7\n    return render(\n        value=render(value=3)\n    )\n';
  const doc = TextDocument.create(testUri, 'enaml', 1, text);
  const point = offset => ({ textDocument: { uri: testUri }, position: doc.positionAt(offset) });
  await connection.sendNotification('textDocument/didOpen', { textDocument: { uri: testUri, languageId: 'enaml', version: 1, text } });
  try {
    const rename = await request('textDocument/rename', { ...point(text.indexOf('value')), newName: 'item' });
    const edits = rename.documentChanges.find(change => change.textDocument.uri === testUri).edits;
    assert.equal(edits.length, 5);
    const result = [...edits].sort((a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start)).reduce((source, edit) => source.slice(0, doc.offsetAt(edit.range.start)) + edit.newText + source.slice(doc.offsetAt(edit.range.end)), text);
    assert.ok(result.includes('def render(item):\n    return item'));
    assert.ok(result.includes('result = render(item=1)'));
    assert.ok(result.includes('item=render(item=3)'));
    assert.ok(result.includes('untouched(value=2)'));
    await assert.rejects(request('textDocument/rename', { ...point(text.indexOf('caption')), newName: 'title' }), /conflict/);
  } finally {
    await connection.sendNotification('textDocument/didClose', { textDocument: { uri: testUri } });
  }
});

test('rename rejects declarations outside the workspace', async () => {
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'enaml-external-'));
  const testUri = URI.file(path.join(root, 'external.enaml')).toString();
  fs.writeFileSync(path.join(external, 'external_model.py'), 'class External:\n    pass\n');
  const text = 'from external_model import External\nenamldef View(External):\n    pass\n';
  configuration = { sourcePaths: [external], diagnostics: { enabled: true } };
  await connection.sendNotification('workspace/didChangeConfiguration', { settings: { enaml: configuration } });
  await connection.sendNotification('textDocument/didOpen', { textDocument: { uri: testUri, languageId: 'enaml', version: 1, text } });
  try {
    const point = { textDocument: { uri: testUri }, position: { line: 1, character: 14 } };
    const definition = await request('textDocument/definition', point);
    assert.equal(definition.uri, URI.file(path.join(external, 'external_model.py')).toString());
    assert.equal(await request('textDocument/prepareRename', point), null);
    await assert.rejects(request('textDocument/rename', { ...point, newName: 'Renamed' }), /workspace/);
    assert.equal(fs.readFileSync(path.join(external, 'external_model.py'), 'utf8'), 'class External:\n    pass\n');
  } finally {
    await connection.sendNotification('textDocument/didClose', { textDocument: { uri: testUri } });
    configuration = { sourcePaths: [], diagnostics: { enabled: true } };
    await connection.sendNotification('workspace/didChangeConfiguration', { settings: { enaml: configuration } });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test('incremental edits update definitions and diagnostics; settings clear diagnostics', async () => {
  await connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [
    { range: { start: pos('render'), end: { ...pos('render'), character: pos('render').character + 6 } }, text: 'format' }
  ] });
  assert.equal(await request('textDocument/definition', params(pos('render', 1))), null);
  const broken = 'enamldef Broken(Html)\n    value = unknown_value\n';
  await connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: 3 }, contentChanges: [{ text: broken }] });
  // Requests are a protocol barrier for notifications handled before them.
  await request('textDocument/documentSymbol', { textDocument: { uri } });
  const diagnostic = notifications.findLast(n => n.uri === uri && n.version === 3)?.diagnostics;
  assert.ok(diagnostic.length > 0);
  assert.ok(diagnostic.some(item => item.message === "Unknown name 'unknown_value'." && item.severity === 1));
  configuration = { sourcePaths: [], diagnostics: { enabled: false } };
  await connection.sendNotification('workspace/didChangeConfiguration', { settings: { enaml: configuration } });
  await request('textDocument/documentSymbol', { textDocument: { uri } });
  assert.deepEqual(notifications.filter(n => n.uri === uri).at(-1).diagnostics, []);
});
