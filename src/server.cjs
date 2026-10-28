const {
  createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind,
  CompletionItemKind, DiagnosticSeverity
} = require('vscode-languageserver/node');
const { TextDocument } = require('vscode-languageserver-textdocument');
const { URI } = require('vscode-uri');
const { Project, Kind, keywords } = require('./analysis.cjs');

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const project = new Project();
let settings = { sourcePaths: [], diagnostics: { enabled: true } };
let folders = [];
const completionKind = kind => ({ [Kind.Class]: CompletionItemKind.Class, [Kind.Function]: CompletionItemKind.Function,
  [Kind.Method]: CompletionItemKind.Method, [Kind.Property]: CompletionItemKind.Property,
  [Kind.Event]: CompletionItemKind.Event, [Kind.Module]: CompletionItemKind.Module,
  [Kind.Constant]: CompletionItemKind.Constant })[kind] || CompletionItemKind.Variable;

connection.onInitialize(params => {
  folders = (params.workspaceFolders || (params.rootUri ? [{ uri: params.rootUri }] : []))
    .filter(f => URI.parse(f.uri).scheme === 'file').map(f => URI.parse(f.uri).fsPath);
  project.configure(folders);
  return { capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    definitionProvider: true,
    referencesProvider: true,
    hoverProvider: true,
    documentSymbolProvider: true,
    workspaceSymbolProvider: true,
    documentHighlightProvider: true,
    foldingRangeProvider: true,
    completionProvider: { triggerCharacters: ['.'] },
    signatureHelpProvider: { triggerCharacters: ['(', ','] },
    workspace: { workspaceFolders: { supported: true, changeNotifications: true } }
  }, serverInfo: { name: 'Enaml Language Server', version: '0.2.0' } };
});

connection.onInitialized(async () => {
  try {
    settings = await connection.workspace.getConfiguration('enaml') || settings;
    project.configure(folders, settings.sourcePaths || []);
    for (const doc of documents.all()) publish(doc);
  } catch (error) { connection.console.warn(`Could not read Enaml settings: ${error.message}`); }
  connection.workspace.onDidChangeWorkspaceFolders(event => {
    const removed = new Set(event.removed.map(f => URI.parse(f.uri).fsPath));
    folders = folders.filter(f => !removed.has(f));
    folders.push(...event.added.filter(f => URI.parse(f.uri).scheme === 'file').map(f => URI.parse(f.uri).fsPath));
    project.configure(folders, settings.sourcePaths || []);
  });
});
connection.onDidChangeConfiguration(change => {
  settings = change.settings?.enaml || settings;
  project.configure(folders, settings.sourcePaths || []);
  for (const doc of documents.all()) publish(doc);
});
connection.onDidChangeWatchedFiles(change => { for (const file of change.changes) project.invalidate(file.uri); });

function publish(document) {
  const doc = project.update(document.uri, document.getText());
  const diagnostics = settings.diagnostics?.enabled === false ? [] : doc.issues.slice(0, 100).map(issue => ({
    range: doc.range(issue.start, issue.end), message: issue.message, severity: DiagnosticSeverity.Error,
    source: 'enaml', code: 'structural-syntax'
  }));
  connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics });
}
documents.onDidChangeContent(event => publish(event.document));
documents.onDidClose(event => { project.close(event.document.uri); connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] }); });

function context(params) { return project.load(params.textDocument.uri); }
function symbolAt(params) { const doc = context(params); return doc && project.at(doc, params.position); }
connection.onDefinition(params => project.location(symbolAt(params)));
connection.onHover(params => {
  const symbol = symbolAt(params);
  if (!symbol) return null;
  return { contents: { kind: 'markdown', value: '```enaml\n' + (symbol.detail || symbol.name).replace(/```/g, '') + '\n```' } };
});

function sameSymbol(a, b) {
  return a && b && a.uri === b.uri && a.start === b.start && a.name === b.name;
}
function references(doc, target, includeDeclaration) {
  const results = [];
  for (const token of doc.tokens) {
    if (token.value === '.') continue;
    const found = project.at(doc, doc.position(token.start));
    if (!sameSymbol(found, target)) continue;
    const declared = doc.symbols.some(s => !s.anonymous && s.start === token.start);
    if (!includeDeclaration && declared) continue;
    results.push({ uri: doc.uri, range: doc.range(token.start, token.end) });
  }
  return results;
}
connection.onReferences(async (params, cancellation) => {
  const target = symbolAt(params);
  if (!target) return [];
  const results = [];
  let scanned = 0;
  for (const uri of project.files()) {
    if (++scanned % 25 === 0) await new Promise(resolve => setImmediate(resolve));
    if (cancellation.isCancellationRequested) break;
    const doc = project.load(uri);
    if (doc) results.push(...references(doc, target, params.context.includeDeclaration));
  }
  return results;
});
connection.onDocumentHighlight(params => {
  const doc = context(params), target = symbolAt(params);
  return doc && target ? references(doc, target, true).map(location => ({ range: location.range, kind: 1 })) : [];
});

connection.onDocumentSymbol(params => {
  const doc = context(params);
  if (!doc) return [];
  function symbols(scope) {
    const result = [];
    for (const symbol of doc.symbols.filter(s => s.scope === scope)) {
      const selectionRange = doc.range(symbol.start, symbol.end);
      const children = symbol.inner ? symbols(symbol.inner) : [];
      // Anonymous components still form useful containers in the outline.
      result.push({ name: symbol.name, detail: symbol.detail, kind: symbol.kind,
        range: doc.range(symbol.start, Math.max(symbol.end, symbol.inner?.end || symbol.end)), selectionRange,
        ...(children.length ? { children } : {}) });
    }
    return result;
  }
  return symbols(doc.root);
});
connection.onWorkspaceSymbol(async (params, cancellation) => {
  const query = params.query.toLowerCase(), results = [];
  let scanned = 0;
  for (const uri of project.files()) {
    if (++scanned % 25 === 0) await new Promise(resolve => setImmediate(resolve));
    if (cancellation.isCancellationRequested || results.length >= 500) break;
    const doc = project.load(uri);
    if (!doc) continue;
    for (const symbol of doc.symbols) {
      if (!symbol.anonymous && !symbol.imported && symbol.name.toLowerCase().includes(query)) {
        results.push({ name: symbol.name, kind: symbol.kind, location: project.location(symbol),
          containerName: symbol.scope.symbol?.name });
      }
      if (results.length >= 500) break;
    }
  }
  return results;
});
connection.onFoldingRanges(params => {
  const doc = context(params);
  return doc ? doc.scopes.filter(s => s.symbol).map(s => ({
    startLine: doc.position(s.start).line,
    endLine: doc.position(Math.max(s.start, s.end - 1)).line
  })).filter(r => r.endLine > r.startLine) : [];
});

function members(symbol, seen = new Set()) {
  symbol = project.unwrap(symbol);
  if (!symbol) return [];
  const key = `${symbol.uri}:${symbol.start}`;
  if (seen.has(key)) return [];
  seen.add(key);
  if (symbol.moduleDoc) return symbol.moduleDoc.symbols.filter(s => s.scope === symbol.moduleDoc.root && !s.anonymous);
  const doc = project.load(symbol.uri);
  if (!doc) return [];
  const result = doc.symbols.filter(s => s.scope === symbol.inner && !s.anonymous);
  if (symbol.instanceOf) result.push(...members(symbol.instanceOf, seen));
  if (symbol.target) result.push(...members(project.resolveChain(doc, symbol.target.split('.'), symbol.scope), seen));
  if (symbol.type) result.push(...members(project.resolveChain(doc, symbol.type.split('.'), symbol.scope), seen));
  if (symbol.parameter && /^(self|cls)$/.test(symbol.name)) {
    let scope = symbol.scope;
    while (scope && scope.symbol?.kind !== Kind.Class) scope = scope.parent;
    if (scope) result.push(...members(scope.symbol, seen));
  }
  for (const base of symbol.bases || []) result.push(...members(project.resolveChain(doc, base.split('.'), symbol.scope), seen));
  return result;
}
connection.onCompletion(params => {
  const doc = context(params);
  if (!doc) return [];
  const offset = doc.offset(params.position), scope = doc.scopeAt(offset);
  // Do not offer code symbols inside comments and strings.
  if (doc.text.slice(0, offset).match(/\S$/) && doc.mask[offset - 1] === ' ' && doc.text[offset - 1] !== ' ') return [];
  const before = doc.mask.slice(doc.offsets[params.position.line], offset);
  const member = /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.([A-Za-z_]\w*)?$/.exec(before);
  let available = [];
  if (member) available = members(project.resolveChain(doc, member[1].split('.'), scope));
  else {
    for (let current = scope; current; current = current.parent) {
      available.push(...doc.symbols.filter(s => s.scope === current && !s.anonymous));
      if (current.symbol) available.push(...members(current.symbol));
    }
    for (const star of doc.stars) {
      if (!project.isAncestor(star.scope, scope)) continue;
      const module = project.module(doc.uri, star.module);
      if (module) available.push(...module.symbols.filter(s => s.scope === module.root && !s.anonymous && !s.name.startsWith('_')));
    }
  }
  const unique = new Map();
  for (const symbol of available) if (!unique.has(symbol.name)) unique.set(symbol.name,
    { label: symbol.name, kind: completionKind(symbol.kind), detail: symbol.detail });
  if (!member) for (const label of keywords) if (!unique.has(label)) unique.set(label, { label, kind: CompletionItemKind.Keyword });
  return [...unique.values()];
});

connection.onSignatureHelp(params => {
  const doc = context(params);
  if (!doc) return null;
  const offset = doc.offset(params.position);
  let depth = 0, activeParameter = 0, open = -1;
  for (let i = offset - 1; i >= 0; i--) {
    const ch = doc.mask[i];
    if (')]}'.includes(ch)) depth++;
    else if ('([{'.includes(ch)) { if (depth === 0 && ch === '(') { open = i; break; } depth--; }
    else if (ch === ',' && depth === 0) activeParameter++;
  }
  if (open < 0) return null;
  const call = /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*$/.exec(doc.mask.slice(0, open));
  if (!call) return null;
  const symbol = project.unwrap(project.resolveChain(doc, call[1].split('.'), doc.scopeAt(offset)));
  if (!symbol || ![Kind.Function, Kind.Method, Kind.Class].includes(symbol.kind)) return null;
  const target = project.load(symbol.uri);
  const parameters = target.symbols.filter(s => s.parameter && s.scope === symbol.inner && !/^(self|cls)$/.test(s.name));
  return { signatures: [{ label: symbol.detail || symbol.name, parameters: parameters.map(p => ({ label: p.name })) }],
    activeSignature: 0, activeParameter: Math.min(activeParameter, Math.max(0, parameters.length - 1)) };
});

documents.listen(connection);
connection.listen();
