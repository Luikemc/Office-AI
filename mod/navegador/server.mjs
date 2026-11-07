#!/usr/bin/env node
// MCP "navegador" do Habblaud: servidor stdio sem dependências (JSON-RPC à mão, uma mensagem por linha) que repassa
// cada ferramenta para o navegador do escritório em http://127.0.0.1:<HABBLAUD_PORT>/api/browser/<ferramenta>. Quem
// abre o Chrome, guarda as abas e trava as ações arriscadas é o servidor do Habblaud; aqui só se acha a sessão
// (~/.claude/sessions/<pid do claude>.json) e se formata a resposta.
import { readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Versão do plugin (a do plugin.json, que acompanha o package.json do Habblaud). */
export const VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(new URL('./.claude-plugin/plugin.json', import.meta.url), 'utf8')).version ?? '0');
  } catch {
    return '0';
  }
})();
const PROTOCOL = '2025-06-18';

const INSTRUCTIONS =
  'Navegador local do escritório (Habblaud), com os logins do usuário. Sempre `ler` antes de agir; as refs (ex.: r3-e7) ' +
  'valem só para a última leitura da aba e toda ação devolve uma leitura nova. Enviar, submeter, pagar, confirmar, apagar ' +
  'ou publicar espera a aprovação do usuário no escritório: a chamada fica parada até ele responder. Nunca tente contornar ' +
  'a trava (outro botão, Enter, outro caminho); se for recusada, pare e pergunte. Captcha, códigos de verificação, QR code ' +
  'e senhas são com o usuário: peça para ele fazer na janela do navegador.';

const TAB = { type: 'string', description: 'Id da aba (ex.: "t1"), de `abrir` ou `abas`.' };
const REF = { type: 'string', description: 'Ref do elemento na ÚLTIMA leitura desta aba (ex.: "r3-e7"). Ref de leitura antiga é recusada: faça `ler` de novo.' };

export const TOOLS = [
  {
    name: 'abrir',
    description: 'Abre um site numa aba nova do navegador do escritório e devolve a leitura da página (título, URL, texto e elementos com ref). Só http/https.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Endereço (ex.: https://exemplo.com).' } }, required: ['url'], additionalProperties: false },
  },
  {
    name: 'ler',
    description: 'Lê de novo a página de uma aba: título, URL, texto visível (primeiro o que está na tela) e os elementos em que dá para agir, cada um com uma ref nova. Faça isto antes de clicar ou digitar.',
    inputSchema: { type: 'object', properties: { tabId: TAB }, required: ['tabId'], additionalProperties: false },
  },
  {
    name: 'clicar',
    description:
      'Clica num elemento da última leitura e devolve a leitura nova. Clicar em algo que envia, submete, paga, confirma, apaga ou publica (e qualquer ação no WhatsApp) espera a aprovação do usuário no escritório; não tente contornar.',
    inputSchema: {
      type: 'object',
      properties: { tabId: TAB, ref: REF, elemento: { type: 'string', description: 'Descrição humana do elemento, mostrada ao usuário na aprovação (ex.: "botão Enviar do formulário de contato").' } },
      required: ['tabId', 'ref', 'elemento'],
      additionalProperties: false,
    },
  },
  {
    name: 'digitar',
    description:
      'Preenche um campo de texto da última leitura (substitui o que havia). Com enviar=true aperta Enter em seguida, o que espera a aprovação do usuário no escritório (ele vê o texto exato). Senhas e códigos: peça ao usuário.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB,
        ref: REF,
        texto: { type: 'string', description: 'Texto a digitar.' },
        enviar: { type: 'boolean', description: 'Apertar Enter depois (envia/submete: pede aprovação).' },
        elemento: { type: 'string', description: 'Descrição humana do campo (ex.: "campo de busca").' },
      },
      required: ['tabId', 'ref', 'texto'],
      additionalProperties: false,
    },
  },
  {
    name: 'abas',
    description: 'Lista as abas desta sessão (id, título, URL).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'fechar',
    description: 'Fecha uma aba desta sessão.',
    inputSchema: { type: 'object', properties: { tabId: TAB }, required: ['tabId'], additionalProperties: false },
  },
];

// ------------------------------------------------------------------------------------------- sessão

/** Pai de um processo (/proc/<pid>/stat; o nome pode ter espaços e parênteses). */
function parentOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(rest[1]);
    return Number.isInteger(ppid) && ppid > 1 ? ppid : undefined;
  } catch {
    return undefined;
  }
}

/** Pastas de conta do Claude Code onde procurar sessions/<pid>.json: CLAUDE_CONFIG_DIR primeiro, depois ~/.claude*. */
export function configDirs(env = process.env, home = homedir()) {
  const out = [];
  if (env.CLAUDE_CONFIG_DIR) out.push(env.CLAUDE_CONFIG_DIR);
  out.push(join(home, '.claude'));
  try {
    for (const d of readdirSync(home)) if (d.startsWith('.claude') && d !== '.claude' && !d.includes('.json')) out.push(join(home, d));
  } catch {
    // sem home legível
  }
  return [...new Set(out)];
}

/**
 * sessionId da sessão do Claude Code que abriu este MCP: o registro <conta>/sessions/<pid>.json do processo pai (ou de
 * um avô, se houver um shell no meio). Lido a cada chamada (o /clear troca o sessionId).
 */
export function findSession({ env = process.env, home = homedir(), ppid = process.ppid, parent = parentOf } = {}) {
  if (env.HABBLAUD_NAVEGADOR_SESSION) return env.HABBLAUD_NAVEGADOR_SESSION;
  const dirs = configDirs(env, home);
  let pid = ppid;
  for (let depth = 0; pid && depth < 8; depth++) {
    for (const dir of dirs) {
      try {
        const rec = JSON.parse(readFileSync(join(dir, 'sessions', `${pid}.json`), 'utf8'));
        if (rec && typeof rec.sessionId === 'string' && rec.sessionId) return rec.sessionId;
      } catch {
        // não é esta pasta
      }
    }
    pid = parent(pid);
  }
  return undefined;
}

// ------------------------------------------------------------------------------------------- HTTP

function port(env = process.env) {
  const p = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  return Number.isInteger(p) && p > 0 && p < 65_536 ? p : 4747;
}

/** POST JSON ao Habblaud, sem tempo limite (a aprovação pode demorar); `signal` cancela. */
export function post(path, body, { env = process.env, signal } = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = request(
      { host: '127.0.0.1', port: port(env), path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, signal },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: { ok: false, error: text.slice(0, 300) } });
          }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

function text(t, isError = false) {
  return { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) };
}

/** Uma chamada de ferramenta: resultado MCP ({content, isError?}). */
export async function callTool(name, args, { env = process.env, signal, session = findSession } = {}) {
  if (!TOOLS.some((t) => t.name === name)) return text(`Ferramenta desconhecida: ${name}`, true);
  const sessionId = session({ env });
  if (!sessionId) {
    return text('Não achei a sessão do Claude Code deste navegador (~/.claude/sessions/<pid>.json). Peça ao usuário para reiniciar a sessão.', true);
  }
  let r;
  try {
    r = await post(`/api/browser/${name}`, { ...(args && typeof args === 'object' ? args : {}), sessionId }, { env, signal });
  } catch (err) {
    if (signal?.aborted) return text('Cancelado.', true);
    return text(
      `O escritório (Habblaud) não respondeu em 127.0.0.1:${port(env)} (${err?.code ?? err?.message ?? err}). Peça ao usuário para abrir o Habblaud e tente de novo.`,
      true,
    );
  }
  const j = r.json ?? {};
  if (j.ok) {
    if (name === 'abas') {
      const list = Array.isArray(j.abas) ? j.abas : [];
      return text(list.length ? list.map((a) => `${a.id} · ${a.title || '—'} · ${a.url}`).join('\n') : 'Nenhuma aba aberta nesta sessão.');
    }
    if (name === 'fechar') return text(`Aba ${j.fechada} fechada.`);
    return text(String(j.texto ?? ''));
  }
  if (j.code === 'denied') return text(`RECUSADO — a ação não foi feita: ${j.error}`, true);
  return text(`Erro (${j.code ?? r.status}): ${j.error ?? 'sem detalhes'}`, true);
}

// ------------------------------------------------------------------------------------------- JSON-RPC

/**
 * Servidor: lê mensagens (uma por linha) de `input` e escreve as respostas em `output`. Devolve uma Promise que
 * termina quando a entrada fecha e as chamadas em andamento acabam.
 */
export function serve({ input = process.stdin, output = process.stdout, env = process.env, call = callTool } = {}) {
  const inflight = new Map();
  const send = (msg) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const reply = (id, result) => send({ id, result });
  const error = (id, code, message) => send({ id, error: { code, message } });

  const handle = (msg) => {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      if (msg && typeof msg === 'object' && 'id' in msg && !('method' in msg)) return; // resposta a algo nosso: ignora
      return error(msg?.id ?? null, -32600, 'Invalid Request');
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'navegador', title: 'Navegador do Habblaud', version: VERSION },
          instructions: INSTRUCTIONS,
        });
      case 'ping':
        return isNotification ? undefined : reply(id, {});
      case 'tools/list':
        return reply(id, { tools: TOOLS });
      case 'tools/call': {
        const ac = new AbortController();
        const p = Promise.resolve()
          .then(() => call(String(params?.name ?? ''), params?.arguments ?? {}, { env, signal: ac.signal }))
          .then(
            (result) => {
              if (!ac.signal.aborted) reply(id, result);
            },
            (err) => {
              if (!ac.signal.aborted) reply(id, text(`Erro: ${err?.message ?? err}`, true));
            },
          )
          .finally(() => inflight.delete(id));
        inflight.set(id, { ac, p });
        return;
      }
      case 'notifications/cancelled': {
        const f = inflight.get(params?.requestId);
        if (f) f.ac.abort();
        return;
      }
      default:
        if (method.startsWith('notifications/') || isNotification) return;
        return error(id, -32601, `Method not found: ${method}`);
    }
  };

  return new Promise((resolve) => {
    let buf = '';
    input.setEncoding?.('utf8');
    input.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          error(null, -32700, 'Parse error');
          continue;
        }
        if (Array.isArray(msg)) msg.forEach(handle);
        else handle(msg);
      }
    });
    input.on('end', async () => {
      await Promise.allSettled([...inflight.values()].map((f) => f.p));
      resolve();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve().then(() => process.exit(0));
}
