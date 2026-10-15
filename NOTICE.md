# Attribution and provenance

## Upstream project

This extension is a fork of **RTF Live Preview** by Tina Zhai.

- Upstream source: https://github.com/tinazhai/rtf_preview
- Upstream Marketplace listing: `tina-zhai.rtf-preview`
- Forked from upstream version **0.5.2** (commit `4b85af9`)
- License: MIT (unchanged; see `LICENSE`)

All credit for the original design and implementation belongs to the upstream author, in
particular the RTF parser and its SAS-oriented table handling. This fork changes how that parser
treats untrusted content, extends its handling of SAS ODS RTF and changes how the preview opens.
It is not affiliated with or endorsed by the upstream author.

## Why this fork exists

The upstream extension was reviewed before internal use. The review found:

- **no malware, telemetry or network code;**
- **a reproducible build;**
- **subprocess calls that don't go through a shell.**

It also found that the parser wrote some file-derived characters and font names into the preview's
HTML unescaped. In a real VS Code webview, a crafted RTF could therefore:

- load remote images, stylesheets and pages;
- hide the real content behind different text;
- add links that open without a prompt.

Scripts could not run.

The fork fixes that, adds a Content Security Policy and removes the subprocess fallbacks. It also
adds the SAS rendering improvements listed in `CHANGELOG.md`.

## Third-party code

The extension has no runtime dependencies. The VSIX contains only the compiled `out/extension.js`
and `out/rtfParser.js`, `package.json`, this documentation and the licence.
