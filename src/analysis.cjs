// A tolerant structural index for Enaml and Python source. It never executes imports.
const fs = require('node:fs');
const path = require('node:path');
const { URI } = require('vscode-uri');

const Kind = { Module: 2, Class: 5, Method: 6, Property: 7, Function: 12, Variable: 13, Constant: 14, Event: 24 };
const ignored = new Set(['.git', '.venv', 'venv', 'env', 'node_modules', '__pycache__', 'dist', 'build', '.tox']);
const keywords = new Set(('enamldef template func attr event const alias class def if elif else for while try except finally with as return yield pass break continue import from in is not and or lambda async await raise assert del global nonlocal match case True False None').split(' '));
const identifier = /^[A-Za-z_]\w*$/;

function scan(text) {
  const chars = text.split('');
  const tokens = [];
  const brackets = [];
  const issues = [];
  let i = 0;
  const blank = (start, end) => { for (let p = start; p < end; p++) if (chars[p] !== '\n' && chars[p] !== '\r') chars[p] = ' '; };
  while (i < text.length) {
    if (text[i] === '#') {
      const start = i;
      while (i < text.length && text[i] !== '\n') i++;
      blank(start, i);
    } else if (text[i] === '"' || text[i] === "'") {
      const start = i;
      const quote = text.slice(i, i + 3) === text[i].repeat(3) ? text[i].repeat(3) : text[i];
      i += quote.length;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text.startsWith(quote, i)) { i += quote.length; closed = true; break; }
        if (quote.length === 1 && text[i] === '\n') break;
        i++;
      }
      i = Math.min(i, text.length);
      if (!closed) issues.push({ start, end: start + quote.length, message: 'Unterminated string literal.' });
      blank(start, i);
    } else if (/[A-Za-z_]/.test(text[i])) {
      const start = i++;
      while (i < text.length && /\w/.test(text[i])) i++;
      // String prefixes belong to the string, not to the reference index.
      const value = text.slice(start, i);
      if (/^(?:r|u|b|f|br|rb|fr|rf)$/i.test(value) && /["']/.test(text[i] || ' ')) {
        blank(start, i);
      } else tokens.push({ value, start, end: i });
    } else {
      const ch = text[i];
      if ('([{'.includes(ch)) brackets.push({ ch, start: i });
      if (')]}'.includes(ch)) {
        if (brackets.at(-1)?.ch === '([{'.charAt(')]}'.indexOf(ch))) brackets.pop();
        else issues.push({ start: i, end: i + 1, message: `Unexpected closing delimiter '${ch}'.` });
      }
      if (ch === '.') tokens.push({ value: ch, start: i, end: i + 1 });
      i++;
    }
  }
  for (const b of brackets) issues.push({ start: b.start, end: b.start + 1, message: `Unclosed delimiter '${b.ch}'.` });
  return { mask: chars.join(''), tokens, issues };
}

function analyze(uri, text) {
  const scanned = scan(text);
  const offsets = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') offsets.push(i + 1);
  const position = offset => {
    let low = 0, high = offsets.length;
    while (low + 1 < high) { const mid = (low + high) >> 1; if (offsets[mid] <= offset) low = mid; else high = mid; }
    return { line: low, character: offset - offsets[low] };
  };
  const range = (start, end) => ({ start: position(start), end: position(end) });
  const root = { parent: null, symbol: null, indent: -1, start: 0, end: text.length, children: [] };
  const scopes = [root], stack = [root], symbols = [], stars = [];
  let depth = 0, importUntil = -1;
  function add(name, kind, start, scope, extra = {}) {
    const symbol = { name, kind, uri, start, end: start + name.length, scope, detail: '', ...extra };
    symbols.push(symbol);
    return symbol;
  }
  function container(symbol, indent, start) {
    const scope = { parent: stack.at(-1), symbol, indent, start, end: text.length, children: [] };
    symbol.inner = scope;
    scope.parent.children.push(scope);
    scopes.push(scope); stack.push(scope);
    return scope;
  }
  const lines = scanned.mask.split('\n');
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const line = lines[lineNumber], start = offsets[lineNumber];
    const indentText = line.match(/^\s*/)[0];
    const indent = [...indentText].reduce((n, c) => c === '\t' ? n + 8 - n % 8 : n + 1, 0);
    if (line.trim() && depth === 0) {
      while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop().end = start;
    }
    const scope = stack.at(-1);
    const detail = text.slice(start, start + line.length).trim();
    const base = start + indentText.length;
    const body = line.trimStart();
    let match;
    if (start <= importUntil) {
      // Continuation of an import already indexed on its first line.
    } else if ((match = /^(?:from\s+([.\w]+)\s+import\s+|import\s+)/.exec(body))) {
      let endLine = lineNumber;
      let chunk = body;
      while ((chunk.includes('(') && !chunk.includes(')') || /\\\s*$/.test(chunk)) && endLine + 1 < lines.length) {
        chunk += '\n' + lines[++endLine];
      }
      importUntil = offsets[endLine] + lines[endLine].length;
      const spec = chunk.slice(match[0].length);
      const re = /([.\w]+|\*)(?:\s+as\s+(\w+))?/g;
      let item;
      while ((item = re.exec(spec))) {
        if (item[1] === '*') { stars.push({ module: match[1], scope }); continue; }
        const module = match[1] || item[1];
        const original = match[1] ? item[1] : null;
        const name = item[2] || (original || module.split('.')[0]);
        const localOffset = match[0].length + item.index + (item[2] ? item[0].lastIndexOf(item[2]) : 0);
        add(name, original ? Kind.Variable : Kind.Module, base + localOffset, scope, {
          detail: `import ${module}${original ? '.' + original : ''}`,
          imported: { module: !original && !item[2] ? module.split('.')[0] : module, name: original },
          importStart: base + match[0].length + item.index,
          importEnd: base + match[0].length + item.index + item[0].length
        });
      }
    } else if ((match = /^(enamldef|class|template|func|def)\s+([A-Za-z_]\w*)/.exec(body)) ||
               (match = /^(async\s+def)\s+([A-Za-z_]\w*)/.exec(body))) {
      const nameOffset = base + match[0].lastIndexOf(match[2]);
      const isClass = match[1] === 'class' || match[1] === 'enamldef';
      const symbol = add(match[2], isClass ? Kind.Class : Kind.Function, nameOffset, scope,
        { detail, flavor: match[1], bases: [], headerStart: base });
      const inner = container(symbol, indent, start);
      let end = base + match[0].length;
      if (scanned.mask.slice(end).match(/^[ \t]*\(/)) {
        const open = scanned.mask.indexOf('(', end);
        let nesting = 1, p = open + 1;
        for (; p < scanned.mask.length && nesting; p++) {
          if (scanned.mask[p] === '(') nesting++;
          if (scanned.mask[p] === ')') nesting--;
        }
        end = p;
        const args = scanned.mask.slice(open + 1, p - 1);
        if (isClass) symbol.bases = args.split(',').map(s => s.trim()).filter(s => /^[\w.]+$/.test(s));
        else {
          let argDepth = 0, argStart = open + 1;
          for (let q = open + 1; q <= p - 1; q++) {
            const ch = scanned.mask[q];
            if (q === p - 1 || ch === ',' && argDepth === 0) {
              const part = scanned.mask.slice(argStart, q);
              const param = /^\s*\*{0,2}([A-Za-z_]\w*)(?:\s*:\s*([\w.]+))?/.exec(part);
              if (param) add(param[1], Kind.Variable, argStart + part.indexOf(param[1]), inner,
                { detail: `parameter ${param[1]}`, type: param[2], parameter: true });
              argStart = q + 1;
            }
            if ('([{'.includes(ch)) argDepth++;
            if (')]}'.includes(ch)) argDepth--;
          }
        }
      }
      if (match[1] === 'enamldef') {
        const id = /^[ \t]*:[ \t]*([A-Za-z_]\w*)[ \t]*:/.exec(scanned.mask.slice(end));
        if (id) add(id[1], Kind.Variable, end + id[0].indexOf(id[1]), inner, { detail: `identifier of ${symbol.name}`, instanceOf: symbol });
      }
      if (/^(?:enamldef|template|func)$/.test(match[1]) && !scanned.mask.slice(base, end + 100).split('\n')[0].includes(':') && end <= start + line.length) {
        scanned.issues.push({ start: base, end: base + match[1].length, message: 'Expected a colon after the declaration header.' });
      }
    } else if ((match = /^([A-Za-z_]\w*)\s*=>\s*\(/.exec(body))) {
      const symbol = add(match[1], Kind.Method, base, scope, { detail });
      container(symbol, indent, start);
    } else if ((match = /^(attr|event|const|alias)\s+([A-Za-z_]\w*)(?:\s*:\s*([\w.]+))?/.exec(body))) {
      const constructor = /=\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/.exec(body)?.[1];
      add(match[2], match[1] === 'event' ? Kind.Event : match[1] === 'const' ? Kind.Constant : Kind.Property,
        base + match[0].indexOf(match[2], match[1].length), scope,
        { detail, type: match[1] !== 'alias' ? match[3] || constructor : undefined, target: match[1] === 'alias' ? match[3] : undefined });
    } else if ((match = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*:(?:\s*([A-Za-z_]\w*)\s*:)?\s*$/.exec(body)) && !keywords.has(match[1])) {
      const name = match[2] || match[1];
      // Enaml identifiers are visible throughout their containing enamldef.
      let owner = scope;
      if (match[2]) while (owner.parent && owner.symbol?.flavor !== 'enamldef') owner = owner.parent;
      const symbol = add(name, Kind.Variable, base + (match[2] ? body.lastIndexOf(match[2]) : 0), owner,
        { detail, type: match[1], anonymous: !match[2] });
      container(symbol, indent, start);
    } else if ((match = /^([A-Za-z_]\w*)\s*:\s*([\w.]+)\s*$/.exec(body))) {
      add(match[1], Kind.Property, base, scope, { detail, type: match[2] });
    } else if ((match = /^(?:self\.)?([A-Za-z_]\w*)(?:\s*:\s*([\w.]+))?\s*=(?!=)\s*(?:([\w.]+)\s*\()?/.exec(body))) {
      const owner = body.startsWith('self.') ? scopes.findLast(s => s.symbol?.kind === Kind.Class && s.start <= start && s.end >= start) || scope : scope;
      // Reassignments and component bindings are references to the first declaration.
      if (!symbols.some(s => s.name === match[1] && s.scope === owner)) {
        const target = /=\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*$/.exec(body)?.[1];
        const binding = owner.symbol?.flavor === 'enamldef' || Boolean(owner.symbol?.type);
        add(match[1], Kind.Variable, base + (body.startsWith('self.') ? 5 : 0), owner, { detail, type: match[2] || match[3], target, binding });
      }
    } else if (/^(enamldef|template|func)\b/.test(body)) {
      scanned.issues.push({ start: base, end: base + body.split(/\s/)[0].length, message: 'Expected a declaration name and parameter list.' });
    }
    for (const ch of line) { if ('([{'.includes(ch)) depth++; if (')]}'.includes(ch)) depth = Math.max(0, depth - 1); }
  }
  return { uri, text, ...scanned, root, scopes, symbols, stars, offsets, position, range,
    offset: pos => Math.min(text.length, (offsets[pos.line] ?? text.length) + pos.character),
    scopeAt: offset => scopes.filter(s => s.start <= offset && s.end >= offset).at(-1) || root };
}

class Project {
  constructor(roots = [], sourcePaths = []) {
    this.roots = roots; this.sourcePaths = sourcePaths; this.open = new Map(); this.cache = new Map();
  }
  configure(roots, sourcePaths = []) { this.roots = roots; this.sourcePaths = sourcePaths; this.cache.clear(); }
  update(uri, text) { const doc = analyze(uri, text); this.open.set(uri, doc); this.cache.delete(uri); return doc; }
  close(uri) { this.open.delete(uri); this.cache.delete(uri); }
  invalidate(uri) { this.cache.delete(uri); }
  load(uri) {
    if (this.open.has(uri)) return this.open.get(uri);
    if (this.cache.has(uri)) return this.cache.get(uri);
    try {
      const file = URI.parse(uri).fsPath;
      if (fs.statSync(file).size > 2 * 1024 * 1024) return null;
      const doc = analyze(uri, fs.readFileSync(file, 'utf8'));
      this.cache.set(uri, doc); return doc;
    } catch { return null; }
  }
  module(uri, name) {
    if (!name) return null;
    const dots = name.match(/^\.+/)?.[0].length || 0;
    const suffix = name.slice(dots).split('.').filter(Boolean);
    const roots = dots ? [path.resolve(path.dirname(URI.parse(uri).fsPath), ...Array(dots - 1).fill('..'))] :
      [...this.roots, ...this.sourcePaths.flatMap(p => path.isAbsolute(p) ? [p] : this.roots.map(r => path.resolve(r, p))), path.dirname(URI.parse(uri).fsPath)];
    for (const root of roots) {
      const base = path.join(root, ...suffix);
      const candidates = suffix.length ? [base + '.enaml', base + '.pyi', base + '.py', path.join(base, '__init__.enaml'), path.join(base, '__init__.pyi'), path.join(base, '__init__.py')] :
        [path.join(base, '__init__.enaml'), path.join(base, '__init__.pyi'), path.join(base, '__init__.py')];
      for (const file of candidates) if (fs.existsSync(file) && fs.statSync(file).isFile()) return this.load(URI.file(file).toString());
    }
    return null;
  }
  lookup(doc, name, scope, seen = new Set()) {
    for (let current = scope; current; current = current.parent) {
      const local = doc.symbols.find(s => s.scope === current && s.name === name && !s.anonymous);
      if (local) return local;
      if ((name === 'self' || name === 'cls') && current.symbol?.kind === Kind.Class) return current.symbol;
      // A Python method's self parameter carries its enclosing class implicitly.
    }
    for (const star of doc.stars) {
      if (!this.isAncestor(star.scope, scope)) continue;
      const target = this.module(doc.uri, star.module);
      const key = target && `${target.uri}:${name}`;
      if (target && !seen.has(key)) { seen.add(key); const found = this.lookup(target, name, target.root, seen); if (found) return found; }
    }
    return null;
  }
  isAncestor(outer, scope) { for (; scope; scope = scope.parent) if (scope === outer) return true; return false; }
  unwrap(symbol, seen = new Set()) {
    if (!symbol?.imported) return symbol;
    const key = `${symbol.uri}:${symbol.start}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const target = this.module(symbol.uri, symbol.imported.module);
    if (!target) return symbol;
    if (!symbol.imported.name) return { ...symbol, moduleDoc: target, moduleName: symbol.imported.module };
    const found = this.lookup(target, symbol.imported.name, target.root);
    if (found) return this.unwrap(found, seen);
    const submodule = this.module(symbol.uri, symbol.imported.module + '.' + symbol.imported.name);
    return submodule ? { ...symbol, imported: null, moduleDoc: submodule, moduleName: symbol.imported.module + '.' + symbol.imported.name } : symbol;
  }
  member(symbol, name, seen = new Set()) {
    symbol = this.unwrap(symbol);
    if (!symbol) return null;
    const key = `${symbol.uri}:${symbol.start}:${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    if (symbol.moduleDoc) {
      const local = this.lookup(symbol.moduleDoc, name, symbol.moduleDoc.root);
      if (local) return local;
      const moduleName = symbol.moduleName + '.' + name;
      const submodule = this.module(symbol.uri, moduleName);
      return submodule ? { name, kind: Kind.Module, uri: submodule.uri, start: 0, end: 0, moduleDoc: submodule, moduleName } : null;
    }
    const doc = this.load(symbol.uri);
    if (!doc) return null;
    if (symbol.instanceOf) return this.member(symbol.instanceOf, name, seen);
    if (symbol.parameter && (symbol.name === 'self' || symbol.name === 'cls')) {
      let scope = symbol.scope;
      while (scope && scope.symbol?.kind !== Kind.Class) scope = scope.parent;
      if (scope) return this.member(scope.symbol, name, seen);
    }
    if (symbol.target) {
      const target = this.resolveChain(doc, symbol.target.split('.'), symbol.scope);
      if (target) return this.member(target, name, seen);
    }
    const local = doc.symbols.find(s => s.scope === symbol.inner && s.name === name && !s.anonymous);
    if (local && !local.binding) return local;
    if (symbol.type) {
      const type = this.resolveChain(doc, symbol.type.split('.'), symbol.scope);
      if (type) { const found = this.member(type, name, seen); if (found) return found; }
    }
    for (const base of symbol.bases || []) {
      const type = this.resolveChain(doc, base.split('.'), symbol.scope);
      if (type) { const found = this.member(type, name, seen); if (found) return found; }
    }
    return local || null;
  }
  resolveChain(doc, names, scope) {
    let symbol = this.lookup(doc, names[0], scope);
    for (const name of names.slice(1)) symbol = this.member(symbol, name);
    return symbol;
  }
  at(doc, position) {
    const offset = doc.offset(position);
    const tokenIndex = doc.tokens.findIndex(t => identifier.test(t.value) && t.start <= offset && offset < t.end);
    if (tokenIndex < 0) return null;
    const token = doc.tokens[tokenIndex];
    const declared = doc.symbols.find(s => !s.anonymous && (s.start === token.start || s.importStart <= token.start && token.end <= s.importEnd));
    if (declared) {
      const target = declared.binding && declared.scope.symbol ? this.member(declared.scope.symbol, declared.name) : null;
      return this.unwrap(target || declared);
    }
    const names = [token.value];
    let index = tokenIndex;
    while (index >= 2 && doc.tokens[index - 1].value === '.' && identifier.test(doc.tokens[index - 2].value) &&
      !doc.mask.slice(doc.tokens[index - 2].end, doc.tokens[index].start).includes('\n')) {
      names.unshift(doc.tokens[index - 2].value); index -= 2;
    }
    const scope = doc.scopeAt(offset);
    let resolved = this.resolveChain(doc, names, scope);
    if (!resolved && names.length === 1) {
      for (let current = scope; current && !resolved; current = current.parent) {
        if (current.symbol) resolved = this.member(current.symbol, names[0]);
      }
    }
    if (resolved?.binding && resolved.scope.symbol) resolved = this.member(resolved.scope.symbol, resolved.name) || resolved;
    return this.unwrap(resolved);
  }
  location(symbol) {
    if (!symbol) return null;
    const doc = symbol.moduleDoc || this.load(symbol.uri);
    return doc ? { uri: doc.uri, range: symbol.moduleDoc ? doc.range(0, 0) : doc.range(symbol.start, symbol.end) } : null;
  }
  *files() {
    const yielded = new Set();
    for (const uri of this.open.keys()) { yielded.add(uri); yield uri; }
    let count = 0;
    function* walk(dir) {
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (count >= 5000) return;
        if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(file);
        else if (/\.(enaml|py|pyi)$/.test(entry.name)) { count++; yield URI.file(file).toString(); }
      }
    }
    for (const root of this.roots) for (const uri of walk(root)) if (!yielded.has(uri)) { yielded.add(uri); yield uri; }
  }
}

module.exports = { analyze, scan, Project, Kind, keywords };
