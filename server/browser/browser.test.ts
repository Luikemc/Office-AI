// Navegador de verdade (Chrome do sistema, sem janela) contra páginas locais servidas aqui mesmo: o MCP do plugin
// (mod/navegador/server.mjs) → /api/browser (com a trava de borda do app.ts) → BrowserService → trava no registro de
// permissões. Abrir, ler, digitar e clicar em "Enviar" (que espera a aprovação: recusa e aprovação), refs velhas,
// abas de outra sessão, sem escritório aberto, popup. Pula se não houver Chrome. Nunca acessa a internet.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { MAIN, request, SESSION, servePermissions, type PermissionServer } from '../test/permission-server';
import { registryGate } from './approval';
import { createBrowserRoutes } from './http';
import { BrowserService } from './service';

setQuiet(true);

const CHROME = process.env.HABBLAUD_BROWSER_PATH || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'].find((p) => existsSync(p));
const T = 60_000;

type Mcp = { callTool: (name: string, args: unknown, opts: { env: NodeJS.ProcessEnv; signal?: AbortSignal }) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> };

const PAGES: Record<string, string> = {
  '/titulo': '<!doctype html><title>Página de Teste</title><h1>Olá, navegador</h1><p>Um parágrafo qualquer.</p>',
  '/form':
    '<!doctype html><title>Contato</title><h1>Fale conosco</h1><form action="/enviado" method="get">' +
    '<label>Nome <input name="nome"></label> <button>Enviar</button></form><a href="/titulo">Ver título</a>',
  '/popup': '<!doctype html><title>Popup</title><a href="/titulo" target="_blank">Abrir em outra aba</a>',
};

function fixtures(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    let body = PAGES[u.pathname];
    if (u.pathname === '/enviado') body = `<!doctype html><title>Enviado</title><p>Recebido: ${(u.searchParams.get('nome') ?? '').replace(/[<>&]/g, '')}</p>`;
    if (!body) return void res.writeHead(404).end('não tem');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
  });
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      ok({ base: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) });
    }),
  );
}

describe.skipIf(!CHROME)('navegador (Chrome sem janela, páginas locais)', () => {
  let srv: PermissionServer;
  let site: { base: string; close: () => Promise<void> };
  let browser: BrowserService;
  let mcp: Mcp;
  let dir: string;
  let env: NodeJS.ProcessEnv;

  const call = async (name: string, args: Record<string, unknown> = {}, session = SESSION) => {
    const r = await mcp.callTool(name, args, { env: { ...env, HABBLAUD_NAVEGADOR_SESSION: session } });
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  const refOf = (text: string, re: RegExp) => {
    const m = re.exec(text);
    if (!m) throw new Error(`ref não achada em:\n${text}`);
    return m[1];
  };
  /** Espera o pedido do navegador aparecer na sala e o devolve. */
  const pendingId = async () => {
    for (let i = 0; i < 200; i++) {
      const p = srv.registry!.snapshot().get(MAIN);
      if (p) return p;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('nenhum pedido apareceu');
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'habblaud-nav-'));
    site = await fixtures();
    srv = await servePermissions({
      browser: (registry) => {
        browser = new BrowserService({ profileDir: join(dir, 'perfil'), downloadsDir: join(dir, 'downloads'), headless: true, executablePath: CHROME, gate: registryGate(registry, 4747) });
        return createBrowserRoutes(browser);
      },
    });
    env = { HABBLAUD_PORT: String(srv.port) };
    mcp = (await import(resolve(__dirname, '../../mod/navegador/server.mjs'))) as Mcp;
  }, T);

  afterAll(async () => {
    await browser?.stop();
    await srv?.close();
    await site?.close();
    rmSync(dir, { recursive: true, force: true });
  }, T);

  it('abrir e ler o título; abas; outra sessão não vê nem mexe na aba', async () => {
    const r = await call('abrir', { url: `${site.base}/titulo` });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/Título: Página de Teste/);
    expect(r.text).toMatch(/heading "Olá, navegador"/);
    const tab = /Aba (t\d+)/.exec(r.text)![1];
    expect((await call('abas')).text).toContain(`${tab} · Página de Teste`);
    expect((await call('abas', {}, 'outra-sessao')).text).toMatch(/Nenhuma aba/);
    const other = await call('ler', { tabId: tab }, 'outra-sessao');
    expect(other.isError).toBe(true);
    expect(other.text).toMatch(/aba desconhecida/);
    expect((await call('fechar', { tabId: tab })).text).toMatch(/fechada/);
  }, T);

  it('formulário: digitar sem enviar roda; ref velha é recusada; Enviar espera a aprovação (recusa, depois aprova)', async () => {
    const open = await call('abrir', { url: `${site.base}/form` });
    const tab = /Aba (t\d+)/.exec(open.text)![1];
    const nome = refOf(open.text, /textbox "Nome"[^\n]*\[ref=(r\d+-e\d+)\]/);
    const typed = await call('digitar', { tabId: tab, ref: nome, texto: 'Ana', elemento: 'campo Nome' });
    expect(typed.isError, typed.text).toBe(false);
    expect(srv.registry!.size).toBe(0);
    expect(typed.text).toMatch(/textbox "Nome"[^\n]*\[ref=r\d+-e\d+\]: Ana/);

    // A ref da leitura anterior não vale mais.
    const stale = await call('clicar', { tabId: tab, ref: nome, elemento: 'campo Nome' });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/faça `ler` de novo/);

    // Enviar: trava. Recusado no escritório → nada acontece.
    let enviar = refOf(typed.text, /button "Enviar"[^\n]*\[ref=(r\d+-e\d+)\]/);
    const denied = call('clicar', { tabId: tab, ref: enviar, elemento: 'botão Enviar do formulário' });
    const p1 = await pendingId();
    expect(p1.tool).toBe('mcp__navegador__clicar');
    expect(p1.text).toMatch(/Enviar/);
    expect(srv.office.commit().snapshot.agents.find((a) => a.id === MAIN)?.status).toBe('waiting');
    const detail = (await request(srv.base, `/api/permissions/${p1.id}`)).json as { input: string };
    expect(detail.input).toMatch(/Descrição do agente: botão Enviar do formulário/);
    expect((await request(srv.base, `/api/permissions/${p1.id}/decision`, { method: 'POST', body: { behavior: 'deny' } })).status).toBe(200);
    const d = await denied;
    expect(d.isError).toBe(true);
    expect(d.text).toMatch(/RECUSADO/);
    const after = await call('ler', { tabId: tab });
    expect(after.text).toMatch(/Título: Contato/);

    // Aprovado → o formulário vai.
    enviar = refOf(after.text, /button "Enviar"[^\n]*\[ref=(r\d+-e\d+)\]/);
    const allowed = call('clicar', { tabId: tab, ref: enviar, elemento: 'botão Enviar' });
    const p2 = await pendingId();
    expect(p2.id).not.toBe(p1.id);
    // O relógio do registro (tick) não solta o pedido interno por falta de long-poll.
    await new Promise((r) => setTimeout(r, 400));
    expect(srv.registry!.snapshot().get(MAIN)?.id).toBe(p2.id);
    expect((await request(srv.base, `/api/permissions/${p2.id}/decision`, { method: 'POST', body: { behavior: 'allow' } })).status).toBe(200);
    const ok = await allowed;
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.text).toMatch(/Título: Enviado/);
    expect(ok.text).toMatch(/Recebido: Ana/);
  }, T);

  it('digitar com enviar=true espera aprovação com o texto exato; sem escritório aberto, recusa na hora', async () => {
    const open = await call('abrir', { url: `${site.base}/form` });
    const tab = /Aba (t\d+)/.exec(open.text)![1];
    const nome = refOf(open.text, /textbox "Nome"[^\n]*\[ref=(r\d+-e\d+)\]/);
    srv.setViewers(0);
    const t0 = Date.now();
    const r = await call('digitar', { tabId: tab, ref: nome, texto: 'Oi, tudo bem?', enviar: true });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/RECUSADO.*abrir o beta-tester/s);
    srv.setViewers(1);
    const again = await call('ler', { tabId: tab });
    expect(again.text).toMatch(/Título: Contato/);
    const nome2 = refOf(again.text, /textbox "Nome"[^\n]*\[ref=(r\d+-e\d+)\]/);
    const pending = call('digitar', { tabId: tab, ref: nome2, texto: 'Oi, tudo bem?', enviar: true });
    const p = await pendingId();
    const detail = (await request(srv.base, `/api/permissions/${p.id}`)).json as { input: string };
    expect(detail.input).toMatch(/Texto que será digitado:\nOi, tudo bem\?/);
    await request(srv.base, `/api/permissions/${p.id}/decision`, { method: 'POST', body: { behavior: 'allow' } });
    const done = await pending;
    expect(done.text).toMatch(/Recebido: Oi, tudo bem\?/);
  }, T);

  it('link com target=_blank vira aba da mesma sessão', async () => {
    const open = await call('abrir', { url: `${site.base}/popup` });
    const tab = /Aba (t\d+)/.exec(open.text)![1];
    const link = refOf(open.text, /link "Abrir em outra aba"[^\n]*\[ref=(r\d+-e\d+)\]/);
    const r = await call('clicar', { tabId: tab, ref: link, elemento: 'link' });
    expect(r.isError, r.text).toBe(false);
    let abas = '';
    for (let i = 0; i < 40 && !/Página de Teste/.test(abas); i++) {
      abas = (await call('abas')).text;
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(abas).toMatch(/Página de Teste/);
  }, T);

  it('url que não é http(s) é recusada; a rota recusa Origin e acesso remoto', async () => {
    const r = await call('abrir', { url: 'file:///etc/passwd' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/http/);
    const evil = await request(srv.base, '/api/browser/abas', { method: 'POST', body: { sessionId: SESSION }, headers: { Origin: srv.base } });
    expect(evil.status).toBe(403);
    const host = await request(srv.base, '/api/browser/abas', { method: 'POST', body: { sessionId: SESSION }, headers: { Host: 'habblaud.lan' } });
    expect(host.status).toBe(403);
  }, T);
});
