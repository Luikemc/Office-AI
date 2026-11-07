// Correções gravadas num arquivo novo: xlsx (valores de células, contas dependentes refeitas), csv e docx (texto).
import { writeZip } from './zip.mjs';
import { encode, find, kids, parseXml } from './xml.mjs';
import { avaliar, endereco, NaoConferida, parseFormula, tokenizar } from './formula.mjs';
import { acharPlanilha, chave, enderecoCompleto, lerCsv, lerXlsx, parseLocal } from './planilha.mjs';
import { corrigirDocx, lerDocx } from './docx.mjs';
import { dataValida, parseNumero } from './valores.mjs';

/** novo_valor → {tipo:'n'|'s'|'b'|'f', valor, formula?} */
function interpretar(v, ehData) {
  if (typeof v === 'number') return { tipo: 'n', valor: v };
  if (typeof v === 'boolean') return { tipo: 'b', valor: v };
  if (v === null || v === undefined) return { tipo: 'vazio', valor: null };
  const s = String(v);
  if (/^=./.test(s.trim())) return { tipo: 'f', formula: s.trim().slice(1), valor: null };
  const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
  if (d && ehData !== false && dataValida(Number(d[1]), Number(d[2]), Number(d[3]))) {
    const serial = (Date.UTC(Number(d[3]), Number(d[2]) - 1, Number(d[1])) - Date.UTC(1899, 11, 30)) / 86400000;
    return { tipo: 'n', valor: serial, data: true };
  }
  const n = parseNumero(s, true);
  if (n !== undefined) return { tipo: 'n', valor: n };
  return { tipo: 's', valor: s };
}

const vXml = (n) => `<v>${String(n)}</v>`;

// ------------------------------------------------------------------------------------------------
// XLSX
// ------------------------------------------------------------------------------------------------

export function corrigirXlsx(buf, correcoes) {
  const wb = lerXlsx(buf);
  const aplicadas = [];
  const erros = [];
  /** sheet → Map(chave → {cell, xmlNovo?}) */
  const mudancas = new Map();
  const marcar = (sheet, cell) => {
    if (!mudancas.has(sheet)) mudancas.set(sheet, new Map());
    mudancas.get(sheet).set(chave(cell.row, cell.col), cell);
  };
  const alteradas = [];
  for (const c of correcoes) {
    const loc = parseLocal(c.local);
    if (!loc) {
      erros.push({ local: c.local, erro: 'local inválido: use Plan1!B7 (ou só B7 para a primeira planilha)' });
      continue;
    }
    const sheet = acharPlanilha(wb, loc.sheet);
    if (!sheet) {
      erros.push({ local: c.local, erro: `planilha "${loc.sheet}" não existe (há: ${wb.planilhas.map((p) => p.nome).join(', ')})` });
      continue;
    }
    const k = chave(loc.row, loc.col);
    let cell = sheet.cells.get(k);
    const anterior = cell ? (cell.formula ? `=${cell.formula}` : cell.valor) : null;
    if (!cell) {
      cell = { row: loc.row, col: loc.col, tipo: 'n', valor: null, novo: true };
      sheet.cells.set(k, cell);
    }
    const iv = interpretar(c.novo_valor, cell.data !== undefined ? true : undefined);
    // Uma fórmula compartilhada mestre que vira valor: as seguidoras passam a ter a fórmula escrita por extenso.
    if (cell.fEl?.attrs.t === 'shared' && cell.fEl.attrs.ref) {
      for (const x of sheet.cells.values()) {
        if (x !== cell && x.fEl?.attrs.t === 'shared' && x.fEl.attrs.si === cell.fEl.attrs.si) {
          x.fExplicita = true;
          marcar(sheet, x);
        }
      }
    }
    cell.corrigida = true;
    cell.formula = iv.tipo === 'f' ? iv.formula : undefined;
    cell.fEl = undefined;
    cell.tipo = iv.tipo === 'f' ? 'n' : iv.tipo;
    cell.valor = iv.valor;
    marcar(sheet, cell);
    alteradas.push({ sheet: sheet.nome, row: loc.row, col: loc.col });
    aplicadas.push({ local: enderecoCompleto(sheet.nome, loc.row, loc.col), antes: anterior, depois: iv.tipo === 'f' ? `=${iv.formula}` : iv.valor });
  }
  if (!aplicadas.length) return { erros, aplicadas };

  // Contas que dependem das células trocadas: refeitas em código quando dá; senão o valor guardado sai.
  const porNome = new Map(wb.planilhas.map((p) => [p.nome.toLowerCase(), p]));
  const formulas = [];
  for (const p of wb.planilhas) for (const cell of p.cells.values()) if (cell.formula) formulas.push({ p, cell, refs: refsDe(cell.formula, p.nome) });
  const afetada = new Set();
  const sujas = new Set(alteradas.map((a) => `${a.sheet.toLowerCase()}|${a.row},${a.col}`));
  for (let mudou = true, voltas = 0; mudou && voltas < 100; voltas++) {
    mudou = false;
    for (const f of formulas) {
      const id = `${f.p.nome.toLowerCase()}|${f.cell.row},${f.cell.col}`;
      if (afetada.has(id)) continue;
      if (f.cell.corrigida || f.refs.some((r) => r.dentro(sujas))) {
        afetada.add(id);
        sujas.add(id);
        mudou = true;
      }
    }
  }
  const get = (sheet, row, col) => {
    const p = porNome.get(String(sheet).toLowerCase());
    if (!p) throw new NaoConferida('planilha');
    return p.cells.get(chave(row, col))?.valor ?? null;
  };
  const alvo = formulas.filter((f) => afetada.has(`${f.p.nome.toLowerCase()}|${f.cell.row},${f.cell.col}`));
  const recalculadas = [];
  const limpas = [];
  for (const f of alvo) f.ok = true;
  for (let volta = 0; volta < 50; volta++) {
    let mudou = false;
    for (const f of alvo) {
      try {
        const v = avaliar(parseFormula(f.cell.formula), f.p.nome, get);
        if (f.cell.valor !== v) {
          f.cell.valor = v;
          mudou = true;
        }
        f.ok = true;
      } catch (e) {
        if (!(e instanceof NaoConferida)) throw e;
        f.ok = false;
        f.cell.valor = null;
      }
    }
    if (!mudou) break;
  }
  for (const f of alvo) {
    f.cell.recalculada = f.ok;
    f.cell.limpa = !f.ok;
    marcar(f.p, f.cell);
    const end = enderecoCompleto(f.p.nome, f.cell.row, f.cell.col);
    if (f.ok) recalculadas.push({ celula: end, formula: `=${f.cell.formula}`, valor: f.cell.valor });
    else limpas.push(end);
  }

  // XML de cada planilha mexida.
  const replace = new Map();
  for (const [sheet, cellsMudadas] of mudancas) replace.set(sheet.parte, xmlPlanilha(sheet, cellsMudadas));
  replace.set('xl/workbook.xml', calcularAoAbrir(wb.wbXml));
  // calcChain lista as fórmulas na ordem de cálculo; com fórmula trocada por valor, o Excel pediria "reparar".
  if (wb.zip.has('xl/calcChain.xml')) {
    replace.set('xl/calcChain.xml', null);
    const rels = wb.zip.text('xl/_rels/workbook.xml.rels');
    if (rels) replace.set('xl/_rels/workbook.xml.rels', rels.replace(/<Relationship\b[^>]*Target="[^"]*calcChain\.xml"[^>]*\/>/g, ''));
    const ct = wb.zip.text('[Content_Types].xml');
    if (ct) replace.set('[Content_Types].xml', ct.replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, ''));
  }
  return {
    dados: writeZip(wb.zip.entries, replace),
    aplicadas,
    erros,
    recalculadas,
    ...(limpas.length ? { valores_apagados: limpas, aviso_valores_apagados: 'fórmulas que o servidor não sabe refazer e dependem do que mudou: o valor guardado saiu e o Excel/LibreOffice recalcula ao abrir' } : {}),
  };
}

function refsDe(formula, sheetAtual) {
  return tokenizar(formula)
    .filter((t) => t.t === 'ref')
    .map((t) => {
      const sh = (t.sheet ?? sheetAtual).toLowerCase();
      const b = t.b ?? t.a;
      const r0 = Math.min(t.a.row, b.row);
      const r1 = Math.max(t.a.row, b.row);
      const c0 = Math.min(t.a.col, b.col);
      const c1 = Math.max(t.a.col, b.col);
      return {
        dentro: (sujas) => {
          for (const s of sujas) {
            const [nome, rc] = s.split('|');
            if (nome !== sh) continue;
            const [r, c] = rc.split(',').map(Number);
            if (r >= r0 && r <= r1 && c >= c0 && c <= c1) return true;
          }
          return false;
        },
      };
    });
}

function cellXml(sheet, cell) {
  const attrs = [`r="${endereco(cell.col, cell.row)}"`];
  const s = cell.el?.attrs.s;
  if (s !== undefined) attrs.push(`s="${encode(s)}"`);
  const src = sheet.xml;
  if (cell.corrigida) {
    if (cell.formula !== undefined) {
      const v = typeof cell.valor === 'number' ? vXml(cell.valor) : '';
      return `<c ${attrs.join(' ')}><f>${encode(cell.formula)}</f>${v}</c>`;
    }
    if (cell.tipo === 'vazio' || cell.valor === null) return `<c ${attrs.join(' ')}/>`;
    if (cell.tipo === 'b') return `<c ${attrs.join(' ')} t="b">${vXml(cell.valor ? 1 : 0)}</c>`;
    if (cell.tipo === 's') return `<c ${attrs.join(' ')} t="inlineStr"><is><t xml:space="preserve">${encode(cell.valor)}</t></is></c>`;
    return `<c ${attrs.join(' ')}>${vXml(cell.valor)}</c>`;
  }
  // Fórmula mantida: o mesmo <f> (ou escrito por extenso), valor refeito ou apagado.
  const f = cell.fExplicita ? `<f>${encode(cell.formula ?? '')}</f>` : cell.fEl ? src.slice(cell.fEl.start, cell.fEl.end) : `<f>${encode(cell.formula ?? '')}</f>`;
  if (cell.limpa || typeof cell.valor !== 'number') {
    if (!cell.limpa && cell.valor !== null && cell.valor !== undefined && !cell.recalculada) {
      // seguidora reescrita sem recálculo: mantém o valor guardado como estava
      const t = cell.el?.attrs.t;
      const vEl = cell.el ? kids(cell.el, 'v')[0] : undefined;
      return `<c ${attrs.join(' ')}${t ? ` t="${encode(t)}"` : ''}>${f}${vEl ? src.slice(vEl.start, vEl.end) : ''}</c>`;
    }
    return `<c ${attrs.join(' ')}>${f}</c>`;
  }
  return `<c ${attrs.join(' ')}>${f}${vXml(cell.valor)}</c>`;
}

function xmlPlanilha(sheet, mudadas) {
  const src = sheet.xml;
  const edits = [];
  const porLinha = new Map();
  for (const cell of mudadas.values()) {
    if (!porLinha.has(cell.row)) porLinha.set(cell.row, []);
    porLinha.get(cell.row).push(cell);
  }
  const rowsEl = sheet.sheetData ? kids(sheet.sheetData, 'row') : [];
  const rowEl = new Map(rowsEl.map((r, i) => [r.attrs.r ? Number(r.attrs.r) : i + 1, r]));
  const novasLinhas = [];
  for (const [row, lista] of porLinha) {
    const r = rowEl.get(row);
    const temNova = lista.some((c) => !c.el);
    if (!temNova) {
      for (const c of lista) edits.push({ start: c.el.start, end: c.el.end, text: cellXml(sheet, c) });
      continue;
    }
    // Linha com célula nova: a linha inteira é refeita, com as células na ordem das colunas.
    const todas = [...sheet.cells.values()].filter((c) => c.row === row).sort((a, b) => a.col - b.col);
    const corpo = todas.map((c) => (mudadas.has(chave(c.row, c.col)) ? cellXml(sheet, c) : src.slice(c.el.start, c.el.end))).join('');
    if (r) {
      const abre = src.slice(r.start, r.innerStart).replace(/\s*\/>$/, '>').replace(/\s+spans="[^"]*"/, '');
      edits.push({ start: r.start, end: r.end, text: `${abre}${corpo}</row>` });
    } else novasLinhas.push({ row, xml: `<row r="${row}">${corpo}</row>` });
  }
  if (novasLinhas.length) {
    novasLinhas.sort((a, b) => a.row - b.row);
    const sd = sheet.sheetData;
    if (!sd) throw new Error('planilha sem sheetData');
    const grupos = new Map();
    for (const n of novasLinhas) {
      const depois = rowsEl.find((r) => Number(r.attrs.r) > n.row);
      const pos = depois ? depois.start : sd.innerEnd;
      grupos.set(pos, (grupos.get(pos) ?? '') + n.xml);
    }
    if (sd.innerStart === sd.end) {
      // <sheetData/>
      edits.push({ start: sd.start, end: sd.end, text: `<sheetData>${[...grupos.values()].join('')}</sheetData>` });
    } else for (const [pos, xml] of grupos) edits.push({ start: pos, end: pos, text: xml });
  }
  let out = src;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

function calcularAoAbrir(wbXml) {
  const doc = parseXml(wbXml);
  const calc = find(doc, 'calcPr');
  if (calc) {
    const tag = wbXml.slice(calc.start, calc.innerStart);
    const nova = /fullCalcOnLoad=/.test(tag) ? tag.replace(/fullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"') : tag.replace(/^<([\w:]+)/, '<$1 fullCalcOnLoad="1"');
    return wbXml.slice(0, calc.start) + nova + wbXml.slice(calc.innerStart);
  }
  const ancora = find(doc, 'definedNames') ?? find(doc, 'sheets');
  if (!ancora) return wbXml;
  const prefixo = /^(\w+):/.exec(ancora.name)?.[1];
  const tag = `<${prefixo ? prefixo + ':' : ''}calcPr fullCalcOnLoad="1"/>`;
  return wbXml.slice(0, ancora.end) + tag + wbXml.slice(ancora.end);
}

// ------------------------------------------------------------------------------------------------
// CSV
// ------------------------------------------------------------------------------------------------

function numeroComoNoArquivo(n, exemplo, sep) {
  const ex = (exemplo ?? '').trim();
  const br = /\d,\d+$/.test(ex) || (sep !== ',' && !/\d\.\d{1,2}$/.test(ex));
  const casasEx = br ? /,(\d+)$/.exec(ex)?.[1].length : /\.(\d+)$/.exec(ex)?.[1].length;
  const casas = casasEx ?? (Number.isInteger(n) ? 0 : 2);
  const prefixo = /^R\$/.test(ex) ? 'R$ ' : '';
  if (!br) return prefixo + n.toFixed(casas);
  const [int, dec] = Math.abs(n).toFixed(casas).split('.');
  const milhar = /\d\.\d{3}(,|$)/.test(ex) ? int.replace(/\B(?=(\d{3})+(?!\d))/g, '.') : int;
  return prefixo + (n < 0 ? '-' : '') + milhar + (dec ? ',' + dec : '');
}

export function corrigirCsv(buf, nome, correcoes) {
  const csv = lerCsv(buf, nome);
  const sep = csv.separador;
  const edits = [];
  const aplicadas = [];
  const erros = [];
  const usados = new Set();
  for (const c of correcoes) {
    const loc = parseLocal(c.local);
    if (!loc) {
      erros.push({ local: c.local, erro: 'local inválido: use o endereço da célula (B7 = linha 7, coluna 2)' });
      continue;
    }
    const k = chave(loc.row, loc.col);
    if (usados.has(k)) {
      erros.push({ local: c.local, erro: 'mais de uma correção na mesma célula' });
      continue;
    }
    usados.add(k);
    const linha = csv.linhas[loc.row - 1];
    if (!linha) {
      erros.push({ local: c.local, erro: `o arquivo tem ${csv.linhas.length} linhas` });
      continue;
    }
    const campo = linha.campos[loc.col - 1];
    const antigo = campo?.valor ?? '';
    let novo = typeof c.novo_valor === 'number' ? numeroComoNoArquivo(c.novo_valor, antigo, sep) : String(c.novo_valor ?? '');
    if (c.texto_original) {
      if (!antigo.includes(c.texto_original)) {
        erros.push({ local: c.local, erro: `o texto "${c.texto_original}" não está na célula (lá: "${antigo}")` });
        continue;
      }
      novo = antigo.replace(c.texto_original, novo);
    }
    const foiAspas = campo && csv.texto[campo.start] === '"';
    const precisa = foiAspas || novo.includes(sep) || /["\r\n]/.test(novo);
    const txt = precisa ? `"${novo.replace(/"/g, '""')}"` : novo;
    if (campo) edits.push({ start: campo.start, end: campo.end, text: txt });
    else edits.push({ start: linha.end, end: linha.end, text: sep.repeat(loc.col - linha.campos.length) + txt });
    aplicadas.push({ local: endereco(loc.col, loc.row), antes: antigo, depois: novo });
  }
  let out = csv.texto;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { dados: Buffer.from(out, csv.codificacao === 'latin1' ? 'latin1' : 'utf8'), aplicadas, erros };
}

// ------------------------------------------------------------------------------------------------
// DOCX
// ------------------------------------------------------------------------------------------------

export function corrigirDocxArquivo(buf, correcoes) {
  const d = lerDocx(buf);
  const r = corrigirDocx(d, correcoes);
  if (!r.aplicadas.length) return { aplicadas: [], erros: r.erros };
  return { dados: writeZip(d.zip.entries, new Map([['word/document.xml', r.xml]])), aplicadas: r.aplicadas, erros: r.erros };
}
