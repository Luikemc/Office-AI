// Modelo comum de planilha (xlsx e csv): planilhas com células {row, col, valor, formula?, ...}.
import { openZip } from './zip.mjs';
import { find, findAll, kids, local, parseXml, textOf } from './xml.mjs';
import { colNum, deslocar, endereco, parseEndereco } from './formula.mjs';
import { parseNumero } from './valores.mjs';

export const chave = (row, col) => `${row},${col}`;

/** Endereço com planilha, com aspas quando o nome precisa (Excel). */
export function enderecoCompleto(sheet, row, col) {
  const nome = /^[A-Za-z_À-ɏ][\w.À-ɏ]*$/.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`;
  return `${nome}!${endereco(col, row)}`;
}

/** "Plan1!B7" / "'Minha plan'!B7" / "B7" → {sheet?, row, col}. */
export function parseLocal(s) {
  const m = /^\s*(?:(?:'((?:[^']|'')+)'|([^!']+))!)?\s*(\$?[A-Za-z]{1,3}\$?\d+)\s*$/.exec(String(s));
  if (!m) return undefined;
  const a = parseEndereco(m[3]);
  return a && { sheet: m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]?.trim(), ...a };
}

// ------------------------------------------------------------------------------------------------
// XLSX
// ------------------------------------------------------------------------------------------------

const DATA_BUILTIN = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function estilosDeData(stylesXml) {
  if (!stylesXml) return new Set();
  const doc = parseXml(stylesXml);
  const custom = new Map();
  for (const nf of findAll(doc, 'numFmt')) custom.set(Number(nf.attrs.numFmtId), nf.attrs.formatCode ?? '');
  const cellXfs = find(doc, 'cellXfs');
  const out = new Set();
  kids(cellXfs ?? { children: [] }, 'xf').forEach((xf, i) => {
    const id = Number(xf.attrs.numFmtId ?? 0);
    const code = (custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    if (DATA_BUILTIN.has(id) || /[dy]/i.test(code) || (/m/i.test(code) && /[hs]/i.test(code))) out.add(i);
  });
  return out;
}

export function serialParaIso(n) {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000)).toISOString().slice(0, 10);
}

function resolverAlvo(target) {
  if (target.startsWith('/')) return target.slice(1);
  const partes = ['xl'];
  for (const p of target.split('/')) {
    if (p === '..') partes.pop();
    else if (p && p !== '.') partes.push(p);
  }
  return partes.join('/');
}

/** Lê um xlsx: {tipo:'xlsx', zip, planilhas:[{nome, parte, xml, doc, cells: Map}], datas:Set}. */
export function lerXlsx(buf) {
  const zip = openZip(buf);
  const wbXml = zip.text('xl/workbook.xml');
  if (!wbXml) throw new Error('xlsx sem xl/workbook.xml');
  const rels = new Map();
  for (const r of findAll(parseXml(zip.text('xl/_rels/workbook.xml.rels') ?? ''), 'Relationship')) rels.set(r.attrs.Id, r.attrs.Target);
  const shared = [];
  const ssXml = zip.text('xl/sharedStrings.xml');
  if (ssXml) {
    for (const si of findAll(parseXml(ssXml), 'si')) {
      let s = '';
      for (const el of kids(si)) {
        if (local(el.name) === 't') s += textOf(el);
        else if (local(el.name) === 'r') for (const t of kids(el, 't')) s += textOf(t);
      }
      shared.push(s);
    }
  }
  const datas = estilosDeData(zip.text('xl/styles.xml'));
  const planilhas = [];
  for (const sh of findAll(parseXml(wbXml), 'sheet')) {
    const rid = sh.attrs['r:id'] ?? Object.entries(sh.attrs).find(([k]) => /:id$/.test(k))?.[1];
    const target = rels.get(rid);
    if (!target) continue;
    const parte = resolverAlvo(target);
    const xml = zip.text(parte);
    if (xml === undefined) continue;
    planilhas.push({ nome: sh.attrs.name, parte, xml, ...lerCelulas(xml, shared, datas) });
  }
  return { tipo: 'xlsx', zip, wbXml, planilhas };
}

function lerCelulas(xml, shared, datas) {
  const doc = parseXml(xml);
  const sheetData = find(doc, 'sheetData');
  const cells = new Map();
  const mestres = new Map(); // si → {formula, row, col}
  const pendentes = [];
  const rows = sheetData ? kids(sheetData, 'row') : [];
  let rowAuto = 0;
  for (const rowEl of rows) {
    const rn = rowEl.attrs.r ? Number(rowEl.attrs.r) : rowAuto + 1;
    rowAuto = rn;
    let colAuto = 0;
    for (const c of kids(rowEl, 'c')) {
      const a = c.attrs.r ? parseEndereco(c.attrs.r) : { row: rn, col: colAuto + 1 };
      if (!a) continue;
      colAuto = a.col;
      const t = c.attrs.t ?? 'n';
      const vEl = kids(c, 'v')[0];
      const fEl = kids(c, 'f')[0];
      const isEl = kids(c, 'is')[0];
      const raw = vEl ? textOf(vEl) : undefined;
      let valor = null;
      if (t === 's') valor = raw !== undefined ? (shared[Number(raw)] ?? '') : null;
      else if (t === 'inlineStr') valor = isEl ? findAll(isEl, 't').map(textOf).join('') : '';
      else if (t === 'str' || t === 'e') valor = raw ?? null;
      else if (t === 'b') valor = raw === undefined ? null : raw === '1';
      else valor = raw === undefined || raw === '' ? null : Number(raw);
      const cell = { row: a.row, col: a.col, tipo: t, valor, el: c, rowEl };
      if (typeof valor === 'number' && datas.has(Number(c.attrs.s ?? 0))) cell.data = serialParaIso(valor);
      if (fEl) {
        const txt = textOf(fEl);
        cell.fEl = fEl;
        if (fEl.attrs.t === 'shared') {
          if (txt) mestres.set(fEl.attrs.si, { formula: txt, row: a.row, col: a.col });
          else pendentes.push([cell, fEl.attrs.si]);
        }
        if (txt) cell.formula = txt;
      }
      cells.set(chave(a.row, a.col), cell);
    }
  }
  for (const [cell, si] of pendentes) {
    const m = mestres.get(si);
    if (m) cell.formula = deslocar(m.formula, cell.row - m.row, cell.col - m.col);
  }
  return { doc, sheetData, cells };
}

// ------------------------------------------------------------------------------------------------
// CSV
// ------------------------------------------------------------------------------------------------

export function decodificarTexto(buf) {
  try {
    return { texto: new TextDecoder('utf-8', { fatal: true }).decode(buf), codificacao: 'utf8' };
  } catch {
    return { texto: buf.toString('latin1'), codificacao: 'latin1' };
  }
}

export function detectarSeparador(texto) {
  const amostra = texto.split(/\r?\n/).slice(0, 20).join('\n');
  let melhor = ',';
  let max = -1;
  for (const d of [';', ',', '\t', '|']) {
    const n = amostra.split(d).length;
    if (n > max) {
      max = n;
      melhor = d;
    }
  }
  return melhor;
}

/** Campos com posição no texto: [{linha, campos:[{valor, start, end}], start, end}]. */
export function parseCsv(texto, sep) {
  const linhas = [];
  let i = texto.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i <= texto.length) {
    const ini = i;
    const campos = [];
    for (;;) {
      const fs = i;
      let valor = '';
      if (texto[i] === '"') {
        i++;
        for (;;) {
          if (i >= texto.length) break;
          if (texto[i] === '"') {
            if (texto[i + 1] === '"') {
              valor += '"';
              i += 2;
              continue;
            }
            i++;
            break;
          }
          valor += texto[i++];
        }
        while (i < texto.length && texto[i] !== sep && texto[i] !== '\n' && texto[i] !== '\r') valor += texto[i++];
      } else {
        while (i < texto.length && texto[i] !== sep && texto[i] !== '\n' && texto[i] !== '\r') valor += texto[i++];
      }
      campos.push({ valor, start: fs, end: i });
      if (texto[i] === sep) {
        i++;
        continue;
      }
      break;
    }
    const fim = i;
    if (texto[i] === '\r') i++;
    if (texto[i] === '\n') i++;
    if (!(fim === ini && i === ini && ini >= texto.length)) linhas.push({ campos, start: ini, end: fim });
    if (i === ini || i >= texto.length) break;
  }
  return linhas;
}

export function lerCsv(buf, nome) {
  const { texto, codificacao } = decodificarTexto(buf);
  const sep = detectarSeparador(texto);
  const linhas = parseCsv(texto, sep);
  const cells = new Map();
  linhas.forEach((l, ri) => {
    l.campos.forEach((c, ci) => {
      const bruto = c.valor;
      if (bruto.trim() === '') return;
      const n = parseNumero(bruto, sep !== ',');
      const cell = { row: ri + 1, col: ci + 1, tipo: n === undefined ? 's' : 'n', valor: n === undefined ? bruto : n, bruto };
      if (/^=/.test(bruto.trim()) && bruto.trim().length > 1) {
        cell.formula = bruto.trim().slice(1);
        cell.valor = null;
      }
      cells.set(chave(ri + 1, ci + 1), cell);
    });
  });
  return { tipo: 'csv', texto, codificacao, separador: sep, linhas, planilhas: [{ nome, cells }] };
}

/** Planilha pelo nome (sem diferenciar maiúsculas) ou a primeira. */
export function acharPlanilha(wb, nome) {
  if (!nome) return wb.planilhas[0];
  return wb.planilhas.find((p) => p.nome === nome) ?? wb.planilhas.find((p) => p.nome.toLowerCase() === String(nome).toLowerCase());
}

export function dimensao(cells) {
  let r = 0;
  let c = 0;
  for (const x of cells.values()) {
    r = Math.max(r, x.row);
    c = Math.max(c, x.col);
  }
  return r && c ? `A1:${endereco(c, r)}` : '';
}

export { colNum };
