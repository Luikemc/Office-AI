// Texto de PDF, planilha e Word para colar no pedido do agente local. As ferramentas dele só leem a pasta do
// projeto; o anexo fica em ~/.habblaud/attachments, então o conteúdo tem que ir no próprio pedido.
import { basename, dirname, extname } from 'node:path';
import { tr } from '../../shared/i18n';
import { executar } from '../../mod/documentos/lib/index.mjs';

const DOC = new Set(['.pdf', '.xlsx', '.xlsm', '.csv', '.tsv', '.docx']);

export function isDocumentName(name: string): boolean {
  return DOC.has(extname(name).toLowerCase());
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/** Texto plano do resultado de ler_documento. */
export function formatDocument(r: Record<string, unknown>): string {
  if (r.sem_texto === true) return tr('PDF sem texto extraível (parece digitalizado).');
  const lines: string[] = [];
  const pages = r.texto_por_pagina;
  if (Array.isArray(pages)) {
    for (const p of pages) {
      if (!p || typeof p !== 'object') continue;
      const o = p as { pagina?: unknown; texto?: unknown };
      lines.push(`${asText(o.pagina)}\n${asText(o.texto)}`.trim());
    }
  }
  const paras = r.paragrafos;
  if (Array.isArray(paras)) {
    for (const p of paras) {
      if (p && typeof p === 'object') lines.push(asText((p as { texto?: unknown }).texto));
    }
  }
  const tables = r.tabelas;
  if (Array.isArray(tables)) {
    for (const t of tables) {
      if (!t || typeof t !== 'object') continue;
      const rows = (t as { linhas?: unknown }).linhas;
      if (!Array.isArray(rows)) continue;
      for (const row of rows) if (Array.isArray(row)) lines.push(row.map(asText).join('\t'));
    }
  }
  const sheets = r.planilhas;
  if (Array.isArray(sheets)) {
    for (const s of sheets) {
      if (!s || typeof s !== 'object') continue;
      const o = s as { nome?: unknown; celulas?: unknown };
      if (asText(o.nome)) lines.push(asText(o.nome));
      if (!Array.isArray(o.celulas)) continue;
      for (const c of o.celulas) {
        if (!c || typeof c !== 'object') continue;
        const cell = c as { celula?: unknown; valor?: unknown; formula?: unknown };
        lines.push([asText(cell.celula), asText(cell.valor), asText(cell.formula)].filter((x) => x !== '').join('\t'));
      }
    }
  }
  const csvLines = r.linhas;
  if (Array.isArray(csvLines)) {
    for (const l of csvLines) {
      if (l && typeof l === 'object' && Array.isArray((l as { valores?: unknown }).valores)) {
        lines.push((l as { valores: unknown[] }).valores.map(asText).join('\t'));
      }
    }
  }
  return lines.filter((l) => l.trim()).join('\n');
}

/** Lê um documento pelo caminho absoluto (a pasta dele é a raiz permitida). Erro vira uma frase, não uma exceção. */
export async function readDocumentText(path: string): Promise<string> {
  const name = basename(path);
  try {
    const r = await executar('ler_documento', { caminho: name }, dirname(path));
    const text = formatDocument(r as Record<string, unknown>);
    return text || tr('{0}: o arquivo não tem texto.', [name]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return tr('Não deu para ler {0}: {1}', [name, msg]);
  }
}

/**
 * Pedido com o texto dos documentos no fim, cabendo em `maxChars`. Arquivo que não é documento fica só citado.
 * Sem caminhos, devolve o pedido como veio.
 */
export async function promptWithDocuments(prompt: string, paths: readonly string[], maxChars: number): Promise<string> {
  if (!paths.length) return prompt;
  const head = tr('Documentos anexados (o texto abaixo é o conteúdo; use só o que está aqui):');
  const blocks: string[] = [];
  let used = (prompt.trim() ? prompt.trim().length + 2 : 0) + head.length + 2;
  for (const p of paths) {
    const name = basename(p);
    let body = isDocumentName(name) ? `${name}\n${await readDocumentText(p)}` : tr('{0} ficou em {1}. Este pedido só inclui o texto de PDF, planilha e Word.', [name, p]);
    const room = maxChars - used - 2;
    if (room < 40) {
      const skip = tr('{0}: ficou de fora do pedido (limite de texto).', [name]);
      blocks.push(skip);
      used += skip.length + 2;
      continue;
    }
    if (body.length > room) body = `${body.slice(0, Math.max(0, room - 20)).trimEnd()}\n${tr('[texto cortado]')}`;
    blocks.push(body);
    used += body.length + 2;
  }
  const base = prompt.trim() ? `${prompt.trimEnd()}\n\n` : '';
  return `${base}${head}\n\n${blocks.join('\n\n')}`.slice(0, maxChars);
}
