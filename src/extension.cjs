const vscode = require('vscode');
const path = require('node:path');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;
async function activate(context) {
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
