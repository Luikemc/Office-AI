// Ferramentas de arquivo do agente local, sempre dentro da pasta do projeto (a da sala):
// - listar_arquivos e ler_arquivo: só leem, sem pedir;
// - escrever_arquivo: cria ou substitui um arquivo de texto e SEMPRE pede aprovação no escritório (a sala levanta a
//   mão com o caminho e o conteúdo). Sem escritório aberto, recusado.
// Caminhos que saem da pasta (.., absolutos de fora, links simbólicos para fora) são recusados. No transcript elas
// aparecem como as ferramentas do Claude Code (LS, Read, Write), para o escritório descrever igual.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tr } from '../../shared/i18n';
import type { OllamaTool } from './ollama';

export const READ_MAX = 40_000;
export const WRITE_MAX = 200_000;
export const LIST_MAX = 300;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

export class FileToolError extends Error {}

export interface ApprovalRequest {
  tool: string;
  title: string;
  text: string;
  icon: string;
  input: string;
}

/** Pede aprovação no escritório: ok = pode fazer; senão a mensagem para o modelo. */
export type Approve = (r: ApprovalRequest, signal?: AbortSignal) => Promise<{ ok: true } | { ok: false; message: string }>;

export const FILE_TOOLS: OllamaTool[] = [
  {
    type: 'function',
    function: {
      name: 'listar_arquivos',
      description: 'Lista os arquivos e pastas de uma pasta do projeto (sem entrar nas subpastas).',
      parameters: { type: 'object', properties: { pasta: { type: 'string', description: 'Caminho relativo à pasta do projeto; vazio = a raiz.' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ler_arquivo',
      description: 'Lê um arquivo de texto do projeto. Para PDF, planilha ou Word use ler_documento.',
      parameters: {
        type: 'object',
        properties: {
          caminho: { type: 'string', description: 'Caminho relativo à pasta do projeto.' },
          inicio: { type: 'number', description: 'Primeira linha (1 = começo). Opcional.' },
        },
        required: ['caminho'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escrever_arquivo',
      description: 'Cria ou substitui um arquivo de texto do projeto com o conteúdo inteiro. Pede aprovação ao usuário.',
      parameters: {
        type: 'object',
        properties: {
          caminho: { type: 'string', description: 'Caminho relativo à pasta do projeto.' },
          conteudo: { type: 'string', description: 'O conteúdo completo do arquivo.' },
        },
        required: ['caminho', 'conteudo'],
      },
    },
  },
];

/** Nome da ferramenta do Claude Code equivalente (para o transcript e a descrição no escritório). */
export const CLAUDE_NAMES: Record<string, string> = { listar_arquivos: 'LS', ler_arquivo: 'Read', escrever_arquivo: 'Write' };

function inside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Caminho absoluto dentro da raiz (seguindo links simbólicos do que já existe). Lança FileToolError. */
export function resolveInside(root: string, raw: unknown, allowMissing = false): string {
  const realRoot = realpathSync(root);
  const given = typeof raw === 'string' ? raw.trim() : '';
  const target = resolve(realRoot, given || '.');
  if (!inside(realRoot, target)) throw new FileToolError(tr('o caminho sai da pasta do projeto'));
  // O que já existe: o caminho real (links simbólicos) também precisa ficar dentro.
  let probe = target;
  while (!existsSync(probe)) {
    if (!allowMissing) throw new FileToolError(tr('não existe: {0}', [given || '.']));
    const up = dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  if (!inside(realRoot, realpathSync(probe))) throw new FileToolError(tr('o caminho sai da pasta do projeto'));
  return target;
}

function relName(root: string, p: string): string {
  return relative(realpathSync(root), p) || '.';
}

export function listFiles(root: string, args: Record<string, unknown>): string {
  const dir = resolveInside(root, args.pasta);
  if (!statSync(dir).isDirectory()) throw new FileToolError(tr('não é uma pasta: {0}', [relName(root, dir)]));
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => !SKIP_DIRS.has(e.name));
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const lines = entries.slice(0, LIST_MAX).map((e) => {
    if (e.isDirectory()) return `${e.name}/`;
    try {
      return `${e.name} (${statSync(join(dir, e.name)).size} bytes)`;
    } catch {
      return e.name;
    }
  });
  if (entries.length > LIST_MAX) lines.push(tr('… e mais {0}', [entries.length - LIST_MAX]));
  return lines.length ? `${relName(root, dir)}:\n${lines.join('\n')}` : tr('{0}: pasta vazia', [relName(root, dir)]);
}

export function readTextFile(root: string, args: Record<string, unknown>): string {
  const file = resolveInside(root, args.caminho);
  const st = statSync(file);
  if (!st.isFile()) throw new FileToolError(tr('não é um arquivo: {0}', [relName(root, file)]));
  if (st.size > 20 * 1024 * 1024) throw new FileToolError(tr('arquivo grande demais para ler como texto'));
  const buf = readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) throw new FileToolError(tr('arquivo binário: para PDF, planilha ou Word use ler_documento'));
  const all = buf.toString('utf8').split('\n');
  const start = Math.max(1, Math.floor(typeof args.inicio === 'number' ? args.inicio : 1));
  let out = '';
  let n = start;
  for (; n <= all.length; n++) {
    const line = `${n}\t${all[n - 1]}\n`;
    if (out.length + line.length > READ_MAX) break;
    out += line;
  }
  if (n <= all.length) out += tr('[o arquivo continua: chame ler_arquivo com inicio={0}]', [n]);
  return out || tr('(arquivo vazio)');
}

export async function writeTextFile(root: string, args: Record<string, unknown>, approve: Approve, signal?: AbortSignal): Promise<{ ok: boolean; text: string }> {
  if (typeof args.conteudo !== 'string') throw new FileToolError(tr('faltou o conteudo'));
  if (args.conteudo.length > WRITE_MAX) throw new FileToolError(tr('conteúdo grande demais (máximo {0} caracteres)', [WRITE_MAX]));
  const file = resolveInside(root, args.caminho, true);
  if (existsSync(file) && (lstatSync(file).isDirectory() || !lstatSync(file).isFile())) throw new FileToolError(tr('não é um arquivo: {0}', [relName(root, file)]));
  const rel = relName(root, file);
  const exists = existsSync(file);
  const d = await approve(
    {
      tool: 'Write',
      title: `Write(${rel})`,
      text: exists ? tr('Substituir {0}', [rel]) : tr('Criar {0}', [rel]),
      icon: '📝',
      input: [tr('Arquivo: {0}', [rel]), exists ? tr('O arquivo existe e será substituído.') : tr('Arquivo novo.'), tr('Conteúdo:'), args.conteudo.slice(0, 4_000) + (args.conteudo.length > 4_000 ? '…' : '')].join('\n'),
    },
    signal,
  );
  if (!d.ok) return { ok: false, text: d.message };
  mkdirSync(dirname(file), { recursive: true });
  // Conferido de novo depois da espera (a pasta pode ter mudado enquanto o cartão estava aberto).
  resolveInside(root, rel, true);
  writeFileSync(file, args.conteudo);
  return { ok: true, text: tr('gravado: {0} ({1} caracteres)', [rel, args.conteudo.length]) };
}
