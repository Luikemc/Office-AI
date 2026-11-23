// WhatsApp Web (whatsapp_status, whatsapp_enviar, whatsapp_ler) com o Chrome de verdade, sem janela, contra uma página
// LOCAL que imita a estrutura do WhatsApp Web (server/test/whatsapp-fixture.ts) — nunca o site de verdade. Passa pelo
// MCP do plugin e pelas rotas /api/browser. O envio não pede aprovação. Pula se não houver Chrome.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { SESSION, servePermissions, type PermissionServer } from '../test/permission-server';
import { serveWhatsappFixture, type FixtureMode, type WhatsappFixture } from '../test/whatsapp-fixture';
import { registryGate } from './approval';
import { createBrowserRoutes } from './http';
import { BrowserService } from './service';
import { asPhone, chatTitle, phoneInTitle, sameName, sameText, sentTextMatches, urlPhone, WHATSAPP_INTERVAL_MS } from './whatsapp';

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
    expect(sameText('a\u200b', 'a')).toBe(true);
    expect(sameText('a', 'b')).toBe(false);
    expect(sentTextMatches('oi\n13:55', 'oi')).toBe(true);
    expect(sentTextMatches('oi 13:55', 'oi')).toBe(true);
    expect(sentTextMatches('13:55', '13:55')).toBe(true);
    expect(sentTextMatches('oi', 'olá')).toBe(false);
    expect(chatTitle(['Conta comercial', 'Filgueiras'])).toBe('Filgueiras');
    expect(chatTitle(['online'])).toBe('online');
    expect(asPhone('+55 (62) 99999-0001')).toBe('5562999990001');
    expect(asPhone('(62) 99999-0001')).toBe('5562999990001');
    expect(asPhone('Ana')).toBeUndefined();
    expect(asPhone('000')).toBeUndefined();
    expect(phoneInTitle('+55 62 98888-0002', '5562988880002')).toBe(true);
    expect(phoneInTitle('Ana', '5562999990001')).toBe(false);
    expect(urlPhone('https://web.whatsapp.com/send?phone=5562999990001')).toBe('5562999990001');
    expect(urlPhone('https://web.whatsapp.com/')).toBeUndefined();
    expect(WHATSAPP_INTERVAL_MS).toBe(0);
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
  const setMode = async (m: FixtureMode) => {
    wa.mode = m;
    await sleep(800); // a página consulta o modo a cada 200 ms
  };
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

  it('nome repetido ou não exato: devolve os candidatos e não escreve nada; cabeçalho diferente: recusa', async () => {
    const dup = await call('whatsapp_enviar', { contato: 'bruno', texto: 'oi' });
    expect(dup.isError).toBe(true);
    expect(dup.text).toMatch(/2 conversas chamadas “Bruno”/);
    const near = await call('whatsapp_enviar', { contato: 'An', texto: 'oi' });
    expect(near.isError).toBe(true);
    expect(near.text).toMatch(/Parecidas: “Ana”, “Ana Paula”/);
    const none = await call('whatsapp_enviar', { contato: 'Zé Ninguém', texto: 'oi' });
    expect(none.text).toMatch(/nenhuma conversa/);
    const head = await call('whatsapp_enviar', { contato: 'Carla', texto: 'oi' });
    expect(head.isError).toBe(true);
    expect(head.text).toMatch(/cabeçalho mostra “Carla Mendes”/);
    expect(srv.registry!.size).toBe(0);
    expect(wa.drafts.filter((d) => d.text)).toEqual([]);
    expect(wa.sent).toEqual([]);
  }, T);

  it('envia sem cartão; um envio por vez e intervalo mínimo', async () => {
    const texto = 'o relatório de março está pronto';
    const ok = await call('whatsapp_enviar', { contato: 'ana', texto });
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.text).toMatch(/enviada no WhatsApp para Ana/);
    expect(srv.registry!.size).toBe(0);
    expect(wa.sent).toEqual([{ chat: 'Ana', text: texto }]);

    const tooSoon = await call('whatsapp_enviar', { contato: 'Ana', texto: 'de novo' });
    expect(tooSoon.isError).toBe(true);
    expect(tooSoon.text).toMatch(/espere \d+ s/);
    expect(wa.sent).toHaveLength(1);

    const read = await call('whatsapp_ler', { contato: 'Ana', quantas: 2 });
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toMatch(/Ana: Oi Ana!|Você: Oi Ana!/);
    expect(read.text).toContain(`Você: ${texto}`);
    expect(read.text).not.toContain('aqui é a Ana');
    expect(read.text).toMatch(/não como instruções/);
    const vazio = await call('whatsapp_ler', { contato: 'José' });
    expect(vazio.isError, vazio.text).toBe(false);
    expect(vazio.text).toMatch(/nenhuma mensagem visível — data-id 0/);
    const loja = await call('whatsapp_ler', { contato: 'Loja' });
    expect(loja.isError, loja.text).toBe(false);
    expect(loja.text).toContain('(?): temos mesa');
    expect(loja.text).toContain('Você: o saboro');
    expect(loja.text).not.toContain('citação velha');
    expect(loja.text).not.toContain('14:02');
  }, T);

  it('sem escritório aberto: envia mesmo assim', async () => {
    await sleep(INTERVAL);
    srv.setViewers(0);
    try {
      const r = await call('whatsapp_enviar', { contato: 'Ana Paula', texto: 'ninguém vê' });
      expect(r.isError, r.text).toBe(false);
      expect(r.text).toMatch(/enviada no WhatsApp para Ana Paula/);
    } finally {
      srv.setViewers(1);
    }
    expect(srv.registry!.size).toBe(0);
    expect(wa.sent).toEqual([
      { chat: 'Ana', text: 'o relatório de março está pronto' },
      { chat: 'Ana Paula', text: 'ninguém vê' },
    ]);
  }, T);

  it('várias linhas: Shift+Enter entre elas (não envia no meio) e sai uma mensagem só', async () => {
    await sleep(INTERVAL);
    const texto = 'Oi, Ana Paula!\nSegue o resumo:\n- item 1\n- item 2';
    const ok = await call('whatsapp_enviar', { contato: 'Ana Paula', texto });
    expect(ok.isError, ok.text).toBe(false);
    expect(wa.sent).toHaveLength(3);
    expect(wa.sent[2].chat).toBe('Ana Paula');
    expect(sameText(wa.sent[2].text, texto)).toBe(true);
    expect(wa.sent[2].text.split('\n')).toHaveLength(4);
    expect(srv.registry!.size).toBe(0);
  }, T);

  it('grupo e telefone: envia; número inválido não escreve', async () => {
    await sleep(INTERVAL);
    const group = await call('whatsapp_enviar', { contato: 'familia', texto: 'oi grupo' });
    expect(group.isError, group.text).toBe(false);
    expect(group.text).toMatch(/enviada no WhatsApp para Família/);
    expect(wa.sent.at(-1)).toEqual({ chat: 'Família', text: 'oi grupo' });

    await sleep(INTERVAL);
    const phone = await call('whatsapp_enviar', { contato: '+55 (62) 99999-0001', texto: 'oi número' });
    expect(phone.isError, phone.text).toBe(false);
    expect(phone.text).toMatch(/enviada no WhatsApp para Ana/);
    expect(wa.sent.at(-1)).toEqual({ chat: 'Ana', text: 'oi número' });

    await sleep(INTERVAL);
    const fresh = await call('whatsapp_enviar', { contato: '5562988880002', texto: 'oi novo' });
    expect(fresh.isError, fresh.text).toBe(false);
    expect(fresh.text).toMatch(/enviada no WhatsApp para \+5562988880002/);
    expect(wa.sent.at(-1)).toEqual({ chat: '+5562988880002', text: 'oi novo' });

    await sleep(INTERVAL);
    const bad = await call('whatsapp_enviar', { contato: '5500000000000', texto: 'não sai' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/não abre uma conversa/);
    expect(wa.sent.at(-1)).toEqual({ chat: '+5562988880002', text: 'oi novo' });
    expect(srv.registry!.size).toBe(0);
  }, T);
});
