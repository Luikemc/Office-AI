// Word (.docx): parágrafos (§n, contando só os do corpo) e tabelas (T1:L2:C3), com o texto de cada um.
import { openZip } from './zip.mjs';
import { encode, find, kids, local, parseXml, walk } from './xml.mjs';

/** Os w:t de um elemento, em ordem, sem descer em tabelas aninhadas. */
function runsDeTexto(el, out = []) {
  for (const c of el.children ?? []) {
    if (!c.name) continue;
    const n = local(c.name);
    if (n === 'tbl') continue;
    if (n === 't' && c.name.startsWith('w:')) out.push(c);
    else if (n === 'delText') continue; // texto apagado com controle de alterações
    else runsDeTexto(c, out);
  }
  return out;
}

const textoT = (t) => (t.children ?? []).map((c) => c.text ?? '').join('');

function textoParagrafo(p) {
  let s = '';
  const visitar = (el) => {
    for (const c of el.children ?? []) {
      if (!c.name) continue;
      const n = local(c.name);
      if (n === 't') s += textoT(c);
      else if (n === 'tab') s += '\t';
      else if (n === 'br' || n === 'cr') s += '\n';
      else if (n !== 'delText' && n !== 'tbl') visitar(c);
    }
  };
  visitar(p);
  return s;
}

export function lerDocx(buf) {
  const zip = openZip(buf);
  const xml = zip.text('word/document.xml');
  if (xml === undefined) throw new Error('docx sem word/document.xml');
  const doc = parseXml(xml);
  const body = find(doc, 'body');
  if (!body) throw new Error('docx sem corpo (w:body)');
  const paragrafos = [];
  const tabelas = [];
  const visitar = (el) => {
    for (const c of kids(el)) {
      const n = local(c.name);
      if (n === 'p') {
        const estilo = find(c, 'pStyle')?.attrs['w:val'];
        paragrafos.push({ indice: paragrafos.length + 1, local: `§${paragrafos.length + 1}`, texto: textoParagrafo(c), estilo, el: c });
      } else if (n === 'tbl') {
        const t = { indice: tabelas.length + 1, linhas: [], el: c };
        tabelas.push(t);
        kids(c, 'tr').forEach((tr) => {
          t.linhas.push(kids(tr, 'tc').map((tc) => ({ el: tc, paragrafos: [...walk(tc)].filter((x) => local(x.name) === 'p'), texto: kids(tc, 'p').map(textoParagrafo).join('\n') })));
        });
      } else if (n === 'sdt' || n === 'sdtContent' || n === 'customXml') visitar(c);
    }
  };
  visitar(body);
  return { tipo: 'docx', zip, xml, paragrafos, tabelas };
}

/** "§12" / "p12" / "paragrafo 12" → {paragrafo:12}; "T1:L2:C3" / "tabela 1 linha 2 coluna 3" → {tabela, linha, coluna}. */
export function parseLocalDocx(s) {
  const t = String(s).trim();
  let m = /^(?:§|p|par[áa]grafo)\s*(\d+)$/i.exec(t);
  if (m) return { paragrafo: Number(m[1]) };
  m = /^(?:t|tabela)\s*(\d+)\s*[:,]?\s*(?:l|linha)\s*(\d+)\s*[:,]?\s*(?:c|coluna)\s*(\d+)$/i.exec(t);
  if (m) return { tabela: Number(m[1]), linha: Number(m[2]), coluna: Number(m[3]) };
  return undefined;
}

/** Edições (start/end/text) que trocam `antigo` por `novo` no parágrafo (ou o texto todo, sem `antigo`). */
function editarParagrafo(xml, p, novo, antigo) {
  const ts = runsDeTexto(p);
  const tagT = (txt) => `<w:t xml:space="preserve">${encode(txt)}</w:t>`;
  if (!ts.length) {
    if (antigo) return { erro: `o texto "${antigo}" não está nesse parágrafo` };
    return { edits: [{ start: p.innerEnd, end: p.innerEnd, text: `<w:r>${tagT(novo)}</w:r>` }] };
  }
  const textos = ts.map(textoT);
  if (antigo === undefined || antigo === '') {
    return { edits: ts.map((t, i) => ({ start: t.start, end: t.end, text: tagT(i === 0 ? novo : '') })) };
  }
  const tudo = textos.join('');
  const pos = tudo.indexOf(antigo);
  if (pos < 0) return { erro: `o texto "${antigo}" não está nesse local (texto lá: "${tudo.slice(0, 120)}")` };
  if (tudo.indexOf(antigo, pos + 1) >= 0) return { erro: `o texto "${antigo}" aparece mais de uma vez nesse local; use um trecho maior` };
  const fimPos = pos + antigo.length;
  const edits = [];
  let off = 0;
  let colocado = false;
  ts.forEach((t, i) => {
    const a = off;
    const b = off + textos[i].length;
    off = b;
    if (!(a < fimPos && b > pos)) return; // este w:t não tem nada do trecho
    const antes = textos[i].slice(0, Math.max(0, pos - a));
    const depois = textos[i].slice(Math.max(0, fimPos - a));
    edits.push({ start: t.start, end: t.end, text: tagT(antes + (colocado ? '' : novo) + depois) });
    colocado = true;
  });
  return { edits };
}

/** Aplica as correções: devolve {xml novo, aplicadas, erros}. */
export function corrigirDocx(d, correcoes) {
  const edits = [];
  const aplicadas = [];
  const erros = [];
  const usados = new Set();
  for (const c of correcoes) {
    const loc = parseLocalDocx(c.local);
    if (!loc) {
      erros.push({ local: c.local, erro: 'local inválido: use §12 (parágrafo) ou T1:L2:C3 (tabela, linha, coluna)' });
      continue;
    }
    let alvos;
    if (loc.paragrafo) {
      const p = d.paragrafos[loc.paragrafo - 1];
      if (!p) {
        erros.push({ local: c.local, erro: `o documento tem ${d.paragrafos.length} parágrafos` });
        continue;
      }
      alvos = [p.el];
    } else {
      const cel = d.tabelas[loc.tabela - 1]?.linhas[loc.linha - 1]?.[loc.coluna - 1];
      if (!cel) {
        erros.push({ local: c.local, erro: 'essa célula de tabela não existe' });
        continue;
      }
      alvos = cel.paragrafos;
    }
    const chaveLocal = JSON.stringify(loc);
    if (usados.has(chaveLocal)) {
      erros.push({ local: c.local, erro: 'mais de uma correção no mesmo local: junte numa só' });
      continue;
    }
    usados.add(chaveLocal);
    const novo = String(c.novo_valor);
    let feito = false;
    let ultimoErro;
    if (c.texto_original) {
      for (const p of alvos) {
        const r = editarParagrafo(d.xml, p, novo, c.texto_original);
        if (r.erro) ultimoErro = r.erro;
        else {
          edits.push(...r.edits);
          feito = true;
          break;
        }
      }
    } else {
      alvos.forEach((p, i) => {
        const r = editarParagrafo(d.xml, p, i === 0 ? novo : '');
        if (!r.erro && (i === 0 || r.edits.some((e) => e.end > e.start))) edits.push(...r.edits.filter((e) => i === 0 || e.end > e.start));
      });
      feito = alvos.length > 0;
      if (!feito) ultimoErro = 'célula sem parágrafo';
    }
    if (feito) aplicadas.push({ local: c.local, novo_valor: novo, ...(c.texto_original ? { texto_original: c.texto_original } : {}) });
    else erros.push({ local: c.local, erro: ultimoErro });
  }
  let out = d.xml;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { xml: out, aplicadas, erros };
}
