// Fórmulas simples do Excel avaliadas em código: SUM e + - * / sobre números, células e intervalos (também de outra
// planilha: Plan2!B3, 'Minha planilha'!A1:A9). Qualquer outra coisa lança NaoConferida.

export class NaoConferida extends Error {}

export function colNum(letras) {
  let n = 0;
  for (const ch of letras.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function colLetras(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** "B7" → {col: 2, row: 7}; undefined se não for endereço. */
export function parseEndereco(a) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(a).trim());
  return m ? { col: colNum(m[1]), row: Number(m[2]) } : undefined;
}

export const endereco = (col, row) => `${colLetras(col)}${row}`;

const RE_TOKEN =
  /\s+|(?<ref>(?:(?:'(?<sq>(?:[^']|'')+)'|(?<sn>[A-Za-z_À-ɏ][\w.À-ɏ]*))!)?(?<c1a>\$?)(?<c1>[A-Za-z]{1,3})(?<r1a>\$?)(?<r1>\d+)(?::(?<c2a>\$?)(?<c2>[A-Za-z]{1,3})(?<r2a>\$?)(?<r2>\d+))?)(?![\w(])|(?<num>\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)|(?<fn>[A-Za-z_][\w.]*)\s*\(|(?<str>"(?:[^"]|"")*")|(?<op>[-+*/^&%(),;:<>=])|(?<outro>.)/gy;

export function tokenizar(f) {
  const out = [];
  RE_TOKEN.lastIndex = 0;
  let m;
  while (RE_TOKEN.lastIndex < f.length && (m = RE_TOKEN.exec(f))) {
    const g = m.groups;
    const pos = m.index;
    const len = m[0].length;
    if (g.ref) {
      out.push({
        t: 'ref',
        pos,
        len,
        sheet: g.sq !== undefined ? g.sq.replace(/''/g, "'") : g.sn,
        sheetRaw: g.sq !== undefined ? `'${g.sq}'` : g.sn,
        a: { col: colNum(g.c1), row: Number(g.r1), colAbs: !!g.c1a, rowAbs: !!g.r1a },
        b: g.c2 ? { col: colNum(g.c2), row: Number(g.r2), colAbs: !!g.c2a, rowAbs: !!g.r2a } : undefined,
      });
    } else if (g.num) out.push({ t: 'num', v: Number(g.num), pos, len });
    else if (g.fn) out.push({ t: 'fn', name: g.fn.toUpperCase(), pos, len });
    else if (g.str) out.push({ t: 'str', v: g.str.slice(1, -1).replace(/""/g, '"'), pos, len });
    else if (g.op) out.push({ t: 'op', v: g.op, pos, len });
    else if (g.outro) out.push({ t: 'outro', v: g.outro, pos, len });
  }
  return out;
}

/** Desloca as referências relativas (fórmula compartilhada do xlsx). */
export function deslocar(f, dr, dc) {
  if (!dr && !dc) return f;
  const toks = tokenizar(f).filter((t) => t.t === 'ref');
  let out = f;
  for (const t of toks.reverse()) {
    const p = (r) => `${r.colAbs ? '$' : ''}${colLetras(r.colAbs ? r.col : r.col + dc)}${r.rowAbs ? '$' : ''}${r.rowAbs ? r.row : r.row + dr}`;
    const txt = `${t.sheetRaw ? t.sheetRaw + '!' : ''}${p(t.a)}${t.b ? ':' + p(t.b) : ''}`;
    out = out.slice(0, t.pos) + txt + out.slice(t.pos + t.len);
  }
  return out;
}

/** Árvore da fórmula (sem o "="). */
export function parseFormula(f) {
  const toks = tokenizar(f.replace(/^=/, ''));
  let i = 0;
  const peek = () => toks[i];
  const isOp = (v) => peek()?.t === 'op' && peek().v === v;
  const expr = () => {
    let n = termo();
    while (isOp('+') || isOp('-')) {
      const op = toks[i++].v;
      n = { k: 'bin', op, a: n, b: termo() };
    }
    return n;
  };
  const termo = () => {
    let n = unario();
    while (isOp('*') || isOp('/')) {
      const op = toks[i++].v;
      n = { k: 'bin', op, a: n, b: unario() };
    }
    return n;
  };
  const unario = () => {
    if (isOp('-')) {
      i++;
      return { k: 'neg', a: unario() };
    }
    if (isOp('+')) {
      i++;
      return unario();
    }
    return primario();
  };
  const primario = () => {
    const t = toks[i++];
    if (!t) throw new NaoConferida('fórmula incompleta');
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'ref') return { k: 'ref', sheet: t.sheet, a: t.a, b: t.b };
    if (t.t === 'op' && t.v === '(') {
      const n = expr();
      if (!isOp(')')) throw new NaoConferida('parênteses');
      i++;
      return n;
    }
    if (t.t === 'fn') {
      if (t.name !== 'SUM' && t.name !== '_XLFN.SUM') throw new NaoConferida(`função ${t.name}`);
      const args = [];
      if (!isOp(')')) {
        for (;;) {
          args.push(expr());
          if (isOp(',') || isOp(';')) {
            i++;
            continue;
          }
          break;
        }
      }
      if (!isOp(')')) throw new NaoConferida('parênteses');
      i++;
      return { k: 'sum', args };
    }
    throw new NaoConferida(`"${t.v ?? t.name ?? t.t}"`);
  };
  const n = expr();
  if (i < toks.length) throw new NaoConferida(`operador "${toks[i].v ?? toks[i].t}"`);
  return n;
}

/** Endereços (com planilha) que a fórmula lê. */
export function referencias(ast, sheetAtual, out = []) {
  if (!ast) return out;
  if (ast.k === 'ref') {
    const b = ast.b ?? ast.a;
    for (let r = Math.min(ast.a.row, b.row); r <= Math.max(ast.a.row, b.row); r++)
      for (let c = Math.min(ast.a.col, b.col); c <= Math.max(ast.a.col, b.col); c++) out.push({ sheet: ast.sheet ?? sheetAtual, row: r, col: c });
  }
  for (const x of [ast.a, ast.b].filter((y) => y && y.k)) referencias(x, sheetAtual, out);
  for (const x of ast.args ?? []) referencias(x, sheetAtual, out);
  return out;
}

const MAX_CELULAS_INTERVALO = 200_000;

/**
 * Avalia. `get(sheet, row, col)` devolve o valor da célula (número, texto, booleano ou null).
 * Como no Excel: dentro do SUM, texto e vazio são ignorados; fora dele, vazio = 0 e texto não é conferido.
 */
export function avaliar(ast, sheetAtual, get) {
  const ev = (n, dentroSum) => {
    switch (n.k) {
      case 'num':
        return n.v;
      case 'neg':
        return -num(ev(n.a, false));
      case 'bin': {
        const a = num(ev(n.a, false));
        const b = num(ev(n.b, false));
        if (n.op === '+') return a + b;
        if (n.op === '-') return a - b;
        if (n.op === '*') return a * b;
        if (b === 0) throw new NaoConferida('divisão por zero');
        return a / b;
      }
      case 'ref': {
        const sheet = n.sheet ?? sheetAtual;
        if (!n.b) {
          const v = get(sheet, n.a.row, n.a.col);
          if (dentroSum) return typeof v === 'number' ? v : 0;
          return v ?? 0;
        }
        if (!dentroSum) throw new NaoConferida('intervalo fora de SUM');
        const r0 = Math.min(n.a.row, n.b.row);
        const r1 = Math.max(n.a.row, n.b.row);
        const c0 = Math.min(n.a.col, n.b.col);
        const c1 = Math.max(n.a.col, n.b.col);
        if ((r1 - r0 + 1) * (c1 - c0 + 1) > MAX_CELULAS_INTERVALO) throw new NaoConferida('intervalo grande demais');
        let s = 0;
        for (let r = r0; r <= r1; r++)
          for (let c = c0; c <= c1; c++) {
            const v = get(sheet, r, c);
            if (typeof v === 'number') s += v;
          }
        return s;
      }
      case 'sum':
        return n.args.reduce((s, a) => s + num(ev(a, true)), 0);
      default:
        throw new NaoConferida('expressão');
    }
  };
  const num = (v) => {
    if (typeof v === 'number') return v;
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'boolean') return v ? 1 : 0;
    throw new NaoConferida(`texto em conta ("${String(v).slice(0, 30)}")`);
  };
  return num(ev(ast, false));
}
