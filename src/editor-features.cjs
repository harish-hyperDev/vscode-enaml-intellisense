const path = require('node:path');
const fs = require('node:fs');
const { URI } = require('vscode-uri');
const { ResponseError, ErrorCodes } = require('vscode-languageserver/node');
const { keywords, Kind } = require('./analysis.cjs');
const { keywordCalls } = require('./call-sites.cjs');
const { identity, isWord, visible, distance, exportsFor, snippets, format, documentation, organizeImports } = require('./intelligence.cjs');

const capabilities = {
  renameProvider: { prepareProvider: true }, codeActionProvider: { codeActionKinds: ['quickfix', 'source.organizeImports'] },
  documentFormattingProvider: true, inlayHintProvider: true, codeLensProvider: { resolveProvider: true },
  callHierarchyProvider: true, typeHierarchyProvider: true,
  semanticTokensProvider: { legend: { tokenTypes: ['class', 'function', 'parameter', 'property', 'variable', 'namespace', 'event'], tokenModifiers: ['declaration', 'readonly'] }, full: true }
};

function install(connection, project, documents, getSettings) {
  const context = params => project.load(params.textDocument.uri);
  const at = params => { const doc = context(params); return doc && project.at(doc, params.position); };
  const error = message => { throw new ResponseError(ErrorCodes.InvalidParams, message); };
  const editable = uri => {
    if (URI.parse(uri).scheme !== 'file') return false;
    let filename;
    try {
      const original = URI.parse(uri).fsPath;
      filename = fs.existsSync(original) ? fs.realpathSync(original) : path.join(fs.realpathSync(path.dirname(original)), path.basename(original));
    } catch { return false; }
    return project.roots.some(root => {
      try { const relative = path.relative(fs.realpathSync(root), filename); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); }
      catch { return false; }
    });
  };
  async function occurrences(target, cancellation, strict = false) {
    const result = [];
    let count = 0;
    for (const uri of project.files()) {
      if (++count % 10 === 0) await new Promise(resolve => setImmediate(resolve));
      if (cancellation?.isCancellationRequested) return null;
      if (strict && count >= 5000) error('Workspace scan limit reached. Narrow the workspace before renaming.');
      const doc = project.load(uri);
      if (!doc) { if (strict) error('A workspace source file could not be indexed. Rename was cancelled.'); else continue; }
      const spellings = new Set([target.name, ...doc.symbols.filter(s => s.imported?.name === target.name).map(s => s.name)]);
      for (const token of doc.tokens) {
        if (!spellings.has(token.value)) continue;
        // Imported aliases resolve to the same target, so don't filter by spelling here.
        if (identity(project.at(doc, doc.position(token.start))) === identity(target)) result.push({ doc, token });
      }
    }
    return result;
  }
  connection.onPrepareRename(params => {
    const doc = context(params), target = at(params);
    if (!doc || !target || !editable(target.uri) || target.imported || target.moduleDoc) return null;
    const offset = doc.offset(params.position), token = doc.tokens.find(t => t.start <= offset && offset < t.end);
    if (!token || token.value !== target.name) return null;
    return { range: doc.range(token.start, token.end), placeholder: target.name };
  });
  connection.onRenameRequest(async (params, cancellation) => {
    const target = at(params);
    const requestDoc = context(params), offset = requestDoc?.offset(params.position);
    const selected = requestDoc?.tokens.find(t => t.start <= offset && offset < t.end);
    if (!isWord(params.newName) || keywords.has(params.newName)) error('Choose a valid non-keyword identifier.');
    if (!target || !editable(target.uri) || target.imported || target.moduleDoc) error('Only resolved workspace declarations can be renamed.');
    if (selected?.value !== target.name) error('Rename the original declaration rather than an import alias.');
    const refs = await occurrences(target, cancellation, true);
    if (!refs) return null;
    const changes = new Map();
    const snapshots = new Map();
    for (const { doc, token } of refs) {
      // Preserve explicit import aliases and their uses. Edit the original import name only.
      if (token.value !== target.name) continue;
      const scope = doc.scopeAt(token.start);
      let local = keywordCalls(doc).has(token.start) ? null : project.lookup(doc, params.newName, scope);
      if (!local && target.scope.symbol?.kind === Kind.Class && !keywordCalls(doc).has(token.start)) {
        for (let current = scope; current && !local; current = current.parent) {
          if (current.symbol?.kind === Kind.Class) local = project.member(current.symbol, params.newName);
        }
      }
      if (local && identity(project.unwrap(local)) !== identity(target)) error(`Rename would conflict with '${params.newName}'.`);
      if (!editable(doc.uri)) continue;
      if (!changes.has(doc.uri)) changes.set(doc.uri, []);
      snapshots.set(doc.uri, doc);
      changes.get(doc.uri).push({ range: doc.range(token.start, token.end), newText: params.newName });
    }
    for (const [uri, snapshot] of snapshots) if (project.load(uri) !== snapshot) error('A document changed during rename. Retry the operation.');
    return { documentChanges: [...changes].map(([uri, edits]) => ({ textDocument: { uri, version: documents.get(uri)?.version ?? null }, edits })) };
  });
  connection.onCodeAction(async (params, cancellation) => {
    const doc = context(params);
    if (!doc) return [];
    const result = [];
    if (params.context.only?.some(kind => 'source.organizeImports' === kind || 'source.organizeImports'.startsWith(kind + '.'))) {
      const edits = organizeImports(doc);
      return edits.length ? [{ title: 'Sort imports', kind: 'source.organizeImports', edit: { documentChanges: [{ textDocument: { uri: doc.uri, version: documents.get(doc.uri)?.version ?? null }, edits }] } }] : [];
    }
    const action = (title, diagnostic, edits) => result.push({ title, kind: 'quickfix', diagnostics: [diagnostic], edit: { documentChanges: [{ textDocument: { uri: doc.uri, version: documents.get(doc.uri)?.version ?? null }, edits }] } });
    for (const diagnostic of params.context.diagnostics.slice(0, 20)) {
      if (diagnostic.source !== 'enaml') continue;
      const offset = doc.offset(diagnostic.range.start);
      if (diagnostic.code === 'unknown-name') {
        const name = doc.text.slice(offset, doc.offset(diagnostic.range.end));
        const suggestions = [...visible(project, doc, doc.scopeAt(offset)).keys()]
          .filter(candidate => candidate !== name && distance(name, candidate) <= 2).sort((a, b) => distance(name, a) - distance(name, b)).slice(0, 3);
        for (const suggestion of suggestions) action(`Change to '${suggestion}'`, diagnostic, [{ range: diagnostic.range, newText: suggestion }]);
        for (const { symbol, module } of await exportsFor(project, doc, name, cancellation)) {
          if (symbol.name !== name) continue;
          action(`Import '${name}' from ${module}`, diagnostic, [importEdit(doc, module, name)]);
        }
      }
      if (diagnostic.code === 'syntax' && diagnostic.message.includes('Expected a colon')) {
        const line = diagnostic.range.start.line, end = line + 1 < doc.offsets.length ? doc.offsets[line + 1] - 1 : doc.text.length;
        const insertion = doc.offsets[line] + doc.mask.slice(doc.offsets[line], end).trimEnd().length;
        action('Add missing colon', diagnostic, [{ range: doc.range(insertion, insertion), newText: ':' }]);
      }
      if (diagnostic.code === 'indentation' && diagnostic.message.includes('Mixed tabs')) {
        const line = diagnostic.range.start.line, start = doc.offsets[line];
        const indent = /^[ \t]*/.exec(doc.text.slice(start))[0];
        const width = [...indent].reduce((n, c) => c === '\t' ? n + 8 - n % 8 : n + 1, 0);
        action('Convert indentation to spaces', diagnostic, [{ range: doc.range(start, start + indent.length), newText: ' '.repeat(width) }]);
      }
      if (diagnostic.code === 'indentation' && diagnostic.message.includes('Unexpected indentation')) {
        const line = diagnostic.range.start.line, start = doc.offsets[line];
        const current = /^[ \t]*/.exec(doc.text.slice(start))[0];
        let prefix = '';
        for (let n = line - 1; n >= 0; n--) {
          const before = doc.mask.slice(doc.offsets[n], doc.offsets[n + 1] ?? doc.text.length);
          if (before.trim()) { prefix = /^[ \t]*/.exec(before)[0]; break; }
        }
        action('Match the previous statement indentation', diagnostic, [{ range: doc.range(start, start + current.length), newText: prefix }]);
      }
      if (diagnostic.code === 'unused-import') {
        const line = diagnostic.range.start.line, start = doc.offsets[line], end = doc.offsets[line + 1] ?? doc.text.length;
        const text = doc.text.slice(start, end).trim();
        // Delete a whole line only when there is exactly one simple import.
        if (/^(?:from\s+[.\w]+\s+import\s+\w+(?:\s+as\s+\w+)?|import\s+[.\w]+(?:\s+as\s+\w+)?)$/.test(text)) action('Remove unused import', diagnostic, [{ range: doc.range(start, end), newText: '' }]);
      }
    }
    return result;
  });
  connection.onDocumentFormatting(params => {
    const doc = context(params);
    return doc && getSettings().formatting?.enabled !== false ? format(doc, params.options) : [];
  });
  connection.languages.semanticTokens.on(params => {
    const doc = context(params);
    if (!doc || getSettings().semanticTokens?.enabled === false) return { data: [] };
    const data = [];
    let lastLine = 0, lastCharacter = 0;
    const type = symbol => symbol.parameter ? 2 : ({ [Kind.Class]: 0, [Kind.Function]: 1, [Kind.Method]: 1, [Kind.Property]: 3, [Kind.Module]: 5, [Kind.Event]: 6 })[symbol.kind] ?? 4;
    const declarations = new Set(doc.symbols.filter(s => !s.anonymous).map(s => s.start));
    for (const token of doc.tokens) {
      if (!isWord(token.value) || keywords.has(token.value)) continue;
      const symbol = project.at(doc, doc.position(token.start));
      if (!symbol) continue;
      const position = doc.position(token.start);
      data.push(position.line - lastLine, position.line === lastLine ? position.character - lastCharacter : position.character,
        token.end - token.start, type(symbol), (declarations.has(token.start) ? 1 : 0) | (symbol.kind === Kind.Constant ? 2 : 0));
      lastLine = position.line; lastCharacter = position.character;
    }
    return { data };
  });
  connection.languages.inlayHint.on(params => {
    const doc = context(params), settings = getSettings().inlayHints;
    if (!doc || settings?.enabled !== true) return [];
    const start = doc.offset(params.range.start), end = doc.offset(params.range.end), result = [];
    for (const symbol of doc.symbols) {
      if (symbol.start < start || symbol.start > end || symbol.imported || symbol.anonymous) continue;
      if (!/:/.test(symbol.detail.slice(0, symbol.detail.indexOf('=') < 0 ? undefined : symbol.detail.indexOf('=')))) {
        const value = /=\s*(.*)/.exec(symbol.detail)?.[1] || '';
        const constructor = symbol.type && project.unwrap(project.resolveChain(doc, symbol.type.split('.'), symbol.scope));
        const type = constructor?.kind === Kind.Class ? symbol.type : /^[-+]?\d+$/.test(value) ? 'int' : /^[-+]?\d+\.\d+$/.test(value) ? 'float' : /^(True|False)$/.test(value) ? 'bool' : /^(?:[rRuUbBfF]*)["']/.test(value) ? 'str' : /^\[/.test(value) ? 'list' : null;
        if (type) result.push({ position: doc.position(symbol.end), label: `: ${type}`, kind: 1, paddingLeft: true });
      }
    }
    // Parameter hints for simple calls whose argument boundaries are statically visible.
    for (let i = 0; i < doc.tokens.length; i++) {
      const token = doc.tokens[i];
      if (token.start < start || token.start > end || !/^\s*\(/.test(doc.mask.slice(token.end))) continue;
      if (doc.declaredAt.has(token.start)) continue;
      const symbol = project.at(doc, doc.position(token.start));
      if (![Kind.Function, Kind.Method].includes(symbol?.kind)) continue;
      const target = project.load(symbol.uri);
      const parameters = [...(target?.byScope.get(symbol.inner)?.values() || [])].filter(s => s.parameter && !/^(self|cls)$/.test(s.name));
      let cursor = doc.mask.indexOf('(', token.end) + 1, depth = 0, parameter = 0;
      let argumentStart = cursor;
      for (; cursor < Math.min(doc.mask.length, argumentStart + 10000); cursor++) {
        const ch = doc.mask[cursor];
        if ((ch === ',' || ch === ')') && depth === 0) {
          const raw = doc.text.slice(argumentStart, cursor), trimmed = raw.trimStart();
          if (trimmed.trim() && parameters[parameter] && !/^\w+\s*=/.test(trimmed)) result.push({ position: doc.position(argumentStart + raw.length - trimmed.length), label: `${parameters[parameter].name}:`, kind: 2, paddingRight: true });
          if (ch === ')') break;
          parameter++; argumentStart = cursor + 1;
        } else if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
      }
    }
    return result.slice(0, 300);
  });
  connection.onCodeLens(params => {
    const doc = context(params);
    if (!doc || getSettings().codeLens?.enabled !== true) return [];
    return doc.symbols.filter(s => [Kind.Class, Kind.Function, Kind.Method].includes(s.kind)).slice(0, 100)
      .map(symbol => ({ range: doc.range(symbol.start, symbol.end), data: { uri: doc.uri, start: symbol.start } }));
  });
  connection.onCodeLensResolve(async (lens, cancellation) => {
    const doc = project.load(lens.data.uri), symbol = doc?.symbols.find(s => s.start === lens.data.start);
    if (!symbol) return lens;
    const refs = await occurrences(symbol, cancellation);
    if (!refs) return lens;
    const locations = refs.filter(({ doc, token }) => doc.uri !== symbol.uri || token.start !== symbol.start).map(({ doc, token }) => ({ uri: doc.uri, range: doc.range(token.start, token.end) }));
    return { ...lens, command: { title: `${locations.length} references`, command: 'enaml.showReferences', arguments: [doc.uri, doc.position(symbol.start), locations] } };
  });
  const hierarchyItem = symbol => {
    const doc = project.load(symbol.uri);
    return { name: symbol.name, kind: symbol.kind, uri: symbol.uri, range: doc.range(symbol.start, symbol.inner?.end || symbol.end), selectionRange: doc.range(symbol.start, symbol.end), data: { uri: symbol.uri, start: symbol.start } };
  };
  const itemSymbol = item => project.load(item.data?.uri || item.uri)?.symbols.find(s => s.start === item.data?.start);
  connection.languages.callHierarchy.onPrepare(params => {
    const symbol = at(params);
    return symbol && [Kind.Function, Kind.Method].includes(symbol.kind) ? [hierarchyItem(symbol)] : null;
  });
  const calls = doc => {
    const result = [];
    for (const token of doc.tokens) {
      if (!isWord(token.value) || !/^\s*\(/.test(doc.mask.slice(token.end)) || doc.declaredAt.has(token.start)) continue;
      let scope = doc.scopeAt(token.start);
      while (scope && ![Kind.Function, Kind.Method].includes(scope.symbol?.kind)) scope = scope.parent;
      const target = project.at(doc, doc.position(token.start));
      if (scope && target && [Kind.Function, Kind.Method].includes(target.kind)) result.push({ from: scope.symbol, to: target, range: doc.range(token.start, token.end) });
    }
    return result;
  };
  connection.languages.callHierarchy.onOutgoingCalls(params => {
    const symbol = itemSymbol(params.item), doc = symbol && project.load(symbol.uri), groups = new Map();
    for (const call of doc ? calls(doc) : []) if (identity(call.from) === identity(symbol)) {
      const key = identity(call.to);
      if (!groups.has(key)) groups.set(key, { to: hierarchyItem(call.to), fromRanges: [] });
      groups.get(key).fromRanges.push(call.range);
    }
    return [...groups.values()];
  });
  connection.languages.callHierarchy.onIncomingCalls(async (params, cancellation) => {
    const symbol = itemSymbol(params.item), groups = new Map();
    if (!symbol) return [];
    let count = 0;
    for (const uri of project.files()) {
      if (++count % 10 === 0) await new Promise(resolve => setImmediate(resolve));
      if (cancellation?.isCancellationRequested) return [];
      const doc = project.load(uri);
      for (const call of doc ? calls(doc) : []) if (identity(call.to) === identity(symbol)) {
        const key = identity(call.from);
        if (!groups.has(key)) groups.set(key, { from: hierarchyItem(call.from), fromRanges: [] });
        groups.get(key).fromRanges.push(call.range);
      }
    }
    return [...groups.values()];
  });
  connection.languages.typeHierarchy.onPrepare(params => {
    const symbol = at(params);
    return symbol?.kind === Kind.Class ? [hierarchyItem(symbol)] : null;
  });
  const bases = symbol => {
    const doc = project.load(symbol.uri);
    return (symbol.bases || []).map(base => project.unwrap(project.resolveChain(doc, base.split('.'), symbol.scope))).filter(base => base?.kind === Kind.Class);
  };
  connection.languages.typeHierarchy.onSupertypes(params => {
    const symbol = itemSymbol(params.item);
    return symbol ? bases(symbol).map(hierarchyItem) : [];
  });
  connection.languages.typeHierarchy.onSubtypes(async (params, cancellation) => {
    const symbol = itemSymbol(params.item), result = [];
    if (!symbol) return result;
    let count = 0;
    for (const uri of project.files()) {
      if (++count % 10 === 0) await new Promise(resolve => setImmediate(resolve));
      if (cancellation?.isCancellationRequested) return [];
      const doc = project.load(uri);
      for (const candidate of doc?.symbols || []) if (candidate.kind === Kind.Class && bases(candidate).some(base => identity(base) === identity(symbol))) result.push(hierarchyItem(candidate));
    }
    return result;
  });
}

function importEdit(doc, module, name) {
  // Preserve the module preamble, including multiline future imports.
  let offset = 0;
  const lineEnd = start => { const end = doc.text.indexOf('\n', start); return end < 0 ? doc.text.length : end + 1; };
  function skipTrivia() {
    while (offset < doc.text.length) {
      const end = lineEnd(offset);
      if (!/^[ \t]*(?:#[^\r\n]*)?\s*$/.test(doc.text.slice(offset, end))) break;
      offset = end;
    }
  }
  skipTrivia();
  if (/^(?:[rRuU])?["']/.test(doc.text.slice(offset))) {
    const string = doc.strings.find(s => s.start >= offset && s.start <= offset + 1);
    if (string) offset = lineEnd(string.end);
  }
  skipTrivia();
  while (/^from[ \t]+__future__[ \t]+import\b/.test(doc.mask.slice(offset))) {
    let depth = 0, end = offset;
    for (; end < doc.mask.length; end++) {
      const ch = doc.mask[end];
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
      else if (ch === '\n' && !depth && !/\\\r?$/.test(doc.mask.slice(offset, end))) { end++; break; }
    }
    offset = end;
    skipTrivia();
  }
  const newline = doc.text.includes('\r\n') ? '\r\n' : '\n';
  const separator = offset && !/[\r\n]/.test(doc.text[offset - 1]) ? newline : '';
  return { range: doc.range(offset, offset), newText: `${separator}from ${module} import ${name}${newline}` };
}

module.exports = { install, capabilities, importEdit, snippets, exportsFor, documentation };
