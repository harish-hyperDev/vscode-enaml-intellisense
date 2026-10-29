// Static editor services: never execute project files or invoke a shell.
const path = require('node:path');
const { URI } = require('vscode-uri');
const { keywords } = require('./analysis.cjs');
const builtinNames = new Set(('abs all any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip __import__ Exception ValueError TypeError RuntimeError KeyError IndexError StopIteration NotImplementedError OSError FileNotFoundError AttributeError NotImplemented Ellipsis __name__ __file__ __package__ __doc__ __builtins__ self cls').split(' '));
const identity = s => s && `${s.uri}:${s.start}:${s.name}`;
const isWord = value => /^[A-Za-z_]\w*$/.test(value);
const limit = 100;

function visible(project, doc, scope) {
  const found = new Map();
  const seen = new Set();
  function members(symbol) {
    symbol = project.unwrap(symbol);
    if (!symbol || seen.has(identity(symbol)) || seen.size > 128) return;
    seen.add(identity(symbol));
    const target = project.load(symbol.uri);
    if (!target) return;
    for (const child of target.byScope.get(symbol.inner)?.values() || []) if (!child.anonymous && !found.has(child.name)) found.set(child.name, child);
    if (symbol.instanceOf) members(symbol.instanceOf);
    for (const base of symbol.bases || []) members(project.resolveChain(target, base.split('.'), symbol.scope));
  }
  for (let current = scope; current; current = current.parent) {
    for (const symbol of doc.byScope.get(current)?.values() || []) {
      if (!symbol.anonymous && !found.has(symbol.name)) found.set(symbol.name, symbol);
    }
    if (current.symbol) members(current.symbol);
  }
  return found;
}

function issueCode(issue) {
  return /indent|indented|tabs/i.test(issue.message) ? 'indentation' : 'syntax';
}

function diagnostics(project, doc, options = {}) {
  if (options.enabled === false) return [];
  const issues = doc.issues.map(issue => ({ ...issue, code: issueCode(issue) }))
    .filter(issue => options[issue.code] !== false);
  if (!URI.parse(doc.uri).path.endsWith('.enaml')) return issues.slice(0, limit);
  const push = issue => { if (issues.length < limit) issues.push(issue); };
  const declarations = new Map(doc.symbols.map(s => [s.start, s]));
  const used = new Set();
  const imports = doc.symbols.filter(s => s.imported);
  const unresolvedStar = doc.stars.some(s => !project.module(doc.uri, s.module));
  if (options.unresolvedImports !== false) {
    for (const symbol of imports) {
      const target = project.module(doc.uri, symbol.imported.module);
      if (!target) push({ start: symbol.start, end: symbol.end, code: 'unresolved-import', message: `Cannot resolve import '${symbol.imported.module}'. Configure enaml.sourcePaths for installed packages.`, severity: 2 });
    }
  }
  if (options.duplicates !== false) {
    const seen = new Map();
    for (const symbol of doc.symbols) {
      if (symbol.anonymous || symbol.binding) continue;
      if (!seen.has(symbol.scope)) seen.set(symbol.scope, new Set());
      if (seen.get(symbol.scope).has(symbol.name)) push({ start: symbol.start, end: symbol.end, code: 'duplicate-declaration', message: `Duplicate declaration '${symbol.name}'.` });
      seen.get(symbol.scope).add(symbol.name);
    }
  }
  if (options.unresolvedTypes === true) {
    for (const symbol of doc.symbols) {
      const names = [...(symbol.bases || []), ...(symbol.type && /:\s*\w/.test(symbol.detail) ? [symbol.type] : [])];
      for (const name of names) {
        if (builtinNames.has(name) || project.unwrap(project.resolveChain(doc, name.split('.'), symbol.scope))) continue;
        const lineEnd = doc.text.indexOf('\n', symbol.start);
        const position = doc.mask.indexOf(name, symbol.end);
        if (position >= 0 && (lineEnd < 0 || position < lineEnd)) push({ start: position, end: position + name.length, code: 'unknown-type', message: `Unknown type '${name}'.` });
      }
    }
  }
  if (options.bindings === true) {
    function complete(symbol, seen = new Set()) {
      symbol = project.unwrap(symbol);
      if (!symbol || symbol.imported || seen.has(identity(symbol)) || seen.size > 128) return false;
      seen.add(identity(symbol));
      const target = project.load(symbol.uri);
      if (symbol.type) return complete(project.resolveChain(target, symbol.type.split('.'), symbol.scope), seen);
      if (symbol.kind !== 5) return false;
      return (symbol.bases || []).every(base => complete(project.resolveChain(target, base.split('.'), symbol.scope), new Set(seen)));
    }
    for (const symbol of doc.symbols) {
      const receiver = symbol.scope.symbol;
      if (!symbol.binding || !receiver || !complete(receiver)) continue;
      const found = project.member(receiver, symbol.name);
      if (!found || found === symbol) push({ start: symbol.start, end: symbol.end, code: 'invalid-binding', message: `No declared property '${symbol.name}' exists on this component.` });
    }
  }
  // One linear token pass. Resolution itself uses binary token lookup and scope indexes.
  const lines = doc.mask.split('\n');
  const expressionLocals = lines.map(line => {
    const names = new Set();
    for (const match of line.matchAll(/\bfor\s+(\w+(?:\s*,\s*\w+)*)\s+in\b/g)) for (const name of match[1].split(',')) names.add(name.trim());
    const lambda = /\blambda\s+([\w, ]+)\s*:/.exec(line);
    if (lambda) for (const name of lambda[1].split(',')) names.add(name.trim());
    return names;
  });
  const expressionStarts = lines.map((line, i) => {
    if (/^\s*(?:from|import)\b/.test(line)) return Infinity;
    const expression = /(?:<<|>>|:=|(?<![<>=!])=(?!=)|\b(?:return|yield|raise|assert|if|elif|while)\b)\s*(.*)$/.exec(line);
    if (expression) return doc.offsets[i] + expression.index + expression[0].length - expression[1].length;
    if (/^\s*(?:await\s+)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*\(/.test(line)) return doc.offsets[i];
    return Infinity;
  });
  let lineNumber = 0;
  for (let i = 0; i < doc.tokens.length && issues.length < limit; i++) {
    const token = doc.tokens[i];
    while (lineNumber + 1 < doc.offsets.length && token.start >= doc.offsets[lineNumber + 1]) lineNumber++;
    if (!isWord(token.value) || keywords.has(token.value) || declarations.has(token.start)) continue;
    const scope = doc.scopeAt(token.start);
    const direct = project.lookup(doc, token.value, scope);
    if (direct?.imported) used.add(direct.start);
    if (token.start < expressionStarts[lineNumber] || builtinNames.has(token.value) || expressionLocals[lineNumber].has(token.value)) continue;
    const previous = doc.tokens[i - 1], next = doc.tokens[i + 1];
    if (next?.value === '.' && !doc.mask.slice(token.end, next.start).includes('\n')) {
      if (previous?.value !== '.' && options.unresolvedNames !== false && !unresolvedStar && !project.at(doc, doc.position(token.start))) {
        push({ start: token.start, end: token.end, code: 'unknown-name', message: `Unknown name '${token.value}'.`, data: { name: token.value } });
      }
      continue;
    }
    // Keyword argument labels are not variable reads.
    if (/^\s*=(?!=)/.test(doc.mask.slice(token.end)) && /[(,]\s*$/.test(doc.mask.slice(doc.offsets[lineNumber], token.start))) continue;
    if (project.at(doc, doc.position(token.start))) continue;
    const member = previous?.value === '.';
    if (member) {
      if (options.unresolvedMembers !== true) continue;
      const owner = project.at(doc, doc.position(doc.tokens[i - 2].start));
      // Unknown/dynamic external receivers cannot establish that a member is absent.
      if (!owner || owner.imported || (!owner.inner && !owner.instanceOf && !owner.type && !owner.moduleDoc)) continue;
    } else if (options.unresolvedNames === false || unresolvedStar) continue;
    push({ start: token.start, end: token.end, code: member ? 'unknown-member' : 'unknown-name', message: `Unknown ${member ? 'member' : 'name'} '${token.value}'.`, data: { name: token.value } });
  }
  if (options.unusedImports === true) {
    for (const symbol of imports) if (!used.has(symbol.start)) push({ start: symbol.start, end: symbol.end, severity: 2, tags: [1], code: 'unused-import', message: `Import '${symbol.name}' is unused.` });
  }
  return issues.slice(0, limit);
}

function documentation(project, symbol) {
  if (!symbol) return '';
  const doc = project.load(symbol.uri);
  if (!doc || !symbol.inner) return '';
  const after = doc.text.indexOf('\n', symbol.start);
  if (after < 0) return '';
  const match = /^\s*(?:[rRuU])?("""|''')([\s\S]*?)\1/.exec(doc.text.slice(after, Math.min(symbol.inner.end, after + 12000)));
  return match ? match[2].trim() : '';
}

function format(doc, options = {}) {
  const edits = [];
  const hasIndentationError = doc.issues.some(issue => issueCode(issue) === 'indentation');
  const tabSize = Math.max(1, Math.min(16, Number(options.tabSize) || 4));
  const levels = [0];
  let stringIndex = 0;
  for (let n = 0; n < doc.offsets.length; n++) {
    const start = doc.offsets[n], end = n + 1 < doc.offsets.length ? doc.offsets[n + 1] - 1 : doc.text.length;
    const line = doc.text.slice(start, end).replace(/\r$/, '');
    while (stringIndex < doc.strings.length && doc.strings[stringIndex].end <= start) stringIndex++;
    const string = doc.strings[stringIndex];
    if (string && string.start < start && string.end > start) continue;
    const indent = /^[ \t]*/.exec(line)[0];
    const width = [...indent].reduce((column, ch) => ch === '\t' ? column + 8 - column % 8 : column + 1, 0);
    let replacement = line;
    // Preserve continuation alignment; only normalize structural indentation.
    if (doc.structuralLines.has(n) && !hasIndentationError) {
      while (levels.length > 1 && width < levels.at(-1)) levels.pop();
      if (width > levels.at(-1)) levels.push(width);
      const prefix = options.insertSpaces === false ? '\t'.repeat(levels.length - 1) : ' '.repeat((levels.length - 1) * tabSize);
      replacement = prefix + line.slice(indent.length);
    }
    if (!string || string.start >= start + line.length || string.end <= start + line.trimEnd().length) replacement = replacement.trimEnd();
    if (replacement !== line) edits.push({ range: doc.range(start, start + line.length), newText: replacement });
  }
  return edits;
}

function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] !== b[j - 1]));
    row = next;
  }
  return row[b.length];
}

function workspaceModule(project, source, target) {
  const filename = URI.parse(target).fsPath;
  const root = project.roots.find(root => { const relative = path.relative(root, filename); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); });
  if (!root || source === target) return null;
  const relative = path.relative(root, filename).replace(/\.(enaml|pyi|py)$/, '').replace(/[\\/]__init__$/, '');
  const parts = relative.split(/[\\/]/);
  return parts.every(isWord) ? parts.join('.') : null;
}

async function exportsFor(project, doc, prefix, cancellation) {
  if (!prefix || prefix.length < 2) return [];
  const result = [];
  let scanned = 0;
  for (const uri of project.files()) {
    if (++scanned % 20 === 0) await new Promise(resolve => setImmediate(resolve));
    if (cancellation?.isCancellationRequested || result.length >= 40 || scanned > 300) break;
    const module = workspaceModule(project, doc.uri, uri);
    if (!module) continue;
    const target = project.load(uri);
    let symbolsScanned = 0;
    for (const symbol of target?.byScope.get(target.root)?.values() || []) {
      if (++symbolsScanned % 128 === 0) await new Promise(resolve => setImmediate(resolve));
      if (cancellation?.isCancellationRequested) return [];
      if (!symbol.imported && !symbol.anonymous && !symbol.name.startsWith('_') && symbol.name.startsWith(prefix)) result.push({ symbol, module });
      if (result.length === 40) return result;
    }
  }
  return result;
}

const snippets = [
  ['enamldef', 'enamldef ${1:View}(${2:Container}): ${3:view}:\n\t$0'],
  ['attr', 'attr ${1:name}: ${2:str} = ${3:None}'],
  ['event', 'event ${1:name}'], ['const', 'const ${1:name} = ${2:None}'], ['alias', 'alias ${1:name}: ${2:target}'],
  ['func', 'func ${1:name}(${2:args}):\n\t$0'],
  ['component', '${1:Container}: ${2:component}:\n\t$0']
];

function organizeImports(doc) {
  const edits = [], lines = doc.text.split('\n');
  for (let n = 0; n < lines.length;) {
    const begin = n;
    while (n < lines.length && /^(?:from\s+[.\w]+\s+import\s+[\w ,]+|import\s+[\w., ]+)\r?$/.test(lines[n]) && !lines[n].includes('#')) n++;
    if (n - begin > 1) {
      const before = lines.slice(begin, n), sorted = [...before].sort((a, b) => {
        const futureA = a.startsWith('from __future__ '), futureB = b.startsWith('from __future__ ');
        return futureA !== futureB ? (futureA ? -1 : 1) : a < b ? -1 : a > b ? 1 : 0;
      });
      if (before.some((line, i) => line !== sorted[i])) {
        const start = doc.offsets[begin], end = n < doc.offsets.length ? doc.offsets[n] : doc.text.length;
        edits.push({ range: doc.range(start, end), newText: sorted.join('\n') + (n < doc.offsets.length ? '\n' : '') });
      }
    }
    if (n === begin) n++;
  }
  return edits;
}

module.exports = { diagnostics, documentation, format, visible, distance, exportsFor, snippets, identity, isWord, builtinNames, organizeImports };
