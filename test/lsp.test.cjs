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

test('incremental edits update definitions and diagnostics; settings clear diagnostics', async () => {
  await connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [
    { range: { start: pos('render'), end: { ...pos('render'), character: pos('render').character + 6 } }, text: 'format' }
  ] });
  assert.equal(await request('textDocument/definition', params(pos('render', 1))), null);
  const broken = 'enamldef Broken(Html)\n    value = (1]\n';
  await connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: 3 }, contentChanges: [{ text: broken }] });
  // Requests are a protocol barrier for notifications handled before them.
  await request('textDocument/documentSymbol', { textDocument: { uri } });
  assert.ok(notifications.findLast(n => n.uri === uri && n.version === 3)?.diagnostics.length > 0);
  configuration = { sourcePaths: [], diagnostics: { enabled: false } };
  await connection.sendNotification('workspace/didChangeConfiguration', { settings: { enaml: configuration } });
  await request('textDocument/documentSymbol', { textDocument: { uri } });
  assert.deepEqual(notifications.filter(n => n.uri === uri).at(-1).diagnostics, []);
});
