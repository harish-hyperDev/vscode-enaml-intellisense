const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { URI } = require('vscode-uri');
const { Project, analyze } = require('../src/analysis.cjs');

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enaml-lsp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  }
  const uri = file => URI.file(path.join(root, file)).toString();
  const project = new Project([root]);
  return { project, uri, root };
}
function at(project, doc, text, occurrence = 0) {
  let index = -1;
  for (let i = 0; i <= occurrence; i++) index = doc.text.indexOf(text, index + 1);
  assert.ok(index >= 0, `Missing ${text}`);
  return project.at(doc, doc.position(index));
}

test('indexes Enaml classes, functions, attributes, aliases and component identifiers', t => {
  const { project, uri } = fixture(t, {});
  const doc = project.update(uri('index.enaml'), 'enamldef Page(Html): page:\n    attr title: str = "Hi"\n    alias content: body\n    Body: body:\n        text << page.title\n    func render(value: str):\n        return value\n    result = render(title)\n');
  assert.equal(at(project, doc, 'page.title').name, 'page');
  assert.equal(at(project, doc, 'title', 2).start, doc.text.indexOf('title'));
  assert.equal(at(project, doc, 'render(title)').flavor, 'func');
  assert.equal(at(project, doc, 'value', 1).parameter, true);
  assert.equal(at(project, doc, 'body', 0).start, doc.text.indexOf('body', doc.text.indexOf('Body:')));
});

test('Ctrl+Click crosses Enaml/Python imports, aliases, calls and object members', t => {
  const { project, uri } = fixture(t, {
    'models.py': 'class Person:\n    def greet(self, name):\n        return name\n\ndef build():\n    return Person()\n',
    'base.enaml': 'enamldef Base(Html):\n    attr title: str\n',
    'index.enaml': 'from models import Person as User, build\nfrom base import Base\nenamldef Page(Base): page:\n    attr user: User\n    value = User()\n    text << user.greet("world")\n    other = build()\n    caption << page.title\n'
  });
  const doc = project.load(uri('index.enaml'));
  const cls = at(project, doc, 'User()');
  assert.equal(cls.name, 'Person'); assert.equal(cls.uri, uri('models.py'));
  const fn = at(project, doc, 'build()');
  assert.equal(fn.name, 'build'); assert.equal(fn.uri, uri('models.py'));
  const greet = at(project, doc, 'greet');
  assert.equal(greet.name, 'greet'); assert.equal(greet.uri, uri('models.py'));
  const inherited = at(project, doc, 'title', 0);
  assert.equal(inherited.uri, uri('base.enaml'));
});

test('relative imports, reexports, wildcard imports and multiline imports resolve', t => {
  const { project, uri } = fixture(t, {
    'pkg/__init__.py': 'from .models import Person\n',
    'pkg/models.py': 'class Person:\n    pass\n',
    'pkg/view.enaml': 'from . import Person\nfrom .models import (\n    Person as User,\n)\nenamldef View(Html):\n    a = Person()\n    b = User()\n',
    'wild.enaml': 'from pkg import *\nenamldef View(Html):\n    a = Person()\n'
  });
  const doc = project.load(uri('pkg/view.enaml'));
  assert.equal(at(project, doc, 'Person()').uri, uri('pkg/models.py'));
  assert.equal(at(project, doc, 'User()').uri, uri('pkg/models.py'));
  const wild = project.load(uri('wild.enaml'));
  assert.equal(at(project, wild, 'Person()').uri, uri('pkg/models.py'));
});

test('module-qualified declarations and self members navigate to Python source', t => {
  const { project, uri } = fixture(t, {
    'models.py': 'class Person:\n    def greet(self):\n        self.title = "Hello"\n        return self.title\n',
    'index.enaml': 'import models as m\nenamldef View(Html):\n    person = m.Person()\n    text << person.greet()\n'
  });
  const doc = project.load(uri('index.enaml'));
  assert.equal(at(project, doc, 'Person()').name, 'Person');
  assert.equal(at(project, doc, 'greet()').name, 'greet');
  const model = project.load(uri('models.py'));
  const title = at(project, model, 'title', 1);
  assert.equal(title.start, model.text.indexOf('title'));
});

test('local scopes do not confuse same-named function parameters', t => {
  const { project, uri } = fixture(t, {});
  const doc = project.update(uri('view.enaml'), 'enamldef View(Html):\n    func first(value):\n        return value\n    func second(value):\n        return value\n');
  assert.equal(at(project, doc, 'value', 1).start, doc.text.indexOf('value'));
  assert.equal(at(project, doc, 'value', 3).start, doc.text.indexOf('value', doc.text.indexOf('second')));
});

test('unsaved buffers take precedence over indexed files and invalidation refreshes dependencies', t => {
  const { project, uri, root } = fixture(t, { 'model.py': 'class Old:\n    pass\n' });
  project.load(uri('model.py'));
  fs.writeFileSync(path.join(root, 'model.py'), 'class New:\n    pass\n');
  project.invalidate(uri('model.py'));
  assert.equal(project.load(uri('model.py')).symbols[0].name, 'New');
  project.update(uri('model.py'), 'class Unsaved:\n    pass\n');
  assert.equal(project.load(uri('model.py')).symbols[0].name, 'Unsaved');
  project.close(uri('model.py'));
  assert.equal(project.load(uri('model.py')).symbols[0].name, 'New');
});

test('configured import roots and .pyi files support external package navigation', t => {
  const { project, uri } = fixture(t, { 'src/models.pyi': 'class Person:\n    def greet(self) -> str: ...\n' });
  project.configure(project.roots, ['src']);
  const doc = project.update(uri('view.enaml'), 'from models import Person\nenamldef View(Html):\n    person = Person()\n');
  assert.equal(at(project, doc, 'Person()').uri, uri('src/models.pyi'));
});

test('constructor defaults and simple aliases retain object member targets', t => {
  const { project, uri } = fixture(t, { 'model.py': 'class Person:\n    def greet(self):\n        pass\n' });
  const doc = project.update(uri('view.enaml'), 'from model import Person\nenamldef View(Html):\n    attr person = Person()\n    copy = person\n    first << person.greet()\n    second << copy.greet()\n');
  assert.equal(at(project, doc, 'greet').uri, uri('model.py'));
  assert.equal(at(project, doc, 'greet', 1).uri, uri('model.py'));
});

test('Enaml assignments navigate to inherited property declarations when available', t => {
  const { project, uri } = fixture(t, { 'base.enaml': 'enamldef Base(Html):\n    attr title: str\n' });
  const doc = project.update(uri('view.enaml'), 'from base import Base\nenamldef View(Base):\n    title = "Welcome"\n    text << title\n');
  assert.equal(at(project, doc, 'title').uri, uri('base.enaml'));
  assert.equal(at(project, doc, 'title', 1).uri, uri('base.enaml'));
});

test('qualified packages, Python annotations and inherited bare attributes resolve', t => {
  const { project, uri } = fixture(t, {
    'pkg/__init__.py': '',
    'pkg/models.py': 'class Person:\n    title: str\n',
    'base.enaml': 'enamldef Base(Html):\n    attr heading: str\n',
    'view.enaml': 'import pkg.models\nfrom base import Base\nenamldef View(Base):\n    person: pkg.models.Person\n    text << person.title\n    caption << heading\n'
  });
  const doc = project.load(uri('view.enaml'));
  assert.equal(at(project, doc, 'Person').name, 'Person');
  assert.equal(at(project, doc, 'title').uri, uri('pkg/models.py'));
  assert.equal(at(project, doc, 'heading').uri, uri('base.enaml'));
});

test('cyclic imports and inheritance terminate without inventing targets', t => {
  const { project, uri } = fixture(t, {
    'a.py': 'from b import Name\nclass A(B):\n    pass\nclass B(A):\n    pass\n',
    'b.py': 'from a import Name\n',
    'view.enaml': 'from a import Name, A\nenamldef View(Html):\n    value = A()\n    text << value.missing\n    other = Name()\n'
  });
  const doc = project.load(uri('view.enaml'));
  assert.equal(at(project, doc, 'missing'), null);
  assert.doesNotThrow(() => at(project, doc, 'Name()'));
});

test('diagnostics ignore delimiters in strings/comments and catch structural mistakes', () => {
  assert.equal(analyze('untitled:good', 'text = "[)" # (\n').issues.length, 0);
  const bad = analyze('untitled:bad', 'enamldef Broken(Html)\n    text = (1]\n    other = "unterminated\n');
  assert.ok(bad.issues.some(i => i.message.includes('colon')));
  assert.ok(bad.issues.some(i => i.message.includes('Unexpected closing')));
  assert.ok(bad.issues.some(i => i.message.includes('Unclosed delimiter')));
  assert.ok(bad.issues.some(i => i.message.includes('Unterminated string')));
});

test('Enaml diagnostics flag unresolved expression names and invalid indentation', t => {
  const { project, uri } = fixture(t, {});
  const doc = project.update(uri('view.enaml'), 'enamldef View(Html): view:\n  attr title: str\n    text << tittle\n  result = rendeer(title)\n  not_a_function()\n');
  const messages = project.diagnostics(doc).map(issue => issue.message);
  assert.ok(messages.includes("Unknown name 'tittle'."));
  assert.ok(messages.includes("Unknown name 'rendeer'."));
  assert.ok(messages.includes("Unknown name 'not_a_function'."));
  assert.ok(messages.some(message => message.includes('Unexpected indentation')));
});

test('strings and comments never resolve references, including UTF-16 positions', t => {
  const { project, uri } = fixture(t, {});
  const doc = project.update(uri('view.enaml'), 'enamldef View(Html):\n    attr title: str\n    text = "😀 title" # title\n    value << title\n');
  assert.equal(at(project, doc, 'title', 1), null);
  assert.equal(at(project, doc, 'title', 2), null);
  assert.equal(at(project, doc, 'title', 3).name, 'title');
});

test('workspace traversal excludes dependencies and follows neither symlinks nor duplicates', t => {
  const { project, uri } = fixture(t, { 'view.enaml': '', 'node_modules/skip.py': '', '.venv/skip.py': '', 'src/model.py': '' });
  project.update(uri('view.enaml'), '');
  assert.deepEqual([...project.files()].sort(), [uri('view.enaml'), uri('src/model.py')].sort());
});
