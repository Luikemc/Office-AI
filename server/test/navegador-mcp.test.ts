// MCP do plugin navegador (mod/navegador/server.mjs) rodando como processo, como o Claude Code o abre: JSON-RPC uma
// mensagem por linha no stdio (initialize, tools/list, tools/call, ping, notificações, erro de parse), repassando
// para um Habblaud falso; e a busca da sessão por <conta>/sessions/<pid>.json subindo pelos processos pais.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { tempDir } from './fixtures';

const SERVER = resolve(__dirname, '../../mod/navegador/server.mjs');

type Rec = Record<string, unknown>;

/** Habblaud falso: guarda as chamadas e responde por rota. */
async function fakeHabblaud(reply: (path: string, body: Rec) => { status: number; json: unknown }) {
  const calls: Array<{ path: string; body: Rec; origin?: string }> = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const body = JSON.parse(data) as Rec;
      calls.push({ path: req.url ?? '', body, origin: req.headers.origin });
      const r = reply(req.url ?? '', body);
      res.writeHead(r.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return { port: (server.address() as AddressInfo).port, calls, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

function startMcp(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH ?? '', HOME: '/nao-existe', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines: Rec[] = [];
  const waiters: Array<() => void> = [];
  createInterface({ input: child.stdout }).on('line', (l) => {
    lines.push(JSON.parse(l) as Rec);
    waiters.splice(0).forEach((w) => w());
  });
  const send = (msg: unknown) => child.stdin.write(`${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`);
  const next = async (pred: (m: Rec) => boolean): Promise<Rec> => {
    for (;;) {
      const i = lines.findIndex(pred);
      if (i >= 0) return lines.splice(i, 1)[0];
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  const byId = (id: unknown) => next((m) => m.id === id);
  return { child, send, byId, lines, stop: () => child.stdin.end() };
}

describe('MCP navegador (stdio)', () => {
  it('initialize, tools/list e tools/call repassado ao beta-tester com o sessionId', async () => {
    const hab = await fakeHabblaud((path) =>
      path === '/api/browser/abrir'
        ? { status: 200, json: { ok: true, aba: { id: 't1' }, texto: 'Aba t1 · revisão 1\nTítulo: Teste' } }
        : { status: 403, json: { ok: false, code: 'denied', error: 'o usuário recusou no escritório.' } },
    );
    const mcp = startMcp({ HABBLAUD_PORT: String(hab.port), HABBLAUD_NAVEGADOR_SESSION: 'sess-9' });
    try {
      mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
      const init = (await mcp.byId(1)).result as Rec;
      expect(init.protocolVersion).toBe('2025-06-18');
      expect(init.capabilities).toEqual({ tools: { listChanged: false } });
      expect(String(init.instructions)).toMatch(/aprovação do usuário no escritório/);
      mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

      mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const tools = ((await mcp.byId(2)).result as { tools: Array<{ name: string; description: string; inputSchema: Rec }> }).tools;
      expect(tools.map((t) => t.name)).toEqual(['abrir', 'ler', 'clicar', 'digitar', 'abas', 'fechar', 'whatsapp_status', 'whatsapp_enviar', 'whatsapp_ler']);
      for (const t of tools) expect(t.inputSchema.type).toBe('object');
      expect(tools.find((t) => t.name === 'clicar')!.inputSchema.required).toEqual(['tabId', 'ref', 'elemento']);

      mcp.send({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'abrir', arguments: { url: 'http://127.0.0.1/x' } } });
      expect((await mcp.byId('a')).result).toEqual({ content: [{ type: 'text', text: 'Aba t1 · revisão 1\nTítulo: Teste' }] });
      expect(hab.calls[0]).toEqual({ path: '/api/browser/abrir', body: { url: 'http://127.0.0.1/x', sessionId: 'sess-9' }, origin: undefined });

      // Recusa da trava: isError com RECUSADO; o modelo não consegue trocar o sessionId pelos argumentos.
      mcp.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'clicar', arguments: { tabId: 't1', ref: 'r1-e2', elemento: 'Enviar', sessionId: 'outra' } } });
      const denied = (await mcp.byId(3)).result as { content: Array<{ text: string }>; isError: boolean };
      expect(denied.isError).toBe(true);
      expect(denied.content[0].text).toMatch(/^RECUSADO/);
      expect(hab.calls[1].body.sessionId).toBe('sess-9');

      mcp.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'evaluate', arguments: {} } });
      expect(((await mcp.byId(4)).result as Rec).isError).toBe(true);
      mcp.send({ jsonrpc: '2.0', id: 5, method: 'ping' });
      expect((await mcp.byId(5)).result).toEqual({});
      mcp.send({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
      expect(((await mcp.byId(6)).error as Rec).code).toBe(-32601);
      mcp.send('{quebrado');
      expect(((await mcp.byId(null)).error as Rec).code).toBe(-32700);
    } finally {
      mcp.stop();
      await hab.close();
    }
  }, 30_000);

  it('beta-tester fora do ar: erro claro, sem derrubar o MCP', async () => {
    const mcp = startMcp({ HABBLAUD_PORT: '1', HABBLAUD_NAVEGADOR_SESSION: 's' });
    try {
      mcp.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'abas', arguments: {} } });
      const r = (await mcp.byId(1)).result as { content: Array<{ text: string }>; isError: boolean };
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/não respondeu/);
      mcp.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
      expect((await mcp.byId(2)).result).toEqual({});
    } finally {
      mcp.stop();
    }
  }, 30_000);

  it('a sessão vem de <conta>/sessions/<pid>.json do pai (ou de um avô) e é relida a cada chamada', async () => {
    const { findSession } = (await import(SERVER)) as { findSession: (o: Rec) => string | undefined };
    const tmp = tempDir();
    try {
      const conta = join(tmp.dir, '.claude-conta2');
      mkdirSync(join(conta, 'sessions'), { recursive: true });
      const parents: Record<number, number> = { 500: 400, 400: 300 };
      const parent = (pid: number) => parents[pid];
      writeFileSync(join(conta, 'sessions', '400.json'), JSON.stringify({ pid: 400, sessionId: 'abc' }));
      expect(findSession({ env: {}, home: tmp.dir, ppid: 500, parent })).toBe('abc');
      writeFileSync(join(conta, 'sessions', '400.json'), JSON.stringify({ pid: 400, sessionId: 'depois-do-clear' }));
      expect(findSession({ env: { CLAUDE_CONFIG_DIR: conta }, home: '/nao-existe', ppid: 500, parent })).toBe('depois-do-clear');
      expect(findSession({ env: {}, home: tmp.dir, ppid: 300, parent })).toBeUndefined();
    } finally {
      tmp.cleanup();
    }
  });
});
