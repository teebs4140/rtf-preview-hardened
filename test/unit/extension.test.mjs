// Extension host behaviour, with a minimal mock of the `vscode` module. Run after `tsc`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// --- vscode mock -------------------------------------------------------------------------------
const fsImpl = { stat: async () => ({ size: 0 }), readFile: async () => new Uint8Array() };
let provider = null;
const vscode = {
    Uri: {
        file: (p) => ({ scheme: 'file', path: p, toString: () => `file://${p}` }),
        joinPath: (u, ...parts) => vscode.Uri.file([u.path, ...parts].join('/')),
    },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    ViewColumn: { Beside: -2 },
    workspace: {
        fs: { stat: (u) => fsImpl.stat(u), readFile: (u) => fsImpl.readFile(u) },
        createFileSystemWatcher: () => ({ onDidChange: () => { }, onDidCreate: () => { }, dispose: () => { } }),
    },
    window: {
        registerCustomEditorProvider: (_type, p) => { provider = p; return { dispose() { } }; },
        showErrorMessage: () => { },
        activeTextEditor: undefined,
    },
    commands: { registerCommand: () => ({ dispose() { } }), executeCommand: async () => { } },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'vscode' ? vscode : origLoad.call(this, request, ...rest); };
const require = Module.createRequire(import.meta.url);
const ext = require(join(ROOT, 'out', 'extension.js'));
ext.activate({ subscriptions: [] });

function fakePanel() {
    let disposed = false;
    const disposeHandlers = [];
    const writes = [];
    const panel = {
        webview: {
            options: null,
            set html(v) { if (disposed) throw new Error('Webview is disposed'); writes.push(v); },
            get html() { return writes.at(-1); },
        },
        onDidDispose: (fn) => { disposeHandlers.push(fn); },
        dispose: () => { disposed = true; disposeHandlers.forEach((f) => f()); },
    };
    return { panel, writes };
}
const bytes = (s) => new Uint8Array(Buffer.from(s, 'latin1'));
const tick = () => new Promise((r) => setTimeout(r, 10));

// --- tests ------------------------------------------------------------------------------------

test('webview options: no scripts, no command URIs, no local resources; CSP in the page', async () => {
    fsImpl.stat = async () => ({ size: 12 });
    fsImpl.readFile = async () => bytes('{\\rtf1 Hello}');
    const { panel, writes } = fakePanel();
    const uri = vscode.Uri.file('/w/a.rtf');
    provider.resolveCustomEditor(provider.openCustomDocument(uri), panel);
    await tick();
    assert.deepEqual(panel.webview.options, { enableScripts: false, enableCommandUris: false, localResourceRoots: [] });
    assert.match(writes.at(-1), /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">/);
    assert.match(writes.at(-1), /<body>Hello<\/body>/);
});

test('size cap applies to the bytes read, even if stat reported a small file', async () => {
    fsImpl.stat = async () => ({ size: 10 });
    fsImpl.readFile = async () => bytes('{\\rtf1 ' + 'A'.repeat(ext.MAX_FILE_BYTES) + '}');
    const html = await ext.renderFile(vscode.Uri.file('/w/growing.rtf'));
    assert.match(html, /larger than the 20 MB preview limit/);
});

test('size cap applies to stat before reading', async () => {
    let read = false;
    fsImpl.stat = async () => ({ size: ext.MAX_FILE_BYTES + 1 });
    fsImpl.readFile = async () => { read = true; return bytes('{\\rtf1 x}'); };
    const html = await ext.renderFile(vscode.Uri.file('/w/big.rtf'));
    assert.match(html, /preview limit/);
    assert.equal(read, false);
});

test('a non-RTF file shows a message, escaped', async () => {
    fsImpl.stat = async () => ({ size: 5 });
    fsImpl.readFile = async () => bytes('<img src=x>');
    const html = await ext.renderFile(vscode.Uri.file('/w/x.rtf'));
    assert.match(html, /does not start with an RTF header/);
    assert.doesNotMatch(html, /<img/);
});

test('read errors are shown escaped', async () => {
    fsImpl.stat = async () => { throw new Error('<b>no access</b>'); };
    const html = await ext.renderFile(vscode.Uri.file('/w/x.rtf'));
    assert.match(html, /&lt;b&gt;no access&lt;\/b&gt;/);
});

test('closing the preview while the file is being read does not throw', async () => {
    let release;
    fsImpl.stat = async () => ({ size: 12 });
    fsImpl.readFile = () => new Promise((r) => { release = () => r(bytes('{\\rtf1 OK}')); });
    const rejections = [];
    const onRej = (e) => rejections.push(e);
    process.on('unhandledRejection', onRej);
    try {
        const { panel, writes } = fakePanel();
        provider.resolveCustomEditor(provider.openCustomDocument(vscode.Uri.file('/w/b.rtf')), panel);
        await tick();
        panel.dispose();
        release();
        await tick();
        assert.equal(writes.length, 0);
        assert.deepEqual(rejections, []);
    } finally {
        process.off('unhandledRejection', onRej);
    }
});
