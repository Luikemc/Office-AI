// O navegador do escritório num "sistema interno" de verdade (server/test/sistema-fixture.ts, local): login pelo
// usuário (pedir_ajuda; senha o modelo não digita), navegar/voltar, menu de passar o mouse, tabela longa (rolar e ler
// parte), <select>, esperar uma página lenta, ver_tela (JPEG) e a trava no modo equilibrado: Enter num campo e Salvar
// rodam direto, enviar_arquivo (só da pasta do projeto) e "Excluir cliente" pedem, "Permitir e confiar neste site"
// solta o próximo upload e o modo cauteloso volta a pedir o Salvar. Chrome do sistema sem janela; pula se não houver
// Chrome. Nunca acessa a internet.
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { MAIN, request, SESSION, servePermissions, type PermissionServer } from '../test/permission-server';
import { CREDENCIAIS, startSistemaExemplo, type SistemaExemplo } from '../test/sistema-fixture';
import { registryGate } from './approval';
import { createBrowserRoutes } from './http';
import { BrowserService } from './service';

setQuiet(true);

const CHROME = process.env.HABBLAUD_BROWSER_PATH || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'].find((p) => existsSync(p));
const T = 90_000;

type Content = { type: string; text?: string; data?: string; mimeType?: string };
type Mcp = { callTool: (name: string, args: unknown, opts: { env: NodeJS.ProcessEnv; signal?: AbortSignal }) => Promise<{ content: Content[]; isError?: boolean }> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!CHROME)('navegador num sistema interno (Sistema Exemplo, Chrome sem janela)', () => {
  let srv: PermissionServer;
  let app: SistemaExemplo;
  let browser: BrowserService;
  let mcp: Mcp;
  let dir: string;
  let project: string;
  let env: NodeJS.ProcessEnv;
  let tab = '';

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await mcp.callTool(name, args, { env: { ...env, HABBLAUD_NAVEGADOR_SESSION: SESSION } });
    return { text: r.content.map((c) => c.text ?? '').join('\n'), content: r.content, isError: !!r.isError };
  };
  const refOf = (text: string, re: RegExp) => {
    const m = re.exec(text);
    if (!m) throw new Error(`ref não achada (${re}) em:\n${text.slice(0, 3000)}`);
    return m[1];
  };
  const R = '\\[ref=(r\\d+-(?:f\\d+)?e\\d+)\\]';
  const ref = (text: string, what: string) => refOf(text, new RegExp(`${what}[^\\n]*${R}`));
  const pending = async () => {
    for (let i = 0; i < 300; i++) {
      const p = srv.registry!.snapshot().get(MAIN);
      if (p) return p;
      await sleep(50);
    }
    throw new Error('nenhum pedido apareceu');
  };
  const decide = async (id: string, behavior: 'allow' | 'deny') => {
    expect((await request(srv.base, `/api/permissions/${id}/decision`, { method: 'POST', body: { behavior } })).status).toBe(200);
  };
  const pageOf = (id: string) => (browser as unknown as { tabs: Map<string, { page: Page }> }).tabs.get(id)!.page;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'habblaud-sistema-'));
    project = join(dir, 'projeto');
    mkdirSync(join(project, 'docs'), { recursive: true });
    writeFileSync(join(project, 'docs', 'contrato.txt'), 'contrato de teste\n');
    writeFileSync(join(dir, 'segredo.txt'), 'fora do projeto\n');
    symlinkSync(join(dir, 'segredo.txt'), join(project, 'atalho.txt'));
    app = await startSistemaExemplo();
    srv = await servePermissions({
      browser: (registry) => {
        browser = new BrowserService({
          profileDir: join(dir, 'perfil'),
          downloadsDir: join(dir, 'downloads'),
          headless: true,
          executablePath: CHROME,
          gate: registryGate(registry, 4748),
          projectDir: (sid) => (sid === SESSION ? project : undefined),
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
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  }, T);

  it('login: senha digita no campo; pedir_ajuda sem escritório → instrução; com escritório → o usuário entra e volta a leitura', async () => {
    const open = await call('abrir', { url: `${app.base}/painel` });
    expect(open.isError, open.text).toBe(false);
    expect(open.text).toMatch(/Título: Entrar · Sistema Exemplo/);
    tab = /Aba (t\d+)/.exec(open.text)![1];

    const senha = ref(open.text, 'textbox "Senha"');
    const typed = await call('digitar', { tabId: tab, ref: senha, texto: 'qualquer' });
    expect(typed.isError, typed.text).toBe(false);
    expect(await pageOf(tab).inputValue('input[name=senha]')).toBe('qualquer');
    expect(srv.registry!.size).toBe(0);

    srv.setViewers(0);
    const alone = await call('pedir_ajuda', { tabId: tab, motivo: 'login no Sistema Exemplo' });
    expect(alone.isError, alone.text).toBe(false);
    expect(alone.text).toMatch(/Peça ao usuário.*Chrome.*`ler`/s);
    srv.setViewers(1);

    const help = call('pedir_ajuda', { tabId: tab, motivo: 'login no Sistema Exemplo' });
    const p = await pending();
    expect(p.tool).toBe('mcp__navegador__pedir_ajuda');
    expect(p.text).toMatch(/Ajuda no navegador: login no Sistema Exemplo/);
    expect(srv.office.commit().snapshot.agents.find((a) => a.id === MAIN)?.status).toBe('waiting');
    // O "usuário" entra na janela do Chrome.
    const page = pageOf(tab);
    await page.fill('input[name=usuario]', CREDENCIAIS.usuario);
    await page.fill('input[name=senha]', CREDENCIAIS.senha);
    await Promise.all([page.waitForURL(/\/painel/), page.click('button')]);
    await decide(p.id, 'allow');
    const done = await help;
    expect(done.isError, done.text).toBe(false);
    expect(done.text).toMatch(/Título: Painel/);
    expect(done.text).toMatch(/o usuário disse que terminou/);
    expect(app.logins).toBe(1);
  }, T);

  it('menu de passar o mouse; clicar no item; navegar, voltar e avançar na mesma aba', async () => {
    const painel = await call('ler', { tabId: tab });
    expect(painel.text).not.toMatch(/menuitem "Clientes"/);
    const hover = await call('passar_mouse', { tabId: tab, ref: ref(painel.text, 'button "Cadastros"') });
    expect(hover.isError, hover.text).toBe(false);
    expect(hover.text).toMatch(/menuitem "Novo cliente"/);
    const novo = await call('clicar', { tabId: tab, ref: ref(hover.text, 'menuitem "Novo cliente"'), elemento: 'item Novo cliente do menu' });
    expect(novo.isError, novo.text).toBe(false);
    expect(novo.text).toMatch(/Título: Novo cliente/);

    const back = await call('navegar', { tabId: tab, acao: 'voltar' });
    expect(back.text).toMatch(/Título: Painel/);
    const fwd = await call('navegar', { tabId: tab, acao: 'avancar' });
    expect(fwd.text).toMatch(/Título: Novo cliente/);
    const go = await call('navegar', { tabId: tab, url: `${app.base}/clientes` });
    expect(go.text).toMatch(/Título: Clientes/);
    expect((await call('abas')).text.trim().split('\n')).toHaveLength(1);
    const bad = await call('navegar', { tabId: tab, url: 'file:///etc/passwd' });
    expect(bad.isError).toBe(true);
  }, T);

  it('tabela longa: a leitura avisa que há mais; ler parte N chega à linha 300; rolar até o fim também', async () => {
    const first = await call('ler', { tabId: tab });
    expect(first.text).toMatch(/há mais: use `rolar` ou `ler` com parte 1 a (\d+)/);
    const parts = Number(/parte 1 a (\d+)/.exec(first.text)![1]);
    expect(parts).toBeGreaterThan(1);
    expect(first.text).not.toMatch(/Cliente 300/);
    const last = await call('ler', { tabId: tab, parte: parts });
    expect(last.text).toMatch(new RegExp(`Parte ${parts} de ${parts}`));
    expect(last.text).toMatch(/Cliente 300/);
    expect(last.text).toMatch(/fim da página/);
    const p1 = await call('ler', { tabId: tab, parte: 1 });
    expect(p1.text).toMatch(/há mais: use `ler` com parte 2/);
    expect(p1.text).toMatch(/Cliente 001/);

    let r = { text: '' };
    for (let i = 0; i < 40 && !/até o fim|já estava no fim/.test(r.text); i++) r = await call('rolar', { tabId: tab, direcao: 'baixo', quanto: 'pagina' });
    expect(r.text).toMatch(/até o fim|já estava no fim/);
    const onScreen = r.text.split('# fora da tela')[0];
    expect(onScreen).toMatch(/Cliente 300/);
    const up = await call('rolar', { tabId: tab, direcao: 'cima' });
    expect(up.text).toMatch(/rolou a página/);
  }, T);

  it('esperar: o texto da página lenta aparece; espera fixa; ver_tela devolve um JPEG', async () => {
    const slow = await call('navegar', { tabId: tab, url: `${app.base}/relatorio` });
    expect(slow.text).toMatch(/Carregando relatório/);
    const w = await call('esperar', { tabId: tab, texto: 'relatório pronto' });
    expect(w.isError, w.text).toBe(false);
    expect(w.text).toMatch(/apareceu na página/);
    expect(w.text).toMatch(/42 pedidos/);
    const gone = await call('esperar', { tabId: tab, texto: 'Carregando', sumir: true, ms: 1000 });
    expect(gone.text).toMatch(/sumiu da página/);
    const never = await call('esperar', { tabId: tab, texto: 'nunca vai aparecer', ms: 600 });
    expect(never.text).toMatch(/não apareceu/);
    const fixed = await call('esperar', { tabId: tab, ms: 200 });
    expect(fixed.isError, fixed.text).toBe(false);

    await call('navegar', { tabId: tab, url: `${app.base}/grafico` });
    const shot = await call('ver_tela', { tabId: tab });
    expect(shot.isError, shot.text).toBe(false);
    const img = shot.content.find((c) => c.type === 'image')!;
    expect(img.mimeType).toBe('image/jpeg');
    const buf = Buffer.from(img.data!, 'base64');
    expect(buf.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(buf.length).toBeLessThan(400_000);
    expect(shot.text).toMatch(/Tela da aba/);
  }, T);

  it('formulário (modo equilibrado): selecionar UF; Enter no campo e Salvar rodam direto; enviar_arquivo só do projeto e com aprovação', async () => {
    browser.config.update({ modo: 'equilibrado' });
    expect(browser.config.get().modo).toBe('equilibrado');
    let r = await call('navegar', { tabId: tab, url: `${app.base}/clientes/novo` });
    const before = app.cadastros.length;

    // <select> nativo pelo texto; opção que não existe lista as opções; campo que não é select dá a dica.
    r = await call('selecionar', { tabId: tab, ref: ref(r.text, 'combobox "UF"'), valores: ['São Paulo'], elemento: 'UF' });
    expect(r.isError, r.text).toBe(false);
    expect(await pageOf(tab).inputValue('select[name=uf]')).toBe('SP');
    const wrong = await call('selecionar', { tabId: tab, ref: ref(r.text, 'combobox "UF"'), valores: ['Atlântida'] });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toMatch(/opção não encontrada.*São Paulo/s);
    r = await call('ler', { tabId: tab });
    const notSelect = await call('selecionar', { tabId: tab, ref: ref(r.text, 'textbox "Nome"'), valores: ['x'] });
    expect(notSelect.text).toMatch(/não é uma lista <select>.*clicar/s);
    r = await call('ler', { tabId: tab });

    r = await call('digitar', { tabId: tab, ref: ref(r.text, 'textbox "Nome"'), texto: 'Rascunho Enter', elemento: 'campo Nome' });
    expect(r.isError, r.text).toBe(false);
    r = await call('tecla', { tabId: tab, tecla: 'Tab' });
    expect(r.isError, r.text).toBe(false);
    // Enter num campo de formulário comum: roda sem cartão (envia o cadastro).
    r = await call('tecla', { tabId: tab, tecla: 'Enter', ref: ref(r.text, 'textbox "Nome"'), elemento: 'campo Nome' });
    expect(r.isError, r.text).toBe(false);
    expect(srv.registry!.size).toBe(0);
    expect(r.text).toMatch(/Título: Cliente salvo/);
    expect(app.cadastros.length).toBe(before + 1);
    expect(app.cadastros.at(-1)).toMatchObject({ nome: 'Rascunho Enter', uf: 'SP' });
    const badKey = await call('tecla', { tabId: tab, tecla: 'Enter; rm' });
    expect(badKey.isError).toBe(true);

    r = await call('navegar', { tabId: tab, url: `${app.base}/clientes/novo` });
    r = await call('digitar', { tabId: tab, ref: ref(r.text, 'textbox "Nome"'), texto: 'Maria Teste', elemento: 'campo Nome' });
    r = await call('selecionar', { tabId: tab, ref: ref(r.text, 'combobox "UF"'), valores: ['SP'] });

    // enviar_arquivo: fora do projeto, "..", link para fora e arquivo que não existe são recusados sem cartão.
    const docRef = ref(r.text, '"Documento"');
    for (const caminhos of [[join(dir, 'segredo.txt')], ['../segredo.txt'], ['atalho.txt'], ['nao-existe.pdf']]) {
      const out = await call('enviar_arquivo', { tabId: tab, ref: docRef, caminhos });
      expect(out.isError, `${caminhos}: ${out.text}`).toBe(true);
      expect(out.text).toMatch(/fora da pasta|não encontrado|"\.\."/);
    }
    expect(srv.registry!.size).toBe(0);

    // Dentro do projeto, site não confiável: cartão com os arquivos, o site e a oferta de confiar. Recusado → nada; aprovado → escolhido.
    const up1 = call('enviar_arquivo', { tabId: tab, ref: docRef, caminhos: ['docs/contrato.txt'], elemento: 'campo Documento' });
    const pu = await pending();
    expect(pu.tool).toBe('mcp__navegador__enviar_arquivo');
    expect(pu.trustSite).toBe(`127.0.0.1:${app.port}`);
    const detail = (await request(srv.base, `/api/permissions/${pu.id}`)).json as { input: string };
    expect(detail.input).toMatch(/docs\/contrato\.txt \(18 B\)/);
    expect(detail.input).toMatch(/Site: http:\/\/127\.0\.0\.1/);
    await decide(pu.id, 'deny');
    expect((await up1).text).toMatch(/RECUSADO/);
    expect(await pageOf(tab).evaluate(() => (document.querySelector('input[type=file]') as HTMLInputElement).files?.length ?? 0)).toBe(0);
    r = await call('ler', { tabId: tab });
    const up2 = call('enviar_arquivo', { tabId: tab, ref: ref(r.text, '"Documento"'), caminhos: ['docs/contrato.txt'], elemento: 'campo Documento' });
    await decide((await pending()).id, 'allow');
    r = await up2;
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/arquivos escolhidos: docs\/contrato\.txt/);
    expect(browser.config.get().sitesConfiaveis).toEqual([]);

    // Checkbox e Salvar rodam direto no equilibrado.
    r = await call('clicar', { tabId: tab, ref: ref(r.text, 'checkbox "Cliente ativo"'), elemento: 'Cliente ativo' });
    expect(r.isError, r.text).toBe(false);
    const saved = await call('clicar', { tabId: tab, ref: ref(r.text, 'button "Salvar"'), elemento: 'botão Salvar do cadastro' });
    expect(saved.isError, saved.text).toBe(false);
    expect(srv.registry!.size).toBe(0);
    expect(saved.text).toMatch(/Cliente salvo/);
    expect(app.cadastros.at(-1)).toMatchObject({ nome: 'Maria Teste', uf: 'SP', ativo: true, arquivo: { nome: 'contrato.txt', tamanho: 18 } });

    // "Excluir cliente" (destrutivo) pede; recusado → nada excluído.
    const del = call('clicar', { tabId: tab, ref: ref(saved.text, 'button "Excluir cliente"'), elemento: 'botão Excluir cliente' });
    const pd = await pending();
    expect(pd.tool).toBe('mcp__navegador__clicar');
    expect(pd.trustSite).toBe(`127.0.0.1:${app.port}`);
    expect((await request(srv.base, `/api/permissions/${pd.id}`)).json).toMatchObject({ input: expect.stringMatching(/excluir, apagar ou cancelar/) });
    await decide(pd.id, 'deny');
    expect((await del).text).toMatch(/RECUSADO/);
    expect(app.exclusoes).toEqual([]);
  }, T);

  it('"Permitir e confiar neste site": o próximo upload no mesmo site roda direto; cauteloso volta a pedir o Salvar', async () => {
    let r = await call('navegar', { tabId: tab, url: `${app.base}/clientes/novo` });
    const up = call('enviar_arquivo', { tabId: tab, ref: ref(r.text, '"Documento"'), caminhos: ['docs/contrato.txt'], elemento: 'campo Documento' });
    const p = await pending();
    expect((await request(srv.base, `/api/permissions/${p.id}/decision`, { method: 'POST', body: { behavior: 'allow', trustSite: true } })).status).toBe(200);
    r = await up;
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/marcou 127\.0\.0\.1:\d+ como site confiável/);
    expect(browser.config.get().sitesConfiaveis).toEqual([`127.0.0.1:${app.port}`]);

    // Próximo upload no mesmo site: sem cartão.
    r = await call('navegar', { tabId: tab, url: `${app.base}/clientes/novo` });
    r = await call('enviar_arquivo', { tabId: tab, ref: ref(r.text, '"Documento"'), caminhos: ['docs/contrato.txt'], elemento: 'campo Documento' });
    expect(r.isError, r.text).toBe(false);
    expect(srv.registry!.size).toBe(0);
    expect(r.text).toMatch(/arquivos escolhidos: docs\/contrato\.txt/);

    // Modo cauteloso e sem sites confiáveis (como nas configurações): Salvar volta a pedir, na hora.
    browser.config.update({ modo: 'cauteloso', sitesConfiaveis: [] });
    r = await call('digitar', { tabId: tab, ref: ref(r.text, 'textbox "Nome"'), texto: 'Cauteloso', elemento: 'campo Nome' });
    const before = app.cadastros.length;
    const save = call('clicar', { tabId: tab, ref: ref(r.text, 'button "Salvar"'), elemento: 'botão Salvar' });
    const ps = await pending();
    expect(ps.trustSite).toBe(`127.0.0.1:${app.port}`);
    await decide(ps.id, 'deny');
    expect((await save).text).toMatch(/RECUSADO/);
    expect(app.cadastros.length).toBe(before);
    browser.config.update({ modo: 'equilibrado' });
  }, T);
});
