# Changelog

## 1.0.0

First release of the hardened fork, based on upstream RTF Live Preview **0.5.2** (commit `4b85af9`).
The full diff from upstream is `git diff upstream-0.5.2..main`.

### Identity and behaviour

- New identity, so the fork can be installed alongside upstream:
  - extension `dcri-biostats.rtf-preview-hardened`
  - editor `rtfPreviewHardened.viewer`
  - command `rtfPreviewHardened.openToSide`
- **`.rtf` files open in the preview by default** (a read-only custom editor). Upstream opened the
  raw RTF text and needed a click to preview. **Open With... → Text Editor** shows the raw RTF.
- "RTF: Open Preview to the Side" opens the same preview next to the text editor.
- Activates only when an RTF file or the command is opened. The `rtf` language contribution is
  removed.
- Declares support for Restricted Mode (untrusted workspaces) and virtual workspaces. Files are read
  through `vscode.workspace.fs`.
- Live reload waits 0.5 s after the last change, so a file that SAS is still writing is not shown
  half-done.
- Files larger than 20 MB show a message instead of being parsed.

### Security

- **Every character from the file is HTML-escaped.** Upstream wrote the characters from `\'hh`
  and `\uN` escapes, and font names inside a `style` attribute, into the HTML unescaped. A crafted
  RTF could add images, stylesheets, frames, links or a fake overlay to the preview. Control
  characters are dropped.
- **Font names** are used only if they match `^[A-Za-z0-9 ._-]{1,64}$`.
- **Content Security Policy** on the preview:
  `default-src 'none'; img-src data:; style-src 'unsafe-inline'`. Upstream had none.
- **Images** are emitted only as `data:image/png` or `data:image/jpeg`, from the picture's hex data.
- **Numbers that become CSS are clamped:** font size, widths, indents, border widths, padding and
  picture size.
- **`\binN` data** is skipped by length, so raw binary is never read as text.
- **Removed the LibreOffice and pandoc fallbacks, and all `child_process` use.** Their output went
  into the preview unsanitized.
- Webview: scripts off, command URIs off, no local resource roots.

### SAS ODS RTF rendering

- **Page headers and footers** (`\header`, `\footer`) are rendered. These hold SAS TITLE and
  FOOTNOTE text, which upstream dropped. The header shows at the start of its section and the
  footer at the end; empty ones are omitted.
- **`\sect`** closes the section: any open table, then the section's footer, then a divider.
- **Column spans** are computed per table when the table closes. Upstream computed them per page in
  a separate pass.
- **`\ul0`** turns underline off. Upstream treated it as on, which underlined table values in
  `style=journal` output.
- **`\ucN`:** the fallback characters after `\uN` are skipped. Upstream showed `≥?` and `±?`.
- **Windows-1252:** `\'hh` and 8-bit characters are decoded as Windows-1252, so `–`, `“` and `”`
  appear. Upstream showed control characters.
- **Symbols** (`\'hh`, `\u`, `\emdash`, `\tab`, and so on) are placed in the current table cell
  with the current formatting.
- **Font table:** all entries are parsed. Upstream read only the first font.
- **Colour table:** indices follow the RTF entries, including an explicit colour 0.
- **Hidden text** (`\v`) is not shown.
- **Pictures:**
  - `\nonshppict` duplicates are skipped;
  - EMF, WMF and other formats get a placeholder that suggests `ods graphics / outputfmt=png;`;
  - upstream labelled every picture `image/png`, which showed a broken image for EMF.
- **More destinations are skipped:** field instructions, bookmarks, list tables, object data,
  comments and similar.

- Rendering time stays linear in the input size:
  - tables and headers are buffered separately;
  - column lookups use a map;
  - each run of merged cells records where it ends;
  - the colour table is found with a single scan;
  - over-long font names are dropped as they are read.

  Colspan is capped at 1000.
- The 20 MB limit is checked on the bytes actually read as well as on the reported size, because a
  file can grow while SAS is writing it.
- A preview closed while its file is being read is not updated, so there is no unhandled error.

### Tests

- `test/unit/parser.test.mjs` (`node --test`):
  - every fixture's output must pass a strict allowlist of tags, attributes and attribute values;
  - attack fixtures from the audit;
  - SAS fidelity cases;
  - a mutation fuzz: no throws, bounded time, output still on the allowlist;
  - scaling checks (input size n vs 2n) on inputs that were quadratic before review;
  - `\u` fallback skipping over every byte that Windows-1252 decoding drops;
  - a per-property CSS grammar with numeric bounds in the allowlist;
  - a check that the compiled code has no `child_process`, network or `eval`.
- `test/unit/extension.test.mjs` uses a mocked `vscode` module to check:
  - the webview options and CSP;
  - the size limit before and after reading;
  - escaped messages;
  - closing the preview during a read.
- `test/code-server/run.mjs` runs the VSIX in code-server with a beacon server. All hostile
  fixtures must make zero requests, and the SAS fixtures must render.
