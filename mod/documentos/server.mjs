#!/usr/bin/env node
// Servidor MCP "documentos" (stdio, JSON-RPC 2.0, uma mensagem por linha). Só node:*, sem dependências: o Claude
// Code copia a pasta do plugin para o cache e roda daqui, sem npm install.
//
// Lê e confere documentos da pasta do projeto (o cwd com que o Claude Code abre o servidor): PDF com texto,
// planilhas (xlsx, csv) e Word (docx). As contas são feitas em código; correções vão para <nome>-corrigido.<ext>.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ErroCaminho } from './lib/caminho.mjs';
import { ErroFerramenta, executar, FERRAMENTAS } from './lib/ferramentas.mjs';
import { NaoConferida } from './lib/formula.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const VERSAO = (() => {
  try {
    return JSON.parse(readFileSync(join(AQUI, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const PROTOCOLOS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_RESPOSTA = 200_000;

const INSTRUCOES =
  'Documentos da pasta do projeto (PDF com texto, xlsx, csv, docx). Leia com ler_documento; para contas use ' +
  'conferir_planilha e conferir_boleto, que calculam em código: não refaça as somas de cabeça. Ao responder, liste os ' +
  'valores, o que não bate e de onde veio cada um (p.3, Plan1!B7, §12, T1:L2:C3, com o trecho). Correções só com ' +
  'salvar_correcao, que grava <nome>-corrigido.<ext> e nunca mexe no original; PDF não é editado (escreva um relatório).';

export const raiz = () => process.env.CLAUDE_PROJECT_DIR || process.cwd();

function enviar(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function chamarFerramenta(params) {
  const nome = params?.name;
  try {
    const r = await executar(nome, params?.arguments, raiz());
    let texto = JSON.stringify(r, null, 1);
    if (texto.length > MAX_RESPOSTA) texto = texto.slice(0, MAX_RESPOSTA) + '\n… (resposta cortada no limite; peça uma página ou planilha por vez)';
    return { content: [{ type: 'text', text: texto }], isError: false };
  } catch (e) {
    const conhecido = e instanceof ErroFerramenta || e instanceof ErroCaminho || e instanceof NaoConferida;
    const msg = conhecido ? e.message : `não consegui ler o arquivo: ${e?.message ?? e}`;
    return { content: [{ type: 'text', text: `Erro: ${msg}` }], isError: true };
  }
}

export async function tratar(msg) {
  const { id, method, params } = msg ?? {};
  const resposta = (result) => (id === undefined || id === null ? undefined : { jsonrpc: '2.0', id, result });
  const erro = (code, message) => (id === undefined || id === null ? undefined : { jsonrpc: '2.0', id, error: { code, message } });
  if (typeof method !== 'string') return erro(-32600, 'requisição inválida');
  switch (method) {
    case 'initialize': {
      const pedido = params?.protocolVersion;
      return resposta({
        protocolVersion: PROTOCOLOS.includes(pedido) ? pedido : PROTOCOLOS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'documentos', title: 'Documentos (Escritório IA)', version: VERSAO },
        instructions: INSTRUCOES,
      });
    }
    case 'ping':
      return resposta({});
    case 'tools/list':
      return resposta({ tools: FERRAMENTAS });
    case 'tools/call':
      return resposta(await chamarFerramenta(params));
    case 'resources/list':
      return resposta({ resources: [] });
    case 'prompts/list':
      return resposta({ prompts: [] });
    default:
      if (method.startsWith('notifications/')) return undefined;
      return erro(-32601, `método não suportado: ${method}`);
  }
}

function principal() {
  let buffer = '';
  let fila = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const linha = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!linha) continue;
      // Em ordem: uma resposta por vez, na ordem dos pedidos.
      fila = fila.then(() => processarLinha(linha));
    }
  });
  process.stdin.on('end', () => {
    fila.then(() => process.exit(0));
  });
}

async function processarLinha(linha) {
  let msg;
  try {
    msg = JSON.parse(linha);
  } catch {
    enviar({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } });
    return;
  }
  const lote = Array.isArray(msg) ? msg : [msg];
  const respostas = [];
  for (const m of lote) {
    try {
      const r = await tratar(m);
      if (r) respostas.push(r);
    } catch (e) {
      if (m?.id !== undefined && m?.id !== null) respostas.push({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String(e?.message ?? e) } });
    }
  }
  if (Array.isArray(msg)) {
    if (respostas.length) enviar(respostas);
  } else if (respostas[0]) enviar(respostas[0]);
}

principal();
