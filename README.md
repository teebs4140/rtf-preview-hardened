# RTF Preview for VS Code (Hardened Fork)

> **This is a security-hardened fork** of [RTF Live Preview](https://github.com/tinazhai/rtf_preview)
> by Tina Zhai, forked from upstream 0.5.2. All credit for the original work belongs to the upstream
> author. This fork is not affiliated with or endorsed by them.
>
> It shows `.rtf` files, especially SAS ODS RTF output, as a read-only preview inside VS Code, and
> is hardened for opening RTF files that come from outside your organisation:
>
> - **File content is always shown as text.** Upstream wrote some RTF characters and font names
>   straight into the preview's HTML, so a crafted file could add images, web pages, links or styles
>   to the preview. Here every character from the file is escaped.
> - **No network access.** The preview has a strict Content Security Policy
>   (`default-src 'none'`). It allows only inline styles and embedded PNG/JPEG images. The extension
>   has no telemetry.
> - **No scripts and no programs.** Scripts are disabled in the preview. The LibreOffice and pandoc
>   fallbacks are removed, so the extension never starts another program.
> - **Read-only.** The extension never writes to the file you open, or to any other file.
>
> See [`CHANGELOG.md`](CHANGELOG.md) for the changes, [`SECURITY.md`](SECURITY.md) for the threat
> model and how to verify a download, and [`NOTICE.md`](NOTICE.md) for attribution.

## Installation

Download the `.vsix` from
[Releases](https://github.com/teebs4140/rtf-preview-hardened/releases) and check its SHA-256
against the release notes. Then install it in one of two ways:

- **In VS Code:** Extensions → `...` → **Install from VSIX...**
- **From a terminal:** run `code --install-extension rtf-preview-hardened-1.0.0.vsix`. In a
  Remote-SSH window, run it in the VS Code terminal so it installs on the server.

The extension ID is `dcri-biostats.rtf-preview-hardened` and the editor ID is
`rtfPreviewHardened.viewer`. Neither collides with upstream. If you have both installed, choose the
default editor with **Open With... → Configure default editor for '*.rtf'**.

## Usage

- **Open an `.rtf` file** (double-click it in the Explorer) to see the preview.
- **See the raw RTF:** right-click the file → **Open With... → Text Editor**, or run
  **View: Reopen Editor With...** on an open preview.
- **Text and preview side by side:** with the RTF open as text, use the preview icon in the editor
  title bar, or right-click the file → **RTF: Open Preview to the Side**.
- **Live reload:** the preview refreshes when the file changes, for example when you re-run the SAS
  program. It waits 0.5 s after the last change.

## What it renders

The preview is tuned for SAS ODS RTF and handles:

- **Tables:** borders, column widths, cell backgrounds, alignment, padding and spanning headers.
- **Titles and footnotes:**
  - SAS TITLE and FOOTNOTE text, whether it is in the page header and footer (the ODS RTF default)
    or in the body (`BODYTITLE`);
  - each header is shown at the start of its section and each footer at the end.
- **Text:**
  - bold, italic, underline, strike-through, superscript and subscript;
  - fonts and colours.
- **Characters:** Unicode (`≥`, `±`, `–`, and so on) and Windows-1252 characters.
- **Pictures:** embedded PNG and JPEG images.
- **Page and section breaks,** shown as dashed lines.

### Limitations

- **Graphs in EMF or WMF format can't be shown in a browser.** SAS writes ODS Graphics to RTF as EMF
  by default. The preview shows a placeholder where the graph would be. To get a viewable graph, add
  this before the procedure:
  ```sas
  ods graphics / outputfmt=png;
  ```
- **The layout is an approximation of the printed page.** Pagination, page size and margins are not
  reproduced. Repeated table headers on later pages are shown once.
- **Word features beyond SAS output are partly supported or ignored.** That includes lists, text
  boxes, shapes, comments and embedded objects. Hyperlinks show their text only.
- **Files larger than 20 MB show a message instead of a preview.** Parsing runs in the extension
  host, and large files would make every extension wait.
- **Code pages:** only Windows-1252 is decoded (the code page SAS writes). Files declaring another
  code page show those bytes as Latin-1.

## Build and test

```bash
npm ci --ignore-scripts
npm test                      # compile, then unit tests (node --test)
npx --yes @vscode/vsce@3 package --no-dependencies
```

To run the end-to-end check in a real VS Code webview, you need `code-server` on `PATH` and a
Playwright Chromium:

```bash
cd test/code-server && npm ci --ignore-scripts && node run.mjs ../../rtf-preview-hardened-1.0.0.vsix
```

`test/fixtures/sas/make-fixtures.sas` regenerates the SAS fixtures from `SASHELP` data.

## License

MIT, unchanged from upstream. See [`LICENSE`](LICENSE) and [`NOTICE.md`](NOTICE.md).
