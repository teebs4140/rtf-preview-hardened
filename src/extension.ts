import * as vscode from 'vscode';
import { rtfToHtml, escapeText } from './rtfParser';

export const VIEW_TYPE = 'rtfPreviewHardened.viewer';

/** Larger files show a message instead of being parsed. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Re-render this long after the last change, so a file SAS is still writing is not shown half-done. */
const RELOAD_DELAY_MS = 500;

/** No scripts, frames, fonts, connections or remote images: only inline styles and data: images. */
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new RtfPreviewProvider(), {
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('rtfPreviewHardened.openToSide', (uri?: vscode.Uri) => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showErrorMessage('No RTF file selected.');
        return;
      }
      return vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE, vscode.ViewColumn.Beside);
    }),
  );
}

class RtfPreviewProvider implements vscode.CustomReadonlyEditorProvider {
  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => { } };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    panel.webview.options = { enableScripts: false, enableCommandUris: false, localResourceRoots: [] };

    let generation = 0;
    let disposed = false;
    const render = async () => {
      const mine = ++generation;
      const html = await renderFile(document.uri);
      if (mine !== generation || disposed) return;
      try { panel.webview.html = html; } catch { /* panel closed while the file was being read */ }
    };
    void render();

    // Watch the folder and match the exact URI, so file names with glob characters still reload.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.joinPath(document.uri, '..'), '*'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = (changed: vscode.Uri) => {
      if (changed.toString() !== document.uri.toString()) return;
      clearTimeout(timer);
      timer = setTimeout(() => void render(), RELOAD_DELAY_MS);
    };
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    panel.onDidDispose(() => {
      disposed = true;
      clearTimeout(timer);
      watcher.dispose();
    });
  }
}

export async function renderFile(uri: vscode.Uri): Promise<string> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > MAX_FILE_BYTES) return tooLargeHtml(stat.size);
    const bytes = await vscode.workspace.fs.readFile(uri);
    // The file can grow between stat and read (SAS still writing it), so check what was actually read.
    if (bytes.byteLength > MAX_FILE_BYTES) return tooLargeHtml(bytes.byteLength);
    const rtf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
    if (!/^\s*\{\\rtf/.test(rtf.slice(0, 64))) {
      return messageHtml('This file does not start with an RTF header ({\\rtf), so it is not shown as RTF. Use Open With → Text Editor to see its contents.');
    }
    return documentHtml(rtfToHtml(rtf));
  } catch (err) {
    return messageHtml(`The file could not be shown: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function tooLargeHtml(size: number): string {
  return messageHtml(`This file is ${(size / 1048576).toFixed(0)} MB, larger than the ${MAX_FILE_BYTES / 1048576} MB preview limit. `
    + 'Use Open With \u2192 Text Editor to see its contents.');
}

function documentHtml(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>
  body { font-family: 'Times New Roman', serif; font-size: 10pt; margin: 20px; background: #fff; color: #000; }
  table { border-collapse: collapse; margin: 4px auto; }
  td { padding: 2px 6px; border: 1px solid #d0d0d0; }
  hr.page-break { border: none; border-top: 2px dashed #999; margin: 20px 0; }
  img { display: block; margin: 8px auto; }
  sup, sub { font-size: 0.7em; }
  .rtf-header, .rtf-footer { margin: 4px 0; }
  .rtf-header td, .rtf-footer td { border: none; }
  .pict-placeholder { margin: 8px auto; padding: 12px 16px; max-width: 6in; border: 1px dashed #999; background: #f6f6f6;
    font-family: sans-serif; font-size: 9pt; color: #333; }
  .pict-placeholder code { font-family: monospace; }
</style>
</head>
<body>${body}</body></html>`;
}

function messageHtml(msg: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}"></head>
<body style="margin:20px;font-family:sans-serif"><p>${escapeText(msg)}</p></body></html>`;
}

export function deactivate() { }
