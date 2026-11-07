// Caminhos: só dentro da pasta do projeto (o cwd do servidor MCP, que o Claude Code abre na pasta da sessão).
// Nada de "..", nem link simbólico que aponte para fora. A correção vai sempre para um arquivo novo.
import { closeSync, openSync, realpathSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export class ErroCaminho extends Error {}

const dentro = (raiz, p) => {
  const r = relative(raiz, p);
  return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r));
};

/** Raiz real (sem links) da pasta permitida. */
export function raizDe(raiz) {
  return realpathSync(resolve(raiz));
}

/** Resolve `caminho` (relativo à raiz, ou absoluto dentro dela) para o arquivo real; lança ErroCaminho. */
export function resolverArquivo(raiz, caminho, maxBytes) {
  if (typeof caminho !== 'string' || !caminho.trim()) throw new ErroCaminho('informe o caminho do arquivo');
  if (caminho.includes('\0')) throw new ErroCaminho('caminho inválido');
  const root = raizDe(raiz);
  const pedido = resolve(root, caminho);
  if (!dentro(root, pedido)) throw new ErroCaminho(`só arquivos dentro da pasta do projeto (${root})`);
  let real;
  try {
    real = realpathSync(pedido);
  } catch {
    throw new ErroCaminho(`arquivo não encontrado: ${caminho}`);
  }
  if (!dentro(root, real)) throw new ErroCaminho('o caminho é um link que aponta para fora da pasta do projeto');
  const st = statSync(real);
  if (!st.isFile()) throw new ErroCaminho(`não é um arquivo: ${caminho}`);
  if (maxBytes && st.size > maxBytes) throw new ErroCaminho(`arquivo grande demais (${Math.round(st.size / 1048576)} MB; limite ${Math.round(maxBytes / 1048576)} MB)`);
  return { real, relativo: relative(root, real) || basename(real), root, tamanho: st.size };
}

/**
 * Grava `dados` em `<nome>-corrigido.<ext>` ao lado do original (ou -corrigido-2, -3…). Abre com "wx": nunca
 * sobrescreve nada que exista (nem link). Devolve o caminho gravado.
 */
export function gravarCorrigido(original, dados, extNova) {
  const dir = dirname(original);
  const ext = extNova ?? extname(original);
  const base = basename(original, extname(original));
  for (let n = 1; n < 1000; n++) {
    const alvo = join(dir, `${base}-corrigido${n === 1 ? '' : `-${n}`}${ext}`);
    if (alvo === original) continue;
    let fd;
    try {
      fd = openSync(alvo, 'wx', 0o644);
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    try {
      const buf = Buffer.isBuffer(dados) ? dados : Buffer.from(dados);
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    } finally {
      closeSync(fd);
    }
    return alvo;
  }
  throw new Error('não achei um nome livre para o arquivo corrigido');
}
