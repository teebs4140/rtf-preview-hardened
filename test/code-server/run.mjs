// Installs the packaged VSIX into a throwaway code-server (the real extension host and VS Code webview)
// and opens the fixtures in headless Chromium. A local "beacon" server on 127.0.0.1:47777 records any
// request a preview makes; the hostile fixtures point at it, so a passing run proves they made none.
//
// Usage: node run.mjs <path to .vsix> [scratch dir]
// Needs: code-server on PATH, and a Playwright Chromium in ~/.cache/ms-playwright (npx playwright install chromium).
// Env:   ONLY=<fixture file name> or ONLY=side to run one case.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, copyFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import { chromium } from 'playwright-core';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const vsix = process.argv[2] && resolve(process.argv[2]);
if (!vsix || !existsSync(vsix)) { console.error('usage: node run.mjs <path to .vsix> [scratch dir]'); process.exit(2); }
const scratch = process.argv[3] ? resolve(process.argv[3]) : mkdtempSync(join(tmpdir(), 'rtfprev-code-server-'));
const dirs = Object.fromEntries(['user-data', 'extensions', 'xdg-config', 'xdg-data', 'workspace'].map((d) => [d, join(scratch, d)]));
Object.values(dirs).forEach((d) => mkdirSync(d, { recursive: true }));
const configFile = join(scratch, 'config.yaml');
writeFileSync(configFile, 'auth: none\ncert: false\n');
const env = { ...process.env, XDG_CONFIG_HOME: dirs['xdg-config'], XDG_DATA_HOME: dirs['xdg-data'] };
for (const k of Object.keys(env)) if (k.startsWith('VSCODE_')) delete env[k];
const common = ['--config', configFile, '--user-data-dir', dirs['user-data'], '--extensions-dir', dirs.extensions];
mkdirSync(join(dirs['user-data'], 'User'), { recursive: true });
writeFileSync(join(dirs['user-data'], 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false,
    'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'workbench.enableExperiments': false,
}, null, 2));
for (const f of readdirSync(join(FIXTURES, 'sas')).filter((x) => x.endsWith('.rtf'))) copyFileSync(join(FIXTURES, 'sas', f), join(dirs.workspace, f));
for (const f of readdirSync(join(FIXTURES, 'synthetic')).filter((x) => x.startsWith('hostile-'))) copyFileSync(join(FIXTURES, 'synthetic', f), join(dirs.workspace, f));
// Two large generated files: one under the 20 MB preview limit (timed), one over it.
const ROW = '\\trowd\\cellx2000\\cellx4000\\cellx6000\\pard\\plain\\intbl{Subject 0001\\cell}\\pard\\plain\\intbl{Placebo\\cell}\\pard\\plain\\intbl\\qr{12.345\\cell}{\\row}\n';
const bigRtf = (mb) => '{\\rtf1\\ansi\n' + ROW.repeat(Math.floor(mb * 1048576 / ROW.length)) + '\\pard\\par}';
writeFileSync(join(dirs.workspace, 'big16.rtf'), bigRtf(16), 'latin1');
writeFileSync(join(dirs.workspace, 'toobig.rtf'), bigRtf(21), 'latin1');

// Beacon server: records every request a rendered preview makes.
const hits = [];
const beacon = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/frame') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<body style="background:#fdd">ATTACKER-FRAME<img src="/frame-img"><script>new Image().src="/frame-script"</script></body>');
    }
    if (req.url === '/css-link') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end('body{outline:4px solid red}'); }
    res.writeHead(200, { 'content-type': 'image/gif' });
    res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
});
await new Promise((r) => beacon.listen(47777, '127.0.0.1', r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
function findChromium() {
    const root = join(homedir(), '.cache', 'ms-playwright');
    for (const [prefix, bin] of [['chromium_headless_shell-', 'chrome-headless-shell-linux64/chrome-headless-shell'], ['chromium-', 'chrome-linux64/chrome']]) {
        const d = readdirSync(root).filter((x) => x.startsWith(prefix) && /^\d+$/.test(x.slice(prefix.length)))
            .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length))).map((x) => join(root, x, bin)).find(existsSync);
        if (d) return d;
    }
}

const install = spawnSync('code-server', [...common, '--install-extension', vsix, '--force'], { env, encoding: 'utf8' });
console.log(`install: exit ${install.status} ${(install.stdout + install.stderr).trim().split('\n').slice(-1)}`);
const port = await freePort();
const server = spawn('code-server', [...common, '--bind-addr', `127.0.0.1:${port}`, '--disable-telemetry', '--disable-update-check',
    '--disable-workspace-trust', '--disable-getting-started-override', dirs.workspace], { env });
const origin = `http://127.0.0.1:${port}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${origin}/healthz`)).ok) break; } catch { } await sleep(500); }

const CASES = [
    { file: 'hostile-beacons.rtf', marker: 'BEACON-DONE', click: 'LINK-TO-CLICK' },
    { file: 'hostile-fontname.rtf', marker: 'FONTNAME-PAGE' },
    { file: 'hostile-mixed.rtf', marker: 'Font switch.', expect: ['<img src="http://127.0.0.1:47777/hex-beacon">', 'Spoofed result: p = 0.001'] },
    { file: 'hostile-refresh.rtf', marker: 'REFRESH-PAGE', wait: 4000 },
    { file: 'hostile-spoof.rtf', marker: 'SPOOFED', expect: ['1.42 (1.10, 1.83)', '0.007', '<style>'] },
    { file: 'titles-footnotes.rtf', marker: 'Footnote: values are from', expect: ['Table 1. Weight \u2265 100 lb by sex', 'Mean \u00B1 SD \u2013 SASHELP.CLASS'] },
    { file: 'bodytitle-spanning.rtf', marker: 'Table 3.' },
    { file: 'graph-png.rtf', marker: '__IMG__', image: true },
    { file: 'graph-emf.rtf', marker: 'Graph not shown: EMF' },
    { file: 'big16.rtf', marker: 'Subject 0001', timeit: true },
    { file: 'toobig.rtf', marker: 'preview limit' },
    { file: 'titles-footnotes.rtf', marker: 'Footnote: values are from', side: true },
    { file: 'bodytitle-spanning.rtf', marker: 'Table 3.', reload: true },
];
const ONLY = process.env.ONLY; if (ONLY) CASES.splice(0, CASES.length, ...CASES.filter((c) => (ONLY === 'side' ? c.side : c.file === ONLY)));
let failures = 0;
const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] });
try {
    for (const c of CASES) {
        hits.length = 0;
        const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
        const page = await context.newPage();
        const popups = [];
        context.on('page', (p) => popups.push(p.url()));
        await page.goto(`${origin}/?folder=${encodeURIComponent(dirs.workspace)}`, { waitUntil: 'domcontentloaded' });
        await page.locator('.monaco-workbench').waitFor({ timeout: 60000 });
        await sleep(3000);
        await page.keyboard.press('Control+p');
        await page.locator('.quick-input-widget input[type=text]').waitFor({ timeout: 10000 });
        await page.keyboard.type(c.file);
        await sleep(800);
        await page.keyboard.press('Enter');
        const t0 = Date.now();
        if (c.side) {
            await sleep(2500);
            await page.keyboard.press('F1');
            await page.locator('.quick-input-widget input[type=text]').waitFor({ timeout: 10000 });
            await page.keyboard.type('View: Reopen Editor With Text Editor');
            await sleep(1200);
            await page.keyboard.press('Enter');
            await sleep(2500);
            c.textEditor = await page.locator('.monaco-editor .view-lines').first().innerText().then((t) => t.includes('rtf1')).catch(() => false);
            await page.keyboard.press('F1');
            await page.locator('.quick-input-widget input[type=text]').waitFor({ timeout: 10000 });
            await page.keyboard.type('RTF: Open Preview to the Side');
            await sleep(1000);
            await page.keyboard.press('Enter');
        }
        let frame = null;
        for (let i = 0; i < 60 && !frame; i++) {
            for (const f of page.frames()) {
                if (f === page.mainFrame() || /47777/.test(f.url())) continue;
                try { if (await f.evaluate((m) => m === '__IMG__' ? [...document.images].some((i) => i.naturalWidth > 0) : document.body?.innerText.includes(m), c.marker)) { frame = f; break; } } catch { }
            }
            if (!frame) await sleep(500);
        }
        const elapsed = Date.now() - t0;
        await sleep(c.wait ?? 2500);
        const info = frame ? await frame.evaluate(() => ({
            csp: [...document.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]')].map((m) => m.content),
            url: location.href.slice(0, 120),
            sandbox: window.frameElement?.getAttribute('sandbox') ?? '(cross-origin parent)',
            iframes: document.querySelectorAll('iframe').length,
            text: document.body.innerText,
            images: [...document.images].map((i) => i.naturalWidth),
        })).catch((e) => ({ error: e.message })) : null;
        const frameUrls = page.frames().map((f) => f.url()).filter((u) => /47777/.test(u));
        let clickResult = null;
        if (c.click && frame) {
            await frame.locator(`text=${c.click}`).first().click().catch((e) => { clickResult = 'click failed: ' + e.message.split('\n')[0]; });
            await sleep(2500);
            const dialog = await page.locator('.monaco-dialog-box').innerText().catch(() => '');
            clickResult ??= { dialog: dialog.replace(/\s+/g, ' ').slice(0, 200), popups: [...popups] };
            await page.screenshot({ path: join(scratch, `${c.file}-click.png`) });
            await page.keyboard.press('Escape');
        }
        await page.screenshot({ path: join(scratch, `${c.file}.png`) });
        if (c.reload && frame) {
            const p = join(dirs.workspace, c.file);
            writeFileSync(p, readFileSync(p, 'latin1').replace('Table 3.', 'Table 3 RELOADED.'), 'latin1');
            let seen = false;
            for (let i = 0; i < 20 && !seen; i++) {
                await sleep(500);
                for (const f of page.frames()) {
                    if (f === page.mainFrame()) continue;
                    try { if (await f.evaluate(() => document.body?.innerText.includes('Table 3 RELOADED.'))) { seen = true; break; } } catch { }
                }
            }
            c.expect = []; info.text += seen ? '' : ' (no reload)';
            c.reloaded = seen;
        }
        const text = info?.text ?? '';
        const expectOk = (c.expect ?? []).every((e) => text.includes(e));
        const editorGroups = await page.locator('.editor-group-container').count();
        const pass = !!frame && hits.length === 0 && frameUrls.length === 0 && (info?.csp?.[0] ?? '').includes("default-src 'none'")
            && expectOk && (!c.image || (info.images.length === 1 && info.images[0] > 0)) && (!c.side || (c.textEditor && editorGroups >= 2)) && (!c.reload || c.reloaded);
        failures += pass ? 0 : 1;
        console.log(`${pass ? 'PASS' : 'FAIL'} ${JSON.stringify({ file: c.file, side: !!c.side, rendered: !!frame, ms: c.timeit ? elapsed : undefined, hits: [...new Set(hits)], frameUrls, csp: info?.csp, sandbox: info?.sandbox, images: info?.images, expectOk, textEditor: c.textEditor, reloaded: c.reloaded, editorGroups: c.side ? editorGroups : undefined, clickResult, sample: text.replace(/\s+/g, ' ').slice(0, 90) })}`);
        await context.close();
    }
} finally {
    await browser.close();
    server.kill();
    beacon.close();
}
const logs = [];
const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/exthost\.log$/.test(e.name)) logs.push(p); } };
if (existsSync(join(dirs['user-data'], 'logs'))) walk(join(dirs['user-data'], 'logs'));
const host = logs.map((p) => readFileSync(p, 'utf8')).join('\n');
console.log('activation:', host.split('\n').filter((l) => /_doActivateExtension dcri-biostats/.test(l)).map((l) => l.replace(/^.*_doActivateExtension /, '')).slice(0, 1));
console.log('screenshots:', scratch);
console.log(`${CASES.length - failures}/${CASES.length} passed`);
if (failures) process.exitCode = 1;
