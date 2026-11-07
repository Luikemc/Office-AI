// Texto de PDF por página. Primeiro o pdftotext (poppler), chamado com execFile (sem shell); sem ele, um extrator
// simples em JS (streams FlateDecode, operadores Tj/TJ/'/", fontes com codificação comum). Sem OCR.
import { execFile } from 'node:child_process';
import { inflateSync } from 'node:zlib';

const PDFTOTEXT_TIMEOUT = 60_000;

function pdftotext(file, bin) {
  return new Promise((resolve) => {
    execFile(bin, ['-layout', '-enc', 'UTF-8', file, '-'], { maxBuffer: 64 * 1024 * 1024, timeout: PDFTOTEXT_TIMEOUT, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) resolve({ erro: err.code === 'ENOENT' ? 'ausente' : String(stderr || err.message).trim().slice(0, 300) });
      else resolve({ texto: stdout });
    });
  });
}

/**
 * {paginas: string[], extrator, aviso?}. `opts.pdftotext` = caminho do binário ('' desliga; padrão
 * DOCUMENTOS_PDFTOTEXT ou "pdftotext" do PATH).
 */
export async function lerPdf(file, buf, opts = {}) {
  const bin = opts.pdftotext ?? process.env.DOCUMENTOS_PDFTOTEXT ?? 'pdftotext';
  let aviso;
  if (bin) {
    const r = await pdftotext(file, bin);
    if (r.texto !== undefined) {
      const paginas = r.texto.split('\f');
      if (paginas.length > 1 && paginas[paginas.length - 1].trim() === '') paginas.pop();
      return { paginas, extrator: 'pdftotext' };
    }
    aviso =
      r.erro === 'ausente'
        ? 'pdftotext (poppler-utils) não encontrado: usei o extrator simples embutido, que pode falhar com fontes especiais. Instale poppler-utils para uma leitura melhor.'
        : `pdftotext falhou (${r.erro}); usei o extrator simples embutido.`;
  }
  try {
    const paginas = extrairSimples(buf);
    if (paginas.length && paginas.every((p) => !p.trim()) && /\/Font\b/.test(buf.toString('latin1')))
      aviso = `${aviso ? aviso + ' ' : ''}O PDF tem fontes, mas o extrator embutido não decodificou o texto: com o pdftotext (poppler-utils) instalado ele pode ser lido.`;
    return { paginas, extrator: 'embutido', aviso };
  } catch (e) {
    return { paginas: [], extrator: 'embutido', aviso: `${aviso ? aviso + ' ' : ''}O extrator embutido não conseguiu ler este PDF: ${e.message}` };
  }
}

// ------------------------------------------------------------------------------------------------
// Extrator embutido
// ------------------------------------------------------------------------------------------------

function objetos(src, buf) {
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(src))) {
    const ini = re.lastIndex;
    const fim = src.indexOf('endobj', ini);
    if (fim < 0) break;
    let corpo = src.slice(ini, fim);
    const s = corpo.indexOf('stream');
    let stream;
    if (s >= 0 && /^stream\r?\n/.test(corpo.slice(s))) {
      const dict = corpo.slice(0, s);
      const dataIni = ini + s + (corpo[s + 6] === '\r' ? 8 : 7);
      const lenM = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      let dataFim = src.lastIndexOf('endstream', fim);
      if (lenM && dataIni + Number(lenM[1]) <= dataFim) dataFim = dataIni + Number(lenM[1]);
      stream = buf.subarray(dataIni, dataFim);
      corpo = dict;
    }
    objs.set(Number(m[1]), { dict: corpo, stream });
    re.lastIndex = fim + 6;
  }
  return objs;
}

function decodificar(obj) {
  if (!obj?.stream) return undefined;
  if (/\/Filter\s*\[?\s*\/FlateDecode/.test(obj.dict)) {
    try {
      return inflateSync(obj.stream);
    } catch {
      return undefined;
    }
  }
  if (/\/Filter/.test(obj.dict)) return undefined; // outro filtro (DCT, LZW…): não é texto que dê para ler aqui
  return obj.stream;
}

/** Objetos dentro de /ObjStm (PDF 1.5+). */
function objetosComprimidos(objs) {
  for (const o of [...objs.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict)) continue;
    const data = decodificar(o);
    if (!data) continue;
    const n = Number(/\/N\s+(\d+)/.exec(o.dict)?.[1] ?? 0);
    const first = Number(/\/First\s+(\d+)/.exec(o.dict)?.[1] ?? 0);
    const txt = data.toString('latin1');
    const nums = txt.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const id = nums[i * 2];
      const ini = first + nums[i * 2 + 1];
      const fim = i + 1 < n ? first + nums[i * 2 + 3] : txt.length;
      if (!objs.has(id)) objs.set(id, { dict: txt.slice(ini, fim) });
    }
  }
}

const ref = (s, chave) => {
  const m = new RegExp(`/${chave}\\s+(\\d+)\\s+\\d+\\s+R`).exec(s);
  return m ? Number(m[1]) : undefined;
};

function paginasEmOrdem(objs, src) {
  const raiz = ref(/trailer[\s\S]*$/.exec(src)?.[0] ?? '', 'Root') ?? [...objs.entries()].find(([, o]) => /\/Type\s*\/Catalog/.test(o.dict))?.[0];
  const out = [];
  const visitar = (id, prof) => {
    const o = objs.get(id);
    if (!o || prof > 50) return;
    if (/\/Type\s*\/Pages\b/.test(o.dict)) {
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(o.dict)?.[1] ?? '';
      for (const k of kids.matchAll(/(\d+)\s+\d+\s+R/g)) visitar(Number(k[1]), prof + 1);
    } else if (/\/Type\s*\/Page\b/.test(o.dict)) out.push(o);
  };
  const cat = raiz !== undefined ? objs.get(raiz) : undefined;
  const pages = cat ? ref(cat.dict, 'Pages') : undefined;
  if (pages !== undefined) visitar(pages, 0);
  if (!out.length) for (const o of objs.values()) if (/\/Type\s*\/Page\b/.test(o.dict)) out.push(o);
  return out;
}

function conteudo(objs, pagina) {
  const arr = /\/Contents\s*\[([^\]]*)\]/.exec(pagina.dict)?.[1];
  const ids = arr ? [...arr.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1])) : [ref(pagina.dict, 'Contents')].filter((x) => x !== undefined);
  return ids.map((id) => decodificar(objs.get(id))?.toString('latin1') ?? '').join('\n');
}

function stringLiteral(s, i) {
  // s[i] === '('
  let out = '';
  let prof = 1;
  i++;
  while (i < s.length && prof > 0) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      const esc = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[n];
      if (esc !== undefined) {
        out += esc;
        i += 2;
      } else if (/[0-7]/.test(n)) {
        const o = /^[0-7]{1,3}/.exec(s.slice(i + 1))[0];
        out += String.fromCharCode(parseInt(o, 8));
        i += 1 + o.length;
      } else if (n === '\n' || n === '\r') i += n === '\r' && s[i + 2] === '\n' ? 3 : 2;
      else i += 2;
      continue;
    }
    if (c === '(') prof++;
    if (c === ')' && --prof === 0) break;
    out += c;
    i++;
  }
  return [out, i + 1];
}

/** Texto de um content stream: uma linha nova a cada mudança de linha (Td/TD com y, T*, ', ", ET). */
function textoDoStream(s, fontes = new Map()) {
  let dec = (x) => x;
  let out = '';
  let linha = '';
  const fecharLinha = () => {
    if (linha.trim()) out += linha.replace(/\s+$/, '') + '\n';
    linha = '';
  };
  const operandos = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '(') {
      const [str, j] = stringLiteral(s, i);
      operandos.push({ str: dec(str) });
      i = j;
    } else if (c === '<' && s[i + 1] !== '<') {
      const j = s.indexOf('>', i);
      const hex = s.slice(i + 1, j).replace(/\s+/g, '');
      let str = '';
      for (let k = 0; k < hex.length; k += 2) str += String.fromCharCode(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16));
      operandos.push({ str: dec(str) });
      i = j + 1;
    } else if (c === '[') {
      operandos.push({ arr: true });
      i++;
    } else if (c === ']') {
      // junta as strings do array (TJ); números grandes negativos viram espaço
      const partes = [];
      while (operandos.length && !operandos[operandos.length - 1].arr) partes.unshift(operandos.pop());
      operandos.pop();
      let str = '';
      for (const p of partes) {
        if (p.str !== undefined) str += p.str;
        else if (p.num !== undefined && p.num < -200) str += ' ';
      }
      operandos.push({ str });
      i++;
    } else if (c === '%') {
      const j = s.indexOf('\n', i);
      i = j < 0 ? s.length : j;
    } else if (/\s/.test(c)) i++;
    else {
      const m = /^[^\s()<>[\]{}/%]+|^\/[^\s()<>[\]{}/%]*|^[{}]|^<<|^>>/.exec(s.slice(i, i + 64));
      const tok = m ? m[0] : c;
      i += tok.length;
      if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
        operandos.push({ num: Number(tok) });
        continue;
      }
      if (tok[0] === '/' || tok === '<<' || tok === '>>' || tok === '{' || tok === '}') {
        operandos.push({ nome: tok });
        continue;
      }
      const ultimaStr = () => [...operandos].reverse().find((o) => o.str !== undefined)?.str ?? '';
      switch (tok) {
        case 'Tj':
        case 'TJ':
          linha += ultimaStr();
          break;
        case "'":
        case '"':
          fecharLinha();
          linha += ultimaStr();
          break;
        case 'Td':
        case 'TD': {
          const ty = operandos[operandos.length - 1]?.num ?? 0;
          if (Math.abs(ty) > 0.01) fecharLinha();
          else if (linha && !linha.endsWith(' ')) linha += ' ';
          break;
        }
        case 'T*':
        case 'ET':
          fecharLinha();
          break;
        case 'Tf': {
          const nome = operandos.find((o) => o.nome)?.nome.slice(1);
          dec = (nome && fontes.get(nome)) || ((x) => x);
          break;
        }
        case 'Tm':
          fecharLinha();
          break;
        default:
          break;
      }
      operandos.length = 0;
    }
  }
  fecharLinha();
  return out;
}

export function extrairSimples(buf) {
  const src = buf.toString('latin1');
  if (!src.startsWith('%PDF')) throw new Error('não começa com %PDF');
  if (/\/Encrypt\s/.test(src)) throw new Error('PDF protegido (criptografado)');
  const objs = objetos(src, buf);
  objetosComprimidos(objs);
  return paginasEmOrdem(objs, src).map((p) => {
    const t = textoDoStream(conteudo(objs, p), fontesDaPagina(objs, p));
    // Fonte sem ToUnicode e com codificação própria: sai lixo (caracteres de controle). Melhor nada do que lixo.
    const ruins = (t.match(/[\u0000-\u0008\u000b\u000e-\u001f\ufffd]/g) ?? []).length;
    return ruins > Math.max(3, t.length * 0.05) ? '' : t;
  });
}

/** Texto de um dicionário << ... >> que começa em `i` (balanceado). */
function dictEm(s, i) {
  let prof = 0;
  for (let k = i; k < s.length - 1; k++) {
    if (s[k] === '<' && s[k + 1] === '<') {
      prof++;
      k++;
    } else if (s[k] === '>' && s[k + 1] === '>') {
      prof--;
      k++;
      if (prof === 0) return s.slice(i, k + 1);
    }
  }
  return s.slice(i);
}

/** Valor de uma chave: dicionário embutido ou referência a outro objeto. */
function valorDict(objs, dict, chave) {
  const m = new RegExp(`/${chave}\\s*(<<|(\\d+)\\s+\\d+\\s+R)`).exec(dict);
  if (!m) return undefined;
  if (m[1] === '<<') return dictEm(dict, m.index + m[0].length - 2);
  return objs.get(Number(m[2]))?.dict;
}

/** Fontes da página (com herança de /Resources do /Pages) → decodificador pelo /ToUnicode. */
function fontesDaPagina(objs, pagina) {
  let res;
  for (let o = pagina, prof = 0; o && prof < 20 && !res; prof++) {
    res = valorDict(objs, o.dict, 'Resources');
    const pai = ref(o.dict, 'Parent');
    o = pai !== undefined ? objs.get(pai) : undefined;
  }
  const out = new Map();
  const fontDict = res ? valorDict(objs, res, 'Font') : undefined;
  if (!fontDict) return out;
  for (const m of fontDict.slice(2).matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
    const fonte = objs.get(Number(m[2]));
    const tu = fonte ? ref(fonte.dict, 'ToUnicode') : undefined;
    const cmap = tu !== undefined ? decodificar(objs.get(tu)) : undefined;
    if (cmap) out.set(m[1], decodificadorCMap(cmap.toString('latin1')));
  }
  return out;
}

function utf16(hex) {
  let s = '';
  for (let k = 0; k + 4 <= hex.length; k += 4) s += String.fromCharCode(parseInt(hex.slice(k, k + 4), 16));
  if (hex.length === 2) s = String.fromCharCode(parseInt(hex, 16));
  return s;
}

function decodificadorCMap(txt) {
  const mapa = new Map();
  let bytes = 1;
  const cs = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(txt);
  if (cs) bytes = Math.max(1, cs[1].length / 2);
  for (const bloco of txt.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const m of bloco[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) mapa.set(parseInt(m[1], 16), utf16(m[2]));
  for (const bloco of txt.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of bloco[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = Math.min(parseInt(m[2], 16), lo + 65535);
      if (m[3] !== undefined) {
        const base = parseInt(m[3].slice(-4), 16);
        const prefixo = utf16(m[3].slice(0, -4));
        for (let c = lo; c <= hi; c++) mapa.set(c, prefixo + String.fromCharCode(base + (c - lo)));
      } else {
        const lista = [...m[4].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16(x[1]));
        lista.forEach((u, k) => mapa.set(lo + k, u));
      }
    }
  }
  return (raw) => {
    let s = '';
    for (let k = 0; k + bytes <= raw.length; k += bytes) {
      let code = 0;
      for (let b = 0; b < bytes; b++) code = code * 256 + raw.charCodeAt(k + b);
      s += mapa.get(code) ?? (bytes === 1 ? raw[k] : '\ufffd');
    }
    return s;
  };
}
