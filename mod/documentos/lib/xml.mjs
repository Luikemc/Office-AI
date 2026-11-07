// Parser de XML mínimo, com as posições de cada elemento no texto original (para trocar só um pedaço e deixar o
// resto do arquivo byte a byte). Sem DTD; suficiente para os XML do Office.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decode(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] ?? m;
  });
}

export function encode(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Árvore: {name, attrs, children, start, end, innerStart, innerEnd, parent}. Texto vai como {text, start, end}.
 * `start`/`end` cobrem a tag inteira (abertura até o fim do fechamento).
 */
export function parseXml(src) {
  const root = { name: '#root', attrs: {}, children: [], start: 0, end: src.length, innerStart: 0, innerEnd: src.length };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m.index > last) top.children.push({ text: decode(src.slice(last, m.index)), start: last, end: m.index });
    last = re.lastIndex;
    if (m[1] !== undefined) top.children.push({ text: m[1], start: m.index, end: last });
    else if (m[2]) {
      // fechamento: desempilha até o elemento com esse nome (tolerante a XML levemente torto)
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === m[2]) {
          for (let j = stack.length - 1; j >= i; j--) {
            stack[j].innerEnd = j === i ? m.index : stack[j].innerEnd ?? m.index;
            stack[j].end = j === i ? last : stack[j].end ?? m.index;
          }
          stack.length = i;
          break;
        }
      }
    } else if (m[3]) {
      const attrs = {};
      for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3] ?? '');
      const el = { name: m[3], attrs, children: [], start: m.index, parent: top, innerStart: last };
      top.children.push(el);
      if (m[5]) {
        el.end = last;
        el.innerEnd = last;
      } else stack.push(el);
    }
  }
  return root;
}

/** Nome sem prefixo (w:p → p). */
export const local = (name) => name.slice(name.indexOf(':') + 1);

export function* walk(el) {
  for (const c of el.children ?? []) {
    if (c.name) {
      yield c;
      yield* walk(c);
    }
  }
}

export function find(el, lname) {
  for (const c of walk(el)) if (local(c.name) === lname) return c;
  return undefined;
}

export function findAll(el, lname) {
  const out = [];
  for (const c of walk(el)) if (local(c.name) === lname) out.push(c);
  return out;
}

export function kids(el, lname) {
  return (el.children ?? []).filter((c) => c.name && (!lname || local(c.name) === lname));
}

/** Texto de todos os nós de texto abaixo do elemento. */
export function textOf(el) {
  let s = '';
  for (const c of el.children ?? []) s += c.name ? textOf(c) : c.text;
  return s;
}

/** Aplica trocas [{start, end, text}] (sem sobreposição) no texto original. */
export function splice(src, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
