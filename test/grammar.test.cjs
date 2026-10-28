const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, test } = require('node:test');
const { Registry, INITIAL } = require('vscode-textmate');
const { loadWASM, OnigScanner, OnigString } = require('vscode-oniguruma');

const root = path.resolve(__dirname, '..');
let grammar;
before(async () => {
  const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const registry = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: patterns => new OnigScanner(patterns),
      createOnigString: value => new OnigString(value)
    }),
    loadGrammar: async scope => {
      const files = {
        'source.enaml': 'syntaxes/enaml.tmLanguage.json',
        'source.python': 'test/fixtures/MagicPython.tmLanguage.json',
        'source.regexp.python': 'test/fixtures/MagicRegExp.tmLanguage.json'
      };
      return files[scope] ? JSON.parse(fs.readFileSync(path.join(root, files[scope]), 'utf8')) : null;
    }
  });
  grammar = await registry.loadGrammar('source.enaml');
});

function tokenize(source) {
  let state = INITIAL;
  return source.split('\n').map(line => {
    const result = grammar.tokenizeLine(line, state);
    state = result.ruleStack;
    return { line, tokens: result.tokens };
  });
}

function hasScope(row, text, scope) {
  const start = row.line.indexOf(text);
  assert.notEqual(start, -1, `Missing text ${text}`);
  assert.ok(row.tokens.some(t => t.startIndex <= start && t.endIndex > start &&
    t.scopes.some(s => s.startsWith(scope))), `${text} should have ${scope}: ${JSON.stringify(row.tokens)}`);
}

test('manifest registers Enaml and all contributed files exist', () => {
  const manifest = require('../package.json');
  assert.equal(manifest.contributes.languages[0].id, 'enaml');
  assert.deepEqual(manifest.contributes.languages[0].extensions, ['.enaml']);
  for (const file of [manifest.contributes.languages[0].configuration, manifest.contributes.grammars[0].path]) {
    assert.ok(fs.existsSync(path.join(root, file)));
  }
  JSON.parse(fs.readFileSync(path.join(root, 'language-configuration.json'), 'utf8'));
});

test('every local grammar include resolves', () => {
  const raw = require('../syntaxes/enaml.tmLanguage.json');
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.include?.startsWith('#')) assert.ok(raw.repository[value.include.slice(1)], value.include);
    Object.values(value).forEach(visit);
  }
  visit(raw);
});

test('Enaml-Web components, identifiers, aliases and typed storage with comments', () => {
  const rows = tokenize('enamldef Index(Html): page: # root\n    attr title: str = "Hello" # title\n    alias content: body.children\n    Body: body: # component\n        H1: # heading');
  hasScope(rows[0], 'enamldef', 'storage.type.class.enaml');
  hasScope(rows[0], 'Index', 'entity.name.type.class.enaml');
  hasScope(rows[0], 'Html', 'entity.other.inherited-class.enaml');
  hasScope(rows[0], 'page', 'variable.language.enaml');
  hasScope(rows[0], '# root', 'comment');
  hasScope(rows[1], 'attr', 'storage.modifier.enaml');
  hasScope(rows[1], 'title', 'entity.other.attribute-name.enaml');
  hasScope(rows[1], '"Hello"', 'string');
  hasScope(rows[2], 'alias', 'storage.modifier.enaml');
  hasScope(rows[3], 'Body', 'entity.name.tag.enaml');
  hasScope(rows[3], 'body', 'variable.language.enaml');
  hasScope(rows[4], 'H1', 'entity.name.tag.enaml');
});

test('binding operators and dotted attributes', () => {
  for (const op of ['=', '<<', '>>', ':=', '::']) {
    const [row] = tokenize(`    body.text ${op} "value"`);
    hasScope(row, 'body.text', 'entity.other.attribute-name.enaml');
    hasScope(row, op, 'keyword.operator.enaml');
    hasScope(row, '"value"', 'string');
  }
});

test('functions, overrides and template calls with nested defaults', () => {
  const rows = tokenize('template Items(count=length((1, 2))): # template\n    func render(value=dict(a=(1, 2))) -> str:\n        return str(value)\n    render => (value):\n        return value\n    Items(3): first, *rest: # unpack\n    Items(3):');
  hasScope(rows[0], 'template', 'storage.type.function.enaml');
  hasScope(rows[0], '# template', 'comment');
  hasScope(rows[1], 'func', 'storage.type.function.enaml');
  hasScope(rows[2], 'return', 'keyword.control');
  hasScope(rows[3], '=>', 'keyword.operator.enaml');
  hasScope(rows[5], 'Items', 'entity.name.function.enaml');
  hasScope(rows[5], 'first', 'variable.language.enaml');
  hasScope(rows[5], '# unpack', 'comment');
  hasScope(rows[6], 'Items', 'entity.name.function.enaml');
});

test('Python strings and comments protect Enaml-like text', () => {
  const rows = tokenize('    text = """\n    Body:\n    alias fake: child\n    """\n    # enamldef Fake(Html):\n    text = f"hello {name}"\n    if enabled:\n        pass\n    else:\n        pass');
  hasScope(rows[1], 'Body', 'string');
  hasScope(rows[2], 'alias', 'string');
  hasScope(rows[4], 'enamldef', 'comment');
  hasScope(rows[5], 'hello', 'string');
  hasScope(rows[6], 'if', 'keyword.control');
  hasScope(rows[8], 'else', 'keyword.control');
});

test('multiline Python expressions and function signatures recover to components', () => {
  const rows = tokenize('    func calculate(\n        value=(1, 2),\n    ):\n        return value\n    text = (\n        "Body:"\n    )\n    Div:');
  hasScope(rows[0], 'calculate', 'entity.name.function.enaml');
  hasScope(rows[3], 'return', 'keyword.control');
  hasScope(rows[5], 'Body:', 'string');
  hasScope(rows[7], 'Div', 'entity.name.tag.enaml');
});

test('the complete Enaml-Web example tokenizes without leaking a header scope', () => {
  const rows = tokenize(fs.readFileSync(path.join(root, 'examples/index.enaml'), 'utf8'));
  const style = rows.find(row => row.line.includes('style ='));
  hasScope(style, 'style', 'entity.other.attribute-name.enaml');
  assert.ok(!style.tokens.some(t => t.scopes.includes('meta.class.enaml')));
});
