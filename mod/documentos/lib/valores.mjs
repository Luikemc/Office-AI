// Padrões que interessam num documento brasileiro: valores em reais, datas, CPF/CNPJ, linha digitável e código de
// barras. Cada achado vem com o trecho (a linha onde apareceu) para o modelo citar a origem.

/** "1.234,56" / "R$ 1.234,56" / "-12,5" / "1234.56" → número; undefined se não parecer número. */
export function parseNumero(s, prefereBR = true) {
  if (typeof s === 'number') return Number.isFinite(s) ? s : undefined;
  if (typeof s !== 'string') return undefined;
  let t = s.trim().replace(/^R\$\s*/i, '').replace(/\s+/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(t)) {
    neg = true;
    t = t.slice(1, -1);
  }
  if (t.startsWith('-')) {
    neg = !neg;
    t = t.slice(1);
  } else if (t.endsWith('-')) {
    neg = !neg;
    t = t.slice(0, -1);
  }
  t = t.replace(/^R\$/i, '');
  let n;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t) || /^\d+,\d+$/.test(t)) n = Number(t.replace(/\./g, '').replace(',', '.'));
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) n = Number(t.replace(/,/g, ''));
  else if (/^\d+\.\d{3}$/.test(t) && prefereBR) n = Number(t.replace('.', ''));
  else if (/^\d+(\.\d+)?$/.test(t)) n = Number(t);
  else if (/^\d+(\.\d+)?e[+-]?\d+$/i.test(t)) n = Number(t);
  if (n === undefined || !Number.isFinite(n)) return undefined;
  return neg ? -n : n;
}

/** 1234.5 → "1.234,50" */
export function formatBRL(n) {
  const s = Math.abs(n).toFixed(2).split('.');
  return (n < 0 ? '-' : '') + s[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + s[1];
}

/** Arredonda para evitar 0.30000000000000004 nas respostas. */
export const round = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

/** A linha do texto que contém a posição, encurtada em volta do achado. */
export function trechoEm(text, index, len = 0, max = 140) {
  const ini = text.lastIndexOf('\n', index - 1) + 1;
  let fim = text.indexOf('\n', index + len);
  if (fim < 0) fim = text.length;
  let a = ini;
  let b = fim;
  if (b - a > max) {
    a = Math.max(ini, index - Math.floor((max - len) / 2));
    b = Math.min(fim, a + max);
  }
  const s = text.slice(a, b).replace(/\s+/g, ' ').trim();
  return (a > ini ? '…' : '') + s + (b < fim ? '…' : '');
}

/** Número da linha (1…) de uma posição no texto. */
export function linhaEm(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export function dataValida(d, m, y) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function dvCpf(nums) {
  const calc = (len) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += nums[i] * (len + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return [calc(9), calc(10)];
}

export function cpfValido(s) {
  const d = s.replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  const n = [...d].map(Number);
  const [a, b] = dvCpf(n);
  return a === n[9] && b === n[10];
}

export function cnpjValido(s) {
  const d = s.replace(/\D/g, '');
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const n = [...d].map(Number);
  const calc = (len) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let s = 0;
    for (let i = 0; i < len; i++) s += n[i] * w[i];
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === n[12] && calc(13) === n[13];
}

// Linha digitável de boleto bancário (47 dígitos, 5 campos) e de arrecadação/concessionária (48, 4 blocos de 11+1).
export const RE_LINHA_BANCARIA = /(?<!\d)\d{5}[.\s]?\d{5}\s+\d{5}[.\s]?\d{6}\s+\d{5}[.\s]?\d{6}\s+\d\s+\d{14}(?!\d)/g;
export const RE_LINHA_ARRECADACAO = /(?<!\d)8\d{10}[\s-]?\d\s+\d{11}[\s-]?\d\s+\d{11}[\s-]?\d\s+\d{11}[\s-]?\d(?!\d)/g;
/** Sequências de dígitos que podem ser linha digitável ou código de barras escritos sem formatação. */
export const RE_DIGITOS_LONGOS = /(?<![\d.])(?:\d[ .-]?){43,47}\d(?![\d.])/g;

const RE_DINHEIRO = /(R\$\s*)?-?(?<![\d.,])\d{1,3}(?:\.\d{3})*,\d{2}(?![\d,])|(R\$\s*)-?\d+(?:\.\d{2})?(?![\d,])/g;
const RE_DATA = /(?<!\d)(\d{2})\/(\d{2})\/(\d{4})(?!\d)/g;
const RE_CPF = /(?<![\d.])\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g;
const RE_CNPJ = /(?<![\d.])\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}(?!\d)/g;

/**
 * Acha valores num texto. `onde` é copiado para cada achado (ex.: {pagina: 2} ou {paragrafo: 7}).
 * Devolve listas: valores, datas, documentos (CPF/CNPJ), linhas_digitaveis.
 */
export function detectar(text, onde = {}, limite = 300) {
  const out = { valores: [], datas: [], documentos: [], linhas_digitaveis: [] };
  const push = (list, item) => {
    if (list.length < limite) list.push(item);
  };
  const base = (m) => ({ ...onde, linha: linhaEm(text, m.index), trecho: trechoEm(text, m.index, m[0].length) });
  for (const m of text.matchAll(RE_DINHEIRO)) {
    const v = parseNumero(m[0].replace(/^R\$\s*/, ''), true);
    if (v === undefined) continue;
    push(out.valores, { texto: m[0].trim(), valor: v, com_rs: /R\$/.test(m[0]), ...base(m) });
  }
  for (const m of text.matchAll(RE_DATA)) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!dataValida(d, mo, y)) continue;
    push(out.datas, { texto: m[0], iso: `${m[3]}-${m[2]}-${m[1]}`, ...base(m) });
  }
  for (const m of text.matchAll(RE_CPF)) push(out.documentos, { tipo: 'CPF', texto: m[0], valido: cpfValido(m[0]), ...base(m) });
  for (const m of text.matchAll(RE_CNPJ)) push(out.documentos, { tipo: 'CNPJ', texto: m[0], valido: cnpjValido(m[0]), ...base(m) });
  const vistos = new Set();
  for (const re of [RE_LINHA_BANCARIA, RE_LINHA_ARRECADACAO, RE_DIGITOS_LONGOS]) {
    for (const m of text.matchAll(re)) {
      const digitos = m[0].replace(/\D/g, '');
      if (![44, 47, 48].includes(digitos.length) || vistos.has(digitos)) continue;
      vistos.add(digitos);
      const tipo = digitos.length === 44 ? 'codigo_de_barras' : 'linha_digitavel';
      push(out.linhas_digitaveis, { tipo, texto: m[0].replace(/\s+/g, ' ').trim(), digitos, ...base(m) });
    }
  }
  return out;
}
