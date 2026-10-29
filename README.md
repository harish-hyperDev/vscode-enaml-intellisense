# Enaml IntelliSense

Syntax highlighting and a Language Server Protocol (LSP) implementation for
**Enaml** and [Enaml-Web](https://github.com/codelv/enaml-web) in **VS Code** and
**VSCodium**. Open a project folder and an `.enaml` file to start the server.
The extension includes its server and requires no Python interpreter or Python
editor extension.

## Features

| Feature | Usage and coverage |
| --- | --- |
| Go to Definition / Peek Definition | Ctrl+Click or F12; Alt+F12 for peek. Classes, functions, parameters, attributes, aliases, component identifiers, and inferred object members. |
| Cross-file navigation | Local Enaml/Python imports, aliases, relative imports, reexports, wildcard imports, and annotated types. |
| Completion | Ctrl+Space or type `.`. Visible symbols, inherited members, declaration snippets, and workspace auto-imports after two characters. |
| Hover | Show the resolved declaration and its leading docstring. |
| Signature help | Function parameters while typing calls, including methods. |
| Find References | Shift+F12; workspace references to the resolved declaration. |
| Document highlights | Resolved occurrences of the selected symbol in the current document. |
| Outline / Go to Symbol | Ctrl+Shift+O; declarations grouped by class, function, and component. |
| Workspace symbols | Ctrl+T; declarations across Enaml and Python source files. |
| Diagnostics | Structural syntax, indentation, unknown expression names, duplicate declarations and unresolved imports. Optional member, type, binding and unused-import checks. |
| Quick fixes | Ctrl+. for spelling suggestions, missing imports/colons, mixed or unexpected indentation, and simple unused-import removal. |
| Rename | F2 for resolved workspace declarations; detects name conflicts and preserves explicit import aliases. |
| Formatting | Format Document normalizes valid block indentation and trailing whitespace while preserving strings and continuation alignment. |
| Organize Imports | Sort consecutive simple import lines; preserves multiline imports and comment boundaries. |
| Semantic coloring | Color resolved classes, functions, parameters, attributes, modules and events. |
| Inlay hints | Optional inferred constructor/literal types and parameter names. |
| Reference lenses | Optional reference counts above declarations; click to open references. |
| Call/type hierarchy | Explore resolved function calls and directly declared inheritance using the editor's hierarchy views. |
| Editing | Highlighting, comment shortcuts, bracket/quote pairing, indentation, and folding. |

On macOS, use Cmd+Click for navigation. Shortcuts follow your keymap. If
`editor.multiCursorModifier` is `ctrlCmd`, use Alt+Click or F12 for navigation.

Object navigation uses explicit annotations, constructor assignments, simple
object aliases, and inheritance. Ctrl+Click `Greeting` or `render` in
[examples/index.enaml](examples/index.enaml) to navigate into
[examples/models.py](examples/models.py):

```enaml
from models import Greeting

enamldef Page(Html): page:
    attr greeting = Greeting()
    H1:
        text << page.greeting.render("Hello")
```

## Build and install

Use Node.js 22.12 or newer and npm. In PowerShell, use `npm.cmd` if execution
policy prevents running `npm.ps1`.

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run package
codium --install-extension ./enaml-intellisense-0.2.2.vsix
```

For VS Code, use `code --install-extension ./enaml-intellisense-0.2.2.vsix`.
Alternatively, select **Extensions → … → Install from VSIX…**, install the VSIX,
and reload the editor window.

Open this repository as a folder and open `examples/index.enaml` to try the
features. The language mode should read **Enaml**. If another extension owns
`.enaml` files, select Enaml in the language picker or set:

```json
"files.associations": { "*.enaml": "enaml" }
```

## Import resolution and settings

Imports search workspace roots, configured source paths, and the importing
file's directory. Relative imports resolve from the importing package. The
server looks for `.enaml`, `.pyi`, `.py`, and package `__init__` files. It never
executes application code or imports modules into a Python process.

To navigate into Enaml, Enaml-Web, or other installed packages, add their source
directory or your environment's `site-packages` to `enaml.sourcePaths`:

```json
{
  "enaml.sourcePaths": ["src", "F:/path/to/venv/Lib/site-packages"],
  "enaml.diagnostics.enabled": true,
  "enaml.languageServer.enabled": true
}
```

Relative paths resolve against workspace folders. Source path and diagnostic
changes apply immediately. Reload after changing `enaml.languageServer.enabled`.
The **Enaml Language Server** output channel contains server messages.

Diagnostic categories are independently configurable:

```json
{
  "enaml.diagnostics.syntax": true,
  "enaml.diagnostics.indentation": true,
  "enaml.diagnostics.unresolvedNames": true,
  "enaml.diagnostics.unresolvedImports": true,
  "enaml.diagnostics.duplicates": true,
  "enaml.diagnostics.unresolvedMembers": false,
  "enaml.diagnostics.unresolvedTypes": false,
  "enaml.diagnostics.bindings": false,
  "enaml.diagnostics.unusedImports": false,
  "enaml.completion.snippets": true,
  "enaml.completion.autoImports": true,
  "enaml.formatting.enabled": true,
  "enaml.semanticTokens.enabled": true,
  "enaml.inlayHints.enabled": false,
  "enaml.codeLens.enabled": false
}
```

Unresolved imports are warnings and often indicate missing `sourcePaths` rather
than misspelled names. Member, type and binding checks are opt-in because Enaml
and Python can generate attributes at runtime. Unused imports are opt-in because
some imports intentionally have side effects. The master `diagnostics.enabled`
switch disables every diagnostic category. Errors and warnings use standard LSP
diagnostics in both VS Code and VSCodium.

## Analysis limits

This is a tolerant structural server, not the Enaml compiler or a full Python
type checker. Name checking covers supported expression statements and bindings;
it does not validate every Python expression or full Enaml grammar. Runtime-generated attributes, arbitrary
expression return types, factory-call inference, destructuring, identifiers in
f-string expressions, namespace-only package navigation, and dynamic imports
are not analyzed. Template expansion is not performed. Hierarchies follow static
calls and declared base classes; they cannot infer runtime dispatch. A missing
wildcard-import source suppresses unknown-name checks to reduce false positives.

Rename returns versioned workspace edits for the editor to apply. External
packages and import aliases cannot be renamed; rename the original declaration
to update its imports while preserving aliases. Rename rejects conflicts and
incomplete workspace scans. Dynamic references and strings are not rewritten.
Formatting does not attempt to repair invalid indentation or reflow expressions.
Import sorting is an explicit action because import order can affect behavior.

Enaml buffers synchronize while editing. Python dependencies are read from disk;
workspace dependencies refresh when saved. Reload after modifying dependency
files outside the workspace. Workspace references and symbol searches examine up
to 5,000 source files, skip common environment/build directories and symlinks,
and ignore unopened files larger than 2 MiB. External package paths support
navigation but are not exhaustively searched for references. Auto-import discovery
examines at most 300 workspace files and returns up to 40 candidates per request.
Workspace operations yield between file batches and support cancellation. There
is no debugger or execution integration; the server never executes source code.

## Development

- `src/extension.cjs`: VS Code/VSCodium LSP client, activated for Enaml files.
- `src/server.cjs`: LSP transport, synchronization, settings, and feature handlers.
- `src/analysis.cjs`: scopes, declarations, imports, and workspace index.
- `src/intelligence.cjs`: diagnostics, suggestions, documentation and formatting.
- `src/editor-features.cjs`: rename, code actions, hints, lenses and hierarchies.
- `src/whitespace.cjs`: logical statement indentation analysis.
- `scripts/build.cjs`: bundles client/server and gathers third-party licenses.
- `syntaxes/enaml.tmLanguage.json`: TextMate grammar; uses the editor's built-in
  Python grammar for expressions, comments, and strings.
- `test/analysis.test.cjs`: navigation and indexing regression tests.
- `test/lsp.test.cjs`: protocol tests against the bundled server process.
- `test/intelligence.test.cjs`: diagnostic and whitespace preservation regressions.
- `test/grammar.test.cjs`: TextMate/Oniguruma tokenization tests.

`npm.cmd test` builds and runs all tests. Packaging runs the same checks. The
VSIX bundles runtime dependencies and excludes source, tests, development
dependencies, and examples. Bundled licenses ship in `THIRD_PARTY_NOTICES.txt`.
Run `npm.cmd run benchmark` for a reproducible 6,002-line indexing, diagnostic
and resolution workload; results depend on the machine and are not a latency guarantee.

After building, run `codium --extensionDevelopmentPath=.` or
`code --extensionDevelopmentPath=.` for an editor preview. For another LSP client:

```powershell
node ./dist/server.cjs --stdio
```

Send `initialize` with workspace folders and open documents with language ID
`enaml`. Standard stdio and Node IPC transports are supported. The publisher
`enaml-community` is a local packaging identifier; set one you control before
publishing to a registry. No registry publication is needed for VSIX installation.

## Licensing

Inspired by [Sublime Enaml syntax](https://github.com/nucleic/sublimetext-enaml-syntax).
The original BSD-3-Clause attribution is retained in LICENSE.

BSD-3-Clause; see [LICENSE](LICENSE). Python grammar test fixtures retain their
MIT license in `test/fixtures`. Bundled libraries retain their licenses in
`THIRD_PARTY_NOTICES.txt`.
