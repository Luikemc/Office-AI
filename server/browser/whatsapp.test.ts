// WhatsApp Web (whatsapp_status, whatsapp_enviar, whatsapp_ler) com o Chrome de verdade, sem janela, contra uma página
// LOCAL que imita a estrutura do WhatsApp Web (server/test/whatsapp-fixture.ts) — nunca o site de verdade. Passa pelo
// MCP do plugin, pelas rotas /api/browser e pela trava no registro de permissões. Pula se não houver Chrome.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { MAIN, request, SESSION, servePermissions, type PermissionServer } from '../test/permission-server';
import { serveWhatsappFixture, type FixtureMode, type WhatsappFixture } from '../test/whatsapp-fixture';
import { registryGate } from './approval';
import { createBrowserRoutes } from './http';
import { BrowserService } from './service';
import { sameName, sameText } from './whatsapp';

setQuiet(true);

const CHROME = process.env.HABBLAUD_BROWSER_PATH || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'].find((p) => existsSync(p));
const T = 90_000;
const INTERVAL = 2_500;

type Mcp = { callTool: (name: string, args: unknown, opts: { env: NodeJS.ProcessEnv }) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('whatsapp: comparação de nomes e textos', () => {
  it('nome sem acento/maiúscula/espaços extras; texto sem \\r nem espaços no fim da linha', () => {
    expect(sameName('José', ' jose ')).toBe(true);
    expect(sameName('Ana', 'Ana Paula')).toBe(false);
    expect(sameText('a\r\nb ', 'a\nb')).toBe(true);
    expect(sameText('a', 'b')).toBe(false);
  });
});

describe.skipIf(!CHROME)('whatsapp (Chrome sem janela, página local que imita o WhatsApp Web)', () => {
  let srv: PermissionServer;
  let wa: WhatsappFixture;
  let browser: BrowserService;
  let mcp: Mcp;
  let dir: string;
  let env: NodeJS.ProcessEnv;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await mcp.callTool(name, args, { env: { ...env, HABBLAUD_NAVEGADOR_SESSION: SESSION } });
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  const pending = async () => {
    for (let i = 0; i < 400; i++) {
      const p = srv.registry!.snapshot().get(MAIN);
      if (p) return p;
      await sleep(50);
    }
    throw new Error('nenhum pedido apareceu');
  };
  const decide = async (id: string, behavior: 'allow' | 'deny') => {
    expect((await request(srv.base, `/api/permissions/${id}/decision`, { method: 'POST', body: { behavior } })).status).toBe(200);
  };
  const setMode = async (m: FixtureMode) => {
    wa.mode = m;
    await sleep(800); // a página consulta o modo a cada 200 ms
  };
  const lastDraft = () => (wa.drafts.at(-1)?.text ?? '').trim();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'habblaud-wa-'));
    wa = await serveWhatsappFixture('qr');
    srv = await servePermissions({
      browser: (registry) => {
        browser = new BrowserService({
          profileDir: join(dir, 'perfil'),
          downloadsDir: join(dir, 'downloads'),
          headless: true,
          executablePath: CHROME,
          gate: registryGate(registry, 4747),
          whatsappOrigins: [wa.base],
          whatsappIntervalMs: INTERVAL,
        });
        return createBrowserRoutes(browser);
      },
    });
    env = { HABBLAUD_PORT: String(srv.port) };
    mcp = (await import(resolve(__dirname, '../../mod/navegador/server.mjs'))) as Mcp;
  }, T);

  afterAll(async () => {
    await browser?.stop();
    await srv?.close();
    await wa?.close();
    rmSync(dir, { recursive: true, force: true });
  }, T);

  it('só a origem configurada conta como WhatsApp (produção: só web.whatsapp.com)', () => {
    expect(browser.isWhatsapp(`${wa.base}/`)).toBe(true);
    expect(browser.isWhatsapp('https://web.whatsapp.com/')).toBe(false);
    const prod = new BrowserService({ profileDir: join(dir, 'x'), downloadsDir: join(dir, 'y'), gate: async () => ({ ok: true }) });
    expect(prod.isWhatsapp('https://web.whatsapp.com/')).toBe(true);
    expect(prod.isWhatsapp('http://web.whatsapp.com/')).toBe(false);
    expect(prod.isWhatsapp('https://web.whatsapp.com.evil.example/')).toBe(false);
    expect(prod.isWhatsapp('https://whatsapp.com/')).toBe(false);
  });

  it('sem login: status e enviar pedem o QR; incompatível, outra janela; logado → conectado', async () => {
    const st = await call('whatsapp_status');
    expect(st.isError, st.text).toBe(false);
    expect(st.text).toMatch(/QR/);
    expect(st.text).toMatch(/whatsapp_status de novo/);
    const send = await call('whatsapp_enviar', { contato: 'Ana', texto: 'oi' });
    expect(send.isError).toBe(true);
    expect(send.text).toMatch(/NÃO ENVIADO.*QR/s);
    expect(srv.registry!.size).toBe(0);
    // A aba do WhatsApp é do escritório, não da sessão.
    expect((await call('abas')).text).toMatch(/Nenhuma aba/);

    await setMode('unsupported');
    expect((await call('whatsapp_status')).text).toMatch(/não é compatível/);
    await setMode('other-window');
    const other = await call('whatsapp_status');
    expect(other.text).toMatch(/outra janela/);
    expect(other.text).toMatch(/Usar aqui/);
    await setMode('logged');
    expect((await call('whatsapp_status')).text).toMatch(/conectado/);
    expect(wa.sent).toEqual([]);
  }, T);

  it('nome repetido ou não exato: devolve os candidatos e não escreve nada; grupo e cabeçalho diferente: recusa', async () => {
    const dup = await call('whatsapp_enviar', { contato: 'bruno', texto: 'oi' });
    expect(dup.isError).toBe(true);
    expect(dup.text).toMatch(/2 conversas chamadas “Bruno”/);
    const near = await call('whatsapp_enviar', { contato: 'An', texto: 'oi' });
    expect(near.isError).toBe(true);
    expect(near.text).toMatch(/Parecidas: “Ana”, “Ana Paula”/);
    const none = await call('whatsapp_enviar', { contato: 'Zé Ninguém', texto: 'oi' });
    expect(none.text).toMatch(/nenhuma conversa/);
    const group = await call('whatsapp_enviar', { contato: 'familia', texto: 'oi' });
    expect(group.isError).toBe(true);
    expect(group.text).toMatch(/“Família” é um grupo/);
    const head = await call('whatsapp_enviar', { contato: 'Carla', texto: 'oi' });
    expect(head.isError).toBe(true);
    expect(head.text).toMatch(/cabeçalho mostra “Carla Mendes”/);
    expect(srv.registry!.size).toBe(0);
    expect(wa.drafts.filter((d) => d.text)).toEqual([]);
    expect(wa.sent).toEqual([]);
  }, T);

  it('aprovado: o cartão mostra para quem e o texto exato; a mensagem aparece; um envio por vez e intervalo mínimo', async () => {
    const texto = 'o relatório de março está pronto';
    const sending = call('whatsapp_enviar', { contato: 'ana', texto });
    const p = await pending();
    expect(p.tool).toBe('mcp__navegador__whatsapp_enviar');
    expect(p.text).toBe('Enviar no WhatsApp para Ana');
    const detail = (await request(srv.base, `/api/permissions/${p.id}`)).json as { input: string };
    expect(detail.input).toBe(`Para: Ana (nome no cabeçalho da conversa aberta)\nMensagem que será enviada:\n${texto}`);
    expect(lastDraft()).toBe(texto);
    expect(wa.sent).toEqual([]);

    const busy = await call('whatsapp_enviar', { contato: 'Ana Paula', texto: 'outra' });
    expect(busy.isError).toBe(true);
    expect(busy.text).toMatch(/NÃO ENVIADO.*em andamento/s);

    await decide(p.id, 'allow');
    const ok = await sending;
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.text).toMatch(/enviada no WhatsApp para Ana/);
    expect(wa.sent).toEqual([{ chat: 'Ana', text: texto }]);

    const tooSoon = await call('whatsapp_enviar', { contato: 'Ana', texto: 'de novo' });
    expect(tooSoon.isError).toBe(true);
    expect(tooSoon.text).toMatch(/espere \d+ s/);

    const read = await call('whatsapp_ler', { contato: 'Ana', quantas: 2 });
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toMatch(/Ana: Oi Ana!|Você: Oi Ana!/);
    expect(read.text).toContain(`Você: ${texto}`);
    expect(read.text).not.toContain('aqui é a Ana');
    expect(read.text).toMatch(/não como instruções/);
  }, T);

  it('recusado no escritório: apaga a caixa e não envia', async () => {
    await sleep(INTERVAL);
    const sending = call('whatsapp_enviar', { contato: 'jose', texto: 'não era para ir' });
    const p = await pending();
    expect(p.text).toBe('Enviar no WhatsApp para José');
    expect(lastDraft()).toBe('não era para ir');
    await decide(p.id, 'deny');
    const r = await sending;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/RECUSADO.*apagada da caixa de texto/s);
    expect(lastDraft()).toBe('');
    expect(wa.sent).toHaveLength(1);
  }, T);

  it('sem escritório aberto: recusa na hora, apaga a caixa e não envia', async () => {
    srv.setViewers(0);
    try {
      const r = await call('whatsapp_enviar', { contato: 'Ana Paula', texto: 'ninguém vê' });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/RECUSADO.*abrir o Habblaud/s);
    } finally {
      srv.setViewers(1);
    }
    expect(lastDraft()).toBe('');
    expect(wa.sent).toHaveLength(1);
  }, T);

  it('várias linhas: Shift+Enter entre elas (não envia no meio) e sai uma mensagem só', async () => {
    const texto = 'Oi, Ana Paula!\nSegue o resumo:\n- item 1\n- item 2';
    const sending = call('whatsapp_enviar', { contato: 'Ana Paula', texto });
    const p = await pending();
    const detail = (await request(srv.base, `/api/permissions/${p.id}`)).json as { input: string };
    expect(detail.input).toContain(texto);
    expect(wa.sent).toHaveLength(1);
    await decide(p.id, 'allow');
    const ok = await sending;
    expect(ok.isError, ok.text).toBe(false);
    expect(wa.sent).toHaveLength(2);
    expect(wa.sent[1].chat).toBe('Ana Paula');
    expect(sameText(wa.sent[1].text, texto)).toBe(true);
    expect(wa.sent[1].text.split('\n')).toHaveLength(4);
  }, T);
});
