const vscode = require('vscode');
const path = require('node:path');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;
async function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('enaml.showReferences', (uri, position, locations) =>
    vscode.commands.executeCommand('editor.action.showReferences', vscode.Uri.parse(uri),
      new vscode.Position(position.line, position.character), locations.map(location => new vscode.Location(vscode.Uri.parse(location.uri),
        new vscode.Range(location.range.start.line, location.range.start.character, location.range.end.line, location.range.end.character))))));
  if (!vscode.workspace.getConfiguration('enaml').get('languageServer.enabled', true)) return;
  const module = context.asAbsolutePath(path.join('dist', 'server.cjs'));
  client = new LanguageClient('enaml', 'Enaml Language Server',
    { run: { module, transport: TransportKind.ipc }, debug: { module, transport: TransportKind.ipc } },
    {
      documentSelector: [{ scheme: 'file', language: 'enaml' }, { scheme: 'untitled', language: 'enaml' }],
      synchronize: {
        configurationSection: 'enaml',
        fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{enaml,py,pyi}')
      }
    });
  context.subscriptions.push(client);
  await client.start();
}
async function deactivate() { if (client) await client.stop(); }
module.exports = { activate, deactivate };
