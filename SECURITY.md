# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub. On this repository's **Security** tab,
choose **Report a vulnerability**. Please don't open a public issue for a security problem.

Include:
- the affected version;
- what an attacker would need to control (usually a crafted RTF file);
- what you observed.

A sample file that reproduces the issue is the most useful thing to send.

If the issue is also present upstream, please report it to https://github.com/tinazhai/rtf_preview
as well.

## Threat model

The RTF files this extension opens may come from outside your organisation, so **file content is
untrusted input**. A crafted file cannot:

- **Add markup to the preview.** The parser is the only source of markup. Every character taken
  from the file is HTML-escaped, including text, `\'hh` and `\uN` escapes, and symbols. Font names
  are allowlisted, and numbers that become CSS are clamped. CSS is limited to a fixed set of
  properties, and `rgb()` is the only function. The unit tests check every fixture's
  output, and mutated versions of every fixture, against a strict allowlist of tags, attributes and
  values.
- **Run script.** The preview webview has scripts disabled. Its Content Security Policy is
  `default-src 'none'; img-src data:; style-src 'unsafe-inline'`.
- **Make network requests.** The policy allows no remote origin; images must be `data:` URIs. The
  extension has no telemetry. The end-to-end test opens the attack fixtures in a real VS Code
  webview with a local beacon server and requires zero requests.
- **Start programs.** The extension has no `child_process` use. Upstream's LibreOffice and pandoc
  fallbacks are removed.
- **Change files.** The extension only reads the file it shows.
- **Reach VS Code.** The preview has no scripts and no message channel, and command URIs are off.

Not in scope:
- **Display fidelity.** A file can look different in this preview than in Word. Use Word or a PDF
  for anything you sign off on.
- **Very large files.** Files over 20 MB are not parsed. A file just under the limit with an unusual
  structure can still take several seconds to parse.

## Verifying a download

Each release lists the VSIX's SHA-256. Check it before installing:

```bash
sha256sum rtf-preview-hardened-1.0.0.vsix
```

The VSIX is reproducible from the tagged source:

```bash
npm ci --ignore-scripts
npx tsc -p .
npx --yes @vscode/vsce@3 package --no-dependencies
```

Compare `extension/out/*.js` in the archive with your build.
