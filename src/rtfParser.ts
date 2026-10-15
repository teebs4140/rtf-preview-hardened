/** RTF-to-HTML converter for SAS ODS RTF output.
 *  Handles tables with colspan, borders, cell backgrounds, alignment,
 *  embedded PNG/JPEG images, fonts, colors, formatting, page headers/footers
 *  (SAS TITLE/FOOTNOTE text) and section/page breaks.
 *
 *  File content is untrusted. Every character that comes from the file is written
 *  through escapeText(); markup is only ever produced by this module, and numbers
 *  that end up in CSS are clamped.
 */

interface RtfState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  hidden: boolean;
  fontSize: number;
  fontIndex: number;
  foreColor: number;
  backColor: number;
  superscript: boolean;
  subscript: boolean;
  align: string;
  leftIndent: number;   // \li in twips
  firstIndent: number;  // \fi in twips
  uc: number;           // \uc: fallback characters to skip after \u
}

interface CellDef {
  borderTop: boolean;
  borderBottom: boolean;
  borderLeft: boolean;
  borderRight: boolean;
  borderTopStyle: string;
  borderBottomStyle: string;
  borderLeftStyle: string;
  borderRightStyle: string;
  borderTopWidth: number;
  borderBottomWidth: number;
  borderLeftWidth: number;
  borderRightWidth: number;
  borderTopColor: number;
  borderBottomColor: number;
  borderLeftColor: number;
  borderRightColor: number;
  bgColor: number;
  vertAlign: string;
  rightEdge: number;
  merged: boolean;       // \clmrg — continuation of horizontal merge
  mergeFirst: boolean;   // \clmgf — first cell in horizontal merge
  padTop: number;
  padRight: number;
  padBottom: number;
  padLeft: number;
}

/** A <td> whose colspan is filled in when its table closes and the table's column grid is known. */
interface PendingTd { cellDefs: CellDef[]; cellIndex: number; align: string; }

const TWIPS_PER_INCH = 1440;
const MAX_TWIPS = 22 * TWIPS_PER_INCH;

/** Destination groups whose content is never shown. Header/footer variants other than
 *  plain \header and \footer are skipped so a title is not shown twice. */
const SKIP_DESTINATIONS = new Set([
  'headerl', 'headerr', 'headerf', 'footerl', 'footerr', 'footerf',
  'info', 'stylesheet', 'fonttbl', 'colortbl', 'nonshppict',
  'listtable', 'listoverridetable', 'rsidtbl', 'revtbl', 'filetbl', 'xmlnstbl', 'pgdsctbl',
  'latentstyles', 'themedata', 'colorschememapping', 'datastore', 'generator',
  'fldinst', 'bkmkstart', 'bkmkend', 'pnseclvl', 'pntxta', 'pntxtb',
  'objdata', 'objclass', 'annotation', 'atnid', 'atnauthor', 'xe', 'tc', 'template', 'userprops', 'docvar',
]);

/** Picture formats a browser can display, keyed by RTF blip control word. */
const SHOWABLE_PICT = new Map([['pngblip', 'image/png'], ['jpegblip', 'image/jpeg']]);
const PICT_FORMAT_NAMES = new Map([
  ['emfblip', 'EMF'], ['wmetafile', 'WMF'], ['pmmetafile', 'OS/2 metafile'], ['macpict', 'PICT'], ['dibitmap', 'bitmap'], ['wbitmap', 'bitmap'],
]);

/** Windows-1252 characters for bytes 0x80–0x9F (undefined bytes map to ''). */
const CP1252_HIGH = [
  '\u20AC', '', '\u201A', '\u0192', '\u201E', '\u2026', '\u2020', '\u2021', '\u02C6', '\u2030', '\u0160', '\u2039', '\u0152', '', '\u017D', '',
  '', '\u2018', '\u2019', '\u201C', '\u201D', '\u2022', '\u2013', '\u2014', '\u02DC', '\u2122', '\u0161', '\u203A', '\u0153', '', '\u017E', '\u0178',
];

function defaultState(): RtfState {
  return {
    bold: false, italic: false, underline: false, strike: false, hidden: false, fontSize: 20, fontIndex: 0, foreColor: 0, backColor: 0,
    superscript: false, subscript: false, align: 'left', leftIndent: 0, firstIndent: 0, uc: 1,
  };
}
function cloneState(s: RtfState): RtfState { return { ...s }; }

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

export function rtfToHtml(rtf: string): string {
  const tokens = tokenize(rtf);
  const fonts = parseFontTable(tokens);
  const colors = parseColorTable(rtf);
  const cp1252 = usesCp1252(rtf);

  const stateStack: RtfState[] = [];
  let state = defaultState();
  let html = '';
  let inTable = false, inRow = false, inCell = false;
  let cellDefs: CellDef[] = [];
  let cellIndex = 0;
  let skipDepth = 0;
  let groupDepth = 0;
  let inPict = false;
  let pictData = '';
  let pictProps = { width: 0, height: 0, format: '' };
  let pendingCellBorders: Partial<CellDef> = {};
  // Track which border side we're currently defining
  let pendingBorderSide: 'top' | 'bottom' | 'left' | 'right' | null = null;
  let inMergedCell = false;
  let intbl = false;
  let ucSkip = 0;               // \u fallback characters still to skip

  // Current table: start offset in `html`, its column edges and its pending <td>s.
  let tableStart = 0;
  let tableEdges = new Set<number>();
  let pendingTds: PendingTd[] = [];

  // Page header/footer (SAS TITLE/FOOTNOTE). The footer is buffered and shown at the end of its section.
  let hfKind: 'header' | 'footer' | null = null;
  let hfDepth = 0;
  let bodyHtml = '';
  let footerHtml = '';
  let headerStart = 0;

  const decodeChar = (s: string): string => (cp1252 ? mapCp1252(s) : s);

  function openTd(): string {
    pendingTds.push({ cellDefs, cellIndex, align: state.align });
    return `\u0000${pendingTds.length - 1}\u0000`;
  }

  function startCellIfNeeded() {
    if (inTable && !inCell) {
      if (!inRow) { html += '<tr>'; inRow = true; }
      // Skip merged continuation cells
      while (cellIndex < cellDefs.length && cellDefs[cellIndex].merged) { cellIndex++; }
      html += openTd();
      inCell = true;
    }
  }

  function closeTable() {
    if (!inTable) return;
    if (inCell) { html += '</td>'; inCell = false; }
    if (inRow) { html += '</tr>'; inRow = false; }
    html += '</table>';
    inTable = false;
    const grid = [...tableEdges].sort((a, b) => a - b);
    const tds = pendingTds;
    html = html.slice(0, tableStart) + html.slice(tableStart).replace(/\u0000(\d+)\u0000/g, (_m, n) => {
      const td = tds[Number(n)];
      return buildTdOpen(td, colors, computeCellColspan(td.cellDefs, td.cellIndex, grid));
    });
    tableEdges = new Set();
    pendingTds = [];
    inMergedCell = false;
  }

  function flushFooter() {
    html += footerHtml;
    footerHtml = '';
  }

  function emitText(raw: string) {
    if (state.hidden) return;
    let tok = raw;
    if (ucSkip > 0) {
      const n = Math.min(ucSkip, tok.length);
      tok = tok.slice(n);
      ucSkip -= n;
      if (tok.length === 0) return;
    }

    // Spaces between table cells are formatting, not text
    if (/^[ \t]*$/.test(tok) && !inTable) {
      if (tok.includes(' ')) html += ' ';
      return;
    }

    // Close table if we're no longer in intbl mode
    if (inTable && !intbl) closeTable();

    // Suppress text in merged continuation cells
    if (inMergedCell) return;

    startCellIfNeeded();

    // Emit styled text
    const styles: string[] = [];
    if (state.bold) styles.push('font-weight:bold');
    if (state.italic) styles.push('font-style:italic');
    const deco: string[] = [];
    if (state.underline) deco.push('underline');
    if (state.strike) deco.push('line-through');
    if (deco.length) styles.push(`text-decoration:${deco.join(' ')}`);
    if (state.fontSize !== 20) styles.push(`font-size:${state.fontSize / 2}pt`);
    const fg = colors[state.foreColor];
    if (state.foreColor > 0 && fg) styles.push(`color:${fg}`);
    const bg = colors[state.backColor];
    if (state.backColor > 0 && bg) styles.push(`background-color:${bg}`);
    const fontName = fonts.get(state.fontIndex);
    if (fontName) styles.push(`font-family:'${fontName}',serif`);
    if (state.leftIndent > 0) styles.push(`margin-left:${(state.leftIndent / TWIPS_PER_INCH).toFixed(3)}in`);
    if (state.firstIndent !== 0) styles.push(`text-indent:${(state.firstIndent / TWIPS_PER_INCH).toFixed(3)}in`);

    let text = escapeText(tok);
    if (state.superscript) text = `<sup>${text}</sup>`;
    if (state.subscript) text = `<sub>${text}</sub>`;

    if (styles.length > 0) {
      html += `<span style="${styles.join(';')}">${text}</span>`;
    } else {
      html += text;
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (tok === '{') {
      groupDepth++;
      stateStack.push(cloneState(state));
      ucSkip = 0;
      if (skipDepth > 0) { skipDepth++; continue; }
      if (i + 1 < tokens.length) {
        const next = tokens[i + 1];
        if (next === '\\*') {
          if (i + 2 < tokens.length) {
            const dest = tokens[i + 2];
            const m = dest.match(/^\\([a-z]+)/);
            // Skip all \* destinations except shppict (contains images)
            if (m && m[1] !== 'shppict') { skipDepth = 1; continue; }
          }
          continue;
        }
        const cwm = next.match(/^\\([a-z]+)/);
        if (cwm && SKIP_DESTINATIONS.has(cwm[1])) { skipDepth = 1; continue; }
        if (cwm && (cwm[1] === 'header' || cwm[1] === 'footer') && hfKind === null && !inPict) {
          closeTable();
          intbl = false;
          hfKind = cwm[1];
          hfDepth = groupDepth;
          if (hfKind === 'footer') { bodyHtml = html; html = ''; } else { headerStart = html.length; html += '<div class="rtf-header">'; }
        }
      }
      continue;
    }

    if (tok === '}') {
      ucSkip = 0;
      if (skipDepth > 0) { skipDepth--; groupDepth--; state = stateStack.pop() || defaultState(); continue; }
      if (inPict) {
        inPict = false;
        if (inTable && !inCell && !inMergedCell) startCellIfNeeded();
        html += renderPict(pictProps.format, pictData, pictProps.width, pictProps.height);
        pictData = '';
      }
      if (hfKind !== null && groupDepth === hfDepth) {
        closeTable();
        intbl = false;
        if (hfKind === 'header') {
          html = hasVisibleContent(html.slice(headerStart)) ? html + '</div>' : html.slice(0, headerStart);
        } else {
          footerHtml = hasVisibleContent(html) ? `<div class="rtf-footer">${html}</div>` : '';
          html = bodyHtml;
          bodyHtml = '';
        }
        hfKind = null;
      }
      groupDepth--;
      state = stateStack.pop() || defaultState();
      continue;
    }

    if (skipDepth > 0) continue;

    // Inside picture — collect hex data
    if (inPict) {
      if (tok.startsWith('\\')) {
        const cwm = tok.match(/^\\([a-z]+)(-?\d+)?$/);
        if (cwm) {
          const w = cwm[1], p = cwm[2] !== undefined ? parseInt(cwm[2]) : undefined;
          if (SHOWABLE_PICT.has(w) || PICT_FORMAT_NAMES.has(w)) pictProps.format = w;
          else if (w === 'bin') pictProps.format = 'bin';
          else if (w === 'picwgoal' && p !== undefined) pictProps.width = clamp(p, 0, MAX_TWIPS);
          else if (w === 'pichgoal' && p !== undefined) pictProps.height = clamp(p, 0, MAX_TWIPS);
        }
      } else {
        pictData += tok.replace(/[^0-9a-fA-F]/g, '');
      }
      continue;
    }

    // Control symbols and words
    if (tok.startsWith('\\')) {
      if (tok === '\\*') continue;
      const cwm = tok.match(/^\\([a-zA-Z]+)(-?\d+)?$/);
      if (!cwm) {
        // A control symbol counts as one \u fallback character.
        if (ucSkip > 0) { ucSkip--; continue; }
        if (tok === '\\\\') emitText('\\');
        else if (tok === '\\{') emitText('{');
        else if (tok === '\\}') emitText('}');
        else if (tok === '\\~') emitText('\u00A0');
        else if (tok === '\\_') emitText('\u2011');
        else if (tok.startsWith("\\'")) {
          const code = parseInt(tok.substring(2), 16);
          if (!isNaN(code)) emitText(decodeChar(String.fromCharCode(code)));
        }
        continue;
      }

      const word = cwm[1];
      // Skip unknown uppercase control words (e.g. \E from SAS)
      if (word !== word.toLowerCase()) continue;

      const param = cwm[2] !== undefined ? parseInt(cwm[2]) : undefined;
      if (ucSkip > 0 && word !== 'u') { ucSkip--; continue; }

      switch (word) {
        case 'b': state.bold = param !== 0; break;
        case 'i': state.italic = param !== 0; break;
        case 'ul': case 'ulw': case 'uld': case 'uldb': case 'uldash': case 'ulth': case 'ulwave':
          state.underline = param !== 0; break;
        case 'ulnone': state.underline = false; break;
        case 'strike': state.strike = param !== 0; break;
        case 'v': state.hidden = param !== 0; break;
        case 'fs': if (param !== undefined) state.fontSize = clamp(param, 2, 400); break;
        case 'f': if (param !== undefined) state.fontIndex = param; break;
        case 'cf': if (param !== undefined) state.foreColor = param; break;
        case 'cb': case 'highlight': if (param !== undefined) state.backColor = param; break;
        case 'super': state.superscript = true; state.subscript = false; break;
        case 'sub': state.subscript = true; state.superscript = false; break;
        case 'nosupersub': state.superscript = false; state.subscript = false; break;
        case 'ql': state.align = 'left'; break;
        case 'qc': state.align = 'center'; break;
        case 'qr': state.align = 'right'; break;
        case 'qj': state.align = 'justify'; break;
        case 'par':
          if (inTable && !intbl) closeTable();
          html += '<br>'; break;
        case 'line': html += '<br>'; break;
        case 'tab': emitText('\u2003'); break;
        case 'lquote': emitText('\u2018'); break;
        case 'rquote': emitText('\u2019'); break;
        case 'ldblquote': emitText('\u201C'); break;
        case 'rdblquote': emitText('\u201D'); break;
        case 'emdash': emitText('\u2014'); break;
        case 'endash': emitText('\u2013'); break;
        case 'bullet': emitText('\u2022'); break;
        case 'uc': if (param !== undefined) state.uc = clamp(param, 0, 10); break;
        case 'u':
          if (param !== undefined) {
            emitText(String.fromCharCode(param < 0 ? param + 65536 : param & 0xFFFF));
            ucSkip = state.uc;
          }
          break;
        case 'pard': state = { ...defaultState(), align: 'left', uc: state.uc }; intbl = false; break;
        case 'plain': state = { ...defaultState(), align: state.align, leftIndent: state.leftIndent, firstIndent: state.firstIndent, uc: state.uc }; break;
        case 'li': if (param !== undefined) state.leftIndent = clamp(param, -MAX_TWIPS, MAX_TWIPS); break;
        case 'fi': if (param !== undefined) state.firstIndent = clamp(param, -MAX_TWIPS, MAX_TWIPS); break;

        case 'trowd':
          if (!inTable) { html += '<table>'; inTable = true; tableStart = html.length - '<table>'.length; }
          if (inCell) { html += '</td>'; inCell = false; }
          if (inRow) { html += '</tr>'; }
          cellDefs = [];
          cellIndex = 0;
          pendingCellBorders = {};
          pendingBorderSide = null;
          inRow = false;
          inMergedCell = false;
          break;

        case 'clbrdrt': pendingBorderSide = 'top'; pendingCellBorders.borderTop = true; break;
        case 'clbrdrb': pendingBorderSide = 'bottom'; pendingCellBorders.borderBottom = true; break;
        case 'clbrdrl': pendingBorderSide = 'left'; pendingCellBorders.borderLeft = true; break;
        case 'clbrdrr': pendingBorderSide = 'right'; pendingCellBorders.borderRight = true; break;
        case 'brdrs': case 'brdrdot': case 'brdrdash': case 'brdrdb': case 'brdrth': case 'brdrsh':
        case 'brdrnone': {
          const style = word === 'brdrnone' ? 'none' : word === 'brdrdot' ? 'dotted' : word === 'brdrdash' ? 'dashed' : word === 'brdrdb' ? 'double' : 'solid';
          if (pendingBorderSide === 'top') pendingCellBorders.borderTopStyle = style;
          else if (pendingBorderSide === 'bottom') pendingCellBorders.borderBottomStyle = style;
          else if (pendingBorderSide === 'left') pendingCellBorders.borderLeftStyle = style;
          else if (pendingBorderSide === 'right') pendingCellBorders.borderRightStyle = style;
          if (word === 'brdrnone') {
            if (pendingBorderSide === 'top') pendingCellBorders.borderTop = false;
            else if (pendingBorderSide === 'bottom') pendingCellBorders.borderBottom = false;
            else if (pendingBorderSide === 'left') pendingCellBorders.borderLeft = false;
            else if (pendingBorderSide === 'right') pendingCellBorders.borderRight = false;
          }
          break;
        }
        case 'brdrw':
          if (param !== undefined) {
            const w = clamp(param, 0, 100);
            if (pendingBorderSide === 'top') pendingCellBorders.borderTopWidth = w;
            else if (pendingBorderSide === 'bottom') pendingCellBorders.borderBottomWidth = w;
            else if (pendingBorderSide === 'left') pendingCellBorders.borderLeftWidth = w;
            else if (pendingBorderSide === 'right') pendingCellBorders.borderRightWidth = w;
          }
          break;
        case 'brdrcf':
          if (param !== undefined) {
            if (pendingBorderSide === 'top') pendingCellBorders.borderTopColor = param;
            else if (pendingBorderSide === 'bottom') pendingCellBorders.borderBottomColor = param;
            else if (pendingBorderSide === 'left') pendingCellBorders.borderLeftColor = param;
            else if (pendingBorderSide === 'right') pendingCellBorders.borderRightColor = param;
          }
          break;
        case 'clcbpat': if (param !== undefined) pendingCellBorders.bgColor = param; break;
        case 'clvertalc': pendingCellBorders.vertAlign = 'middle'; break;
        case 'clvertalb': pendingCellBorders.vertAlign = 'bottom'; break;
        case 'clvertalt': pendingCellBorders.vertAlign = 'top'; break;
        case 'clmgf': pendingCellBorders.mergeFirst = true; pendingCellBorders.merged = false; break;
        case 'clmrg': pendingCellBorders.merged = true; pendingCellBorders.mergeFirst = false; break;
        case 'clpadt': if (param !== undefined) pendingCellBorders.padTop = clamp(param, 0, TWIPS_PER_INCH); break;
        case 'clpadr': if (param !== undefined) pendingCellBorders.padRight = clamp(param, 0, TWIPS_PER_INCH); break;
        case 'clpadb': if (param !== undefined) pendingCellBorders.padBottom = clamp(param, 0, TWIPS_PER_INCH); break;
        case 'clpadl': if (param !== undefined) pendingCellBorders.padLeft = clamp(param, 0, TWIPS_PER_INCH); break;

        case 'cellx':
          if (param !== undefined) {
            const edge = clamp(param, 0, MAX_TWIPS);
            if (inTable) tableEdges.add(edge);
            cellDefs.push({
              borderTop: pendingCellBorders.borderTop || false,
              borderBottom: pendingCellBorders.borderBottom || false,
              borderLeft: pendingCellBorders.borderLeft || false,
              borderRight: pendingCellBorders.borderRight || false,
              borderTopStyle: pendingCellBorders.borderTopStyle || 'solid',
              borderBottomStyle: pendingCellBorders.borderBottomStyle || 'solid',
              borderLeftStyle: pendingCellBorders.borderLeftStyle || 'solid',
              borderRightStyle: pendingCellBorders.borderRightStyle || 'solid',
              borderTopWidth: pendingCellBorders.borderTopWidth || 0,
              borderBottomWidth: pendingCellBorders.borderBottomWidth || 0,
              borderLeftWidth: pendingCellBorders.borderLeftWidth || 0,
              borderRightWidth: pendingCellBorders.borderRightWidth || 0,
              borderTopColor: pendingCellBorders.borderTopColor || 0,
              borderBottomColor: pendingCellBorders.borderBottomColor || 0,
              borderLeftColor: pendingCellBorders.borderLeftColor || 0,
              borderRightColor: pendingCellBorders.borderRightColor || 0,
              bgColor: pendingCellBorders.bgColor || 0,
              vertAlign: pendingCellBorders.vertAlign || 'top',
              rightEdge: edge,
              merged: pendingCellBorders.merged || false,
              mergeFirst: pendingCellBorders.mergeFirst || false,
              padTop: pendingCellBorders.padTop || 0,
              padRight: pendingCellBorders.padRight || 0,
              padBottom: pendingCellBorders.padBottom || 0,
              padLeft: pendingCellBorders.padLeft || 0,
            });
            pendingCellBorders = {};
            pendingBorderSide = null;
          }
          break;

        case 'intbl': intbl = true; break;

        case 'cell':
          // Emit empty cell if cell was never opened
          if (inTable && !inCell && !inMergedCell) startCellIfNeeded();
          if (inCell) { html += '</td>'; inCell = false; }
          inMergedCell = false;
          cellIndex++;
          // Check if the next raw cell is a merged continuation — suppress its content
          if (cellIndex < cellDefs.length && cellDefs[cellIndex].merged) {
            inMergedCell = true;
          }
          break;

        case 'row':
          if (inCell) { html += '</td>'; inCell = false; }
          if (inRow) { html += '</tr>'; }
          inRow = false;
          cellIndex = 0;
          inMergedCell = false;
          break;

        case 'page':
          closeTable();
          html += '<hr class="page-break">';
          break;

        case 'sect':
          closeTable();
          if (hfKind === null) { flushFooter(); html += '<hr class="page-break">'; }
          break;

        case 'pict':
          inPict = true;
          pictData = '';
          pictProps = { width: 0, height: 0, format: '' };
          break;

        default: break;
      }
      continue;
    }

    emitText(decodeChar(tok));
  }

  closeTable();
  if (hfKind === 'header') html += '</div>';
  else if (hfKind === 'footer') { html = bodyHtml; }
  flushFooter();

  return html;
}

function renderPict(format: string, hex: string, widthTwips: number, heightTwips: number): string {
  const mime = SHOWABLE_PICT.get(format);
  if (mime && hex.length >= 2) {
    const b64 = hexToBase64(hex);
    const wIn = widthTwips > 0 ? widthTwips / TWIPS_PER_INCH : 8;
    const hIn = heightTwips > 0 ? heightTwips / TWIPS_PER_INCH : 5.5;
    return `<img src="data:${mime};base64,${b64}" style="width:${wIn.toFixed(3)}in;height:${hIn.toFixed(3)}in;max-width:100%">`;
  }
  const name = PICT_FORMAT_NAMES.get(format);
  const what = name ? `${name} pictures` : 'this picture format';
  return `<div class="pict-placeholder">Graph not shown: ${what} can't be previewed. `
    + `For SAS output, add <code>ods graphics / outputfmt=png;</code> before the procedure.</div>`;
}

function hasVisibleContent(fragment: string): boolean {
  if (/<img |class="pict-placeholder"/.test(fragment)) return true;
  return fragment.replace(/<[^>]*>/g, '').replace(/&nbsp;|\u00A0|&emsp;|\u2003/g, '').trim().length > 0;
}

function computeCellColspan(cellDefs: CellDef[], cellIndex: number, grid: number[]): number {
  if (cellIndex >= cellDefs.length || grid.length === 0) return 1;
  const def = cellDefs[cellIndex];
  const leftEdge = cellIndex > 0 ? cellDefs[cellIndex - 1].rightEdge : 0;
  // For merged-first cells, include continuation cells' edges
  let rightEdge = def.rightEdge;
  if (def.mergeFirst) {
    for (let j = cellIndex + 1; j < cellDefs.length; j++) {
      if (cellDefs[j].merged) rightEdge = cellDefs[j].rightEdge;
      else break;
    }
  }
  // Count grid columns this cell spans
  let startCol = grid.indexOf(leftEdge) + 1; // grid column after leftEdge; if leftEdge=0, start at 0
  if (leftEdge === 0) startCol = 0;
  else if (startCol === 0) startCol = 0; // leftEdge not in grid, start at 0
  let endCol = grid.indexOf(rightEdge);
  if (endCol < 0) endCol = grid.length - 1;
  const span = endCol - startCol + 1;
  return span > 1 ? span : 1;
}

function cssColor(colors: (string | null)[], index: number, fallback: string): string {
  return colors[index] ?? fallback;
}

function buildTdOpen(td: PendingTd, colors: (string | null)[], colspan: number): string {
  const { cellDefs, cellIndex } = td;
  const def = cellDefs[cellIndex];
  const styles: string[] = [];
  if (def) {
    const prevEdge = cellIndex > 0 ? cellDefs[cellIndex - 1].rightEdge : 0;
    const widthTwips = Math.max(0, def.rightEdge - prevEdge);
    if (colspan <= 1) styles.push(`width:${(widthTwips / TWIPS_PER_INCH).toFixed(2)}in`);
    const side = (on: boolean, name: string, width: number, style: string, color: number) => {
      if (on) styles.push(`border-${name}:${Math.max(1, width / 10)}px ${style || 'solid'} ${cssColor(colors, color, '#000')}`);
    };
    side(def.borderTop, 'top', def.borderTopWidth, def.borderTopStyle, def.borderTopColor);
    side(def.borderBottom, 'bottom', def.borderBottomWidth, def.borderBottomStyle, def.borderBottomColor);
    side(def.borderLeft, 'left', def.borderLeftWidth, def.borderLeftStyle, def.borderLeftColor);
    side(def.borderRight, 'right', def.borderRightWidth, def.borderRightStyle, def.borderRightColor);
    if (def.bgColor > 0 && colors[def.bgColor]) styles.push(`background-color:${colors[def.bgColor]}`);
    styles.push(`vertical-align:${def.vertAlign}`);
    const pad: string[] = [];
    if (def.padTop) pad.push(`${(def.padTop / TWIPS_PER_INCH * 72).toFixed(0)}px`); else pad.push('2px');
    if (def.padRight) pad.push(`${(def.padRight / TWIPS_PER_INCH * 72).toFixed(0)}px`); else pad.push('6px');
    if (def.padBottom) pad.push(`${(def.padBottom / TWIPS_PER_INCH * 72).toFixed(0)}px`); else pad.push('2px');
    if (def.padLeft) pad.push(`${(def.padLeft / TWIPS_PER_INCH * 72).toFixed(0)}px`); else pad.push('6px');
    if (def.padTop || def.padRight || def.padBottom || def.padLeft) styles.push(`padding:${pad.join(' ')}`);
  }
  styles.push(`text-align:${td.align}`);
  const colspanAttr = colspan > 1 ? ` colspan="${colspan}"` : '';
  return `<td${colspanAttr} style="${styles.join(';')}">`;
}

/** Font table: font number → name. Names go into CSS, so only plain names are kept. */
function parseFontTable(tokens: string[]): Map<number, string> {
  const fonts = new Map<number, string>();
  const start = tokens.findIndex((t, i) => t === '{' && tokens[i + 1] === '\\fonttbl');
  if (start < 0) return fonts;
  let depth = 0;
  let num: number | undefined;
  let name = '';
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '{') { depth++; if (depth === 2) { num = undefined; name = ''; } continue; }
    if (t === '}') { depth--; if (depth === 0) break; continue; }
    if (depth > 2) continue; // \panose, \falt, ...
    const fm = t.match(/^\\f(\d+)$/);
    if (fm) { num = parseInt(fm[1]); name = ''; continue; }
    if (t.startsWith('\\')) continue;
    name += t;
    const semi = name.indexOf(';');
    if (semi >= 0) {
      const n = name.slice(0, semi).trim();
      if (num !== undefined && /^[A-Za-z0-9 ._-]{1,64}$/.test(n)) fonts.set(num, n);
      num = undefined;
      name = '';
    }
  }
  return fonts;
}

/** Color table: index → CSS rgb(), or null for the "auto" entry. */
function parseColorTable(rtf: string): (string | null)[] {
  const colors: (string | null)[] = [];
  const m = rtf.match(/\{\\colortbl([\s\S]*?)\}/);
  if (!m) return ['rgb(0,0,0)'];
  const entries = m[1].split(';');
  entries.pop(); // text after the last ';' is not an entry
  for (const entry of entries) {
    const r = entry.match(/\\red(\d+)/);
    const g = entry.match(/\\green(\d+)/);
    const b = entry.match(/\\blue(\d+)/);
    colors.push(r && g && b ? `rgb(${Math.min(255, +r[1])},${Math.min(255, +g[1])},${Math.min(255, +b[1])})` : null);
  }
  return colors;
}

function usesCp1252(rtf: string): boolean {
  const m = rtf.slice(0, 2048).match(/\\ansicpg(\d+)/);
  return !m || m[1] === '1252';
}

function mapCp1252(s: string): string {
  return s.replace(/[\u0080-\u009F]/g, (c) => CP1252_HIGH[c.charCodeAt(0) - 0x80]);
}

function tokenize(rtf: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const len = rtf.length;
  while (i < len) {
    const ch = rtf[i];
    if (ch === '{') { tokens.push('{'); i++; continue; }
    if (ch === '}') { tokens.push('}'); i++; continue; }
    if (ch === '\\') {
      if (i + 1 < len) {
        const next = rtf[i + 1];
        if (next === '{' || next === '}' || next === '\\') { tokens.push('\\' + next); i += 2; continue; }
        if (next === '~' || next === '-' || next === '_') { tokens.push('\\' + next); i += 2; continue; }
        if (next === '*') { tokens.push('\\*'); i += 2; continue; }
        if (next === "'") { tokens.push("\\'" + rtf.substring(i + 2, i + 4)); i += 4; continue; }
        if (next === '\n' || next === '\r') { tokens.push('\\par'); i += 2; if (i < len && rtf[i] === '\n') i++; continue; }
        if (/[a-zA-Z]/.test(next)) {
          let j = i + 1;
          while (j < len && j - i <= 32 && /[a-zA-Z]/.test(rtf[j])) j++;
          let k = j;
          if (k < len && (rtf[k] === '-' || /\d/.test(rtf[k]))) {
            if (rtf[k] === '-') k++;
            while (k < len && k - j <= 10 && /\d/.test(rtf[k])) k++;
          }
          const word = rtf.substring(i, k);
          tokens.push(word);
          if (k < len && rtf[k] === ' ') k++;
          // \binN is followed by N raw bytes: skip them so they are never read as text.
          const bin = word.match(/^\\bin(\d+)$/);
          if (bin) k = Math.min(len, k + parseInt(bin[1]));
          i = k;
          continue;
        }
        tokens.push('\\' + next); i += 2; continue;
      }
      i++; continue;
    }
    if (ch === '\r' || ch === '\n') { i++; continue; }
    let j = i;
    while (j < len && rtf[j] !== '{' && rtf[j] !== '}' && rtf[j] !== '\\' && rtf[j] !== '\r' && rtf[j] !== '\n') j++;
    tokens.push(rtf.substring(i, j));
    i = j;
  }
  return tokens;
}

function hexToBase64(hex: string): string {
  return Buffer.from(hex.length % 2 ? hex.slice(0, -1) : hex, 'hex').toString('base64');
}

/** Escape file-derived text for HTML. Control characters (and the U+0000 used for <td> placeholders) are dropped. */
export function escapeText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
