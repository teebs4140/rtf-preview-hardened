// Unit tests for the RTF parser and the shipped bundle. Run after `tsc`: node --test test/unit/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { rtfToHtml } = require(join(ROOT, 'out', 'rtfParser.js'));
const FIX = join(ROOT, 'test', 'fixtures');
const load = (rel) => readFileSync(join(FIX, rel), 'latin1');
const render = (rel) => rtfToHtml(load(rel));
const ALL_FIXTURES = ['sas', 'synthetic'].flatMap((d) => readdirSync(join(FIX, d)).filter((f) => f.endsWith('.rtf')).map((f) => `${d}/${f}`));

// ---------------------------------------------------------------------------------------------
// Output allowlist: the only markup the parser may produce, whatever the input.

const TAGS = new Set(['br', 'span', 'table', 'tr', 'td', 'sup', 'sub', 'hr', 'img', 'div', 'code']);
const CLASSES = new Set(['page-break', 'pict-placeholder', 'rtf-header', 'rtf-footer']);
const ATTR_RULES = {
    style: /^[A-Za-z0-9 #(),.%:;'_-]*$/,
    colspan: /^[0-9]{1,4}$/,
    src: /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]*$/,
    class: { test: (v) => CLASSES.has(v) },
};

function checkMarkup(html) {
    const problems = [];
    const rest = html.replace(/<(\/?)([a-z]+)((?:\s+[a-z]+="[^"]*")*)\s*>/g, (_m, close, tag, attrs) => {
        if (!TAGS.has(tag)) problems.push(`tag <${tag}>`);
        if (close && attrs) problems.push(`attributes on </${tag}>`);
        for (const [, name, value] of attrs.matchAll(/\s+([a-z]+)="([^"]*)"/g)) {
            const rule = ATTR_RULES[name];
            if (!rule) problems.push(`attribute ${name} on <${tag}>`);
            else if (!rule.test(value)) problems.push(`${name}="${value.slice(0, 80)}"`);
            if (name === 'style' && /url\(|expression|@import|\\/i.test(value)) problems.push(`style ${value.slice(0, 80)}`);
        }
        if (tag === 'img' && !/\ssrc="/.test(attrs)) problems.push('<img> without src');
        return '';
    });
    // After removing allowed tags, any '<' or '>' left is raw markup that escaped escaping.
    if (/[<>]/.test(rest)) problems.push(`raw markup: ${rest.match(/.{0,30}[<>].{0,30}/s)[0]}`);
    if (/\u0000/.test(html)) problems.push('placeholder left in output');
    return problems;
}

for (const f of ALL_FIXTURES) {
    test(`output allowlist: ${f}`, () => {
        assert.deepEqual(checkMarkup(render(f)), []);
    });
}

test('allowlist checker catches injected markup (self-test)', () => {
    assert.notDeepEqual(checkMarkup('<img src=http://x>'), []);
    assert.notDeepEqual(checkMarkup('<span style="background:url(http://x)">a</span>'), []);
    assert.notDeepEqual(checkMarkup('<span style="font-family:\'A\'"><img/src=x>\',serif">'), []);
    assert.notDeepEqual(checkMarkup('<iframe src="data:image/png;base64,AA"></iframe>'), []);
    assert.deepEqual(checkMarkup('<td colspan="2" style="width:1.00in">a &lt;b&gt;</td>'), []);
});

// ---------------------------------------------------------------------------------------------
// Audit findings: file content is shown as text.

test('hex and \\u escapes render as text, not tags', () => {
    const html = render('synthetic/hostile-beacons.rtf');
    assert.match(html, /&lt;img src=http:\/\/127\.0\.0\.1:47777\/img-hex&gt;/);
    assert.match(html, /&lt;iframe src=/);
    assert.match(html, /&lt;link rel=stylesheet/);
    assert.match(html, /&lt;a id=lnk href=https:\/\/example\.org\/phish&gt;/);
    assert.doesNotMatch(html, /http:\/\/127\.0\.0\.1:47777[^<]*"/);
});

test('a font name that breaks out of CSS is dropped', () => {
    const html = render('synthetic/hostile-fontname.rtf');
    assert.equal(html, 'FONTNAME-PAGE<br>');
});

test('spoofing payload stays visible text and the real table is kept', () => {
    const html = render('synthetic/hostile-spoof.rtf');
    assert.match(html, /<td[^>]*>1\.42 \(1\.10, 1\.83\)<\/td>/);
    assert.match(html, /<td[^>]*>0\.007<\/td>/);
    assert.match(html, /&lt;style&gt; table\{display:none !important\} &lt;\/style&gt;/);
});

test('meta refresh renders as text', () => {
    assert.match(render('synthetic/hostile-refresh.rtf'), /^&lt;meta http-equiv=refresh/);
});

test('hyperlink fields show their text only; object data is skipped', () => {
    const html = render('synthetic/fields.rtf');
    assert.equal(html, 'See example dot org here.<br>object-result<br>');
});

// ---------------------------------------------------------------------------------------------
// SAS output fidelity

test('TITLE/FOOTNOTE in page header/footer are shown, footnote after the table', () => {
    const html = render('sas/titles-footnotes.rtf');
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.match(text, /Table 1\. Weight ≥ 100 lb by sex/);
    assert.match(text, /Mean ± SD – SASHELP\.CLASS/);
    assert.match(text, /Table 2\. Frequency of sex by age/);
    assert.doesNotMatch(text, /[≥±–]\?/);
    const foot = html.indexOf('Footnote: values are from SASHELP.CLASS.');
    assert.ok(foot > html.indexOf('</table>', html.indexOf('Std Dev')), 'footnote follows the MEANS table');
    assert.match(html, /<div class="rtf-header">/);
    assert.match(html, /<hr class="page-break">/);
});

test('BODYTITLE output: spanning headers keep their colspan', () => {
    const html = render('sas/bodytitle-spanning.rtf');
    assert.match(html, /Table 3\. Height and weight by sex/);
    assert.match(html, /<td colspan="2"[^>]*>(<span[^>]*>)?Height/);
    assert.match(html, /<td colspan="2"[^>]*>(<span[^>]*>)?Weight/);
});

test('PNG graph is shown as an image', () => {
    const html = render('sas/graph-png.rtf');
    assert.equal((html.match(/<img src="data:image\/png;base64,iVBORw0KGgo/g) || []).length, 1);
    assert.doesNotMatch(html, /pict-placeholder/);
});

test('EMF graph gets a placeholder with the PNG tip', () => {
    const html = render('sas/graph-emf.rtf');
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /Graph not shown: EMF pictures can&#39;t be previewed|Graph not shown: EMF pictures can't be previewed/);
    assert.match(html, /ods graphics \/ outputfmt=png;/);
});

test('characters: \\uc fallback skipped, Windows-1252 bytes decoded', () => {
    const text = render('synthetic/chars.rtf');
    assert.equal(text, 'A ≥ 5; B ± 2; C –D; en–dash; q“x”; raw–byte<br>');
});

test('formatting: \\ul0 is off, hidden text is hidden, second font resolves', () => {
    const html = render('synthetic/formatting.rtf');
    assert.match(html, /<span style="font-family:'Arial',serif">not underlined<\/span>/);
    assert.match(html, /text-decoration:underline;font-family:'Arial',serif"> underlined/);
    assert.doesNotMatch(html, /hidden-text/);
    assert.match(html, /visible-text/);
});

test('huge numbers are clamped', () => {
    const html = render('synthetic/big-numbers.rtf');
    for (const [, n] of html.matchAll(/font-size:([\d.]+)pt/g)) assert.ok(Number(n) <= 200);
    for (const [, n] of html.matchAll(/(?:width|height|margin-left):([\d.]+)in/g)) assert.ok(Number(n) <= 22);
    for (const [, n] of html.matchAll(/border-top:([\d.]+)px/g)) assert.ok(Number(n) <= 10);
});

test('pictures: nonshppict duplicate skipped, \\bin data never shown, EMF placeholder', () => {
    const html = render('synthetic/pictures.rtf');
    assert.equal((html.match(/<img /g) || []).length, 1);
    assert.doesNotMatch(html, /script/);
    assert.match(html, /before<div class="pict-placeholder">Graph not shown: this picture format/);
    assert.match(html, /EMF pictures/);
});

test('sections: each header at its section start, footer at its section end, empty footer dropped', () => {
    const html = render('synthetic/sections.rtf');
    assert.equal(html, '<div class="rtf-header">Section one title<br></div>body one<br><div class="rtf-footer">Section one footnote<br></div>'
        + '<hr class="page-break"><div class="rtf-header">Section two title<br></div>body two<br>');
});

// ---------------------------------------------------------------------------------------------
// Robustness: there is no fallback renderer, so the parser must not throw or hang on broken input.

test('mutated fixtures never throw, finish quickly and pass the allowlist', () => {
    let seed = 20261015;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const alphabet = '{}\\\'*;<>"&0123456789abcdefuc ';
    for (const f of ALL_FIXTURES) {
        const src = load(f);
        for (let n = 0; n < 40; n++) {
            const chars = src.split('');
            const edits = 1 + Math.floor(rand() * 20);
            for (let e = 0; e < edits; e++) {
                const at = Math.floor(rand() * chars.length);
                const r = rand();
                if (r < 0.4) chars[at] = alphabet[Math.floor(rand() * alphabet.length)];
                else if (r < 0.7) chars.splice(at, 1 + Math.floor(rand() * 8));
                else chars.splice(at, 0, ...'{\\*\\'.slice(0, 1 + Math.floor(rand() * 4)));
            }
            const mutated = rand() < 0.2 ? chars.join('').slice(0, Math.floor(rand() * chars.length)) : chars.join('');
            const t0 = Date.now();
            let html;
            assert.doesNotThrow(() => { html = rtfToHtml(mutated); }, `${f} mutation ${n}`);
            assert.ok(Date.now() - t0 < 2000, `${f} mutation ${n} took ${Date.now() - t0} ms`);
            assert.deepEqual(checkMarkup(html), [], `${f} mutation ${n}`);
        }
    }
});

// ---------------------------------------------------------------------------------------------
// Shipped code: no processes, network or dynamic code.

test('compiled extension has no child_process, network or eval', () => {
    for (const f of ['extension.js', 'rtfParser.js']) {
        const js = readFileSync(join(ROOT, 'out', f), 'utf8');
        assert.doesNotMatch(js, /child_process|require\("(https?|net|tls|dgram)"\)|\beval\(|new Function\(|fetch\(/, f);
        const requires = [...js.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
        assert.deepEqual(requires.filter((r) => !['vscode', './rtfParser'].includes(r)), [], f);
    }
});
