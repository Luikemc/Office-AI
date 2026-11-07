// Navegador local do escritório: o servidor é o único dono de UM contexto persistente do Chrome (playwright-core,
// perfil em <dataDir>/navegador-perfil, para os logins ficarem). Cada sessão do Claude Code (pelo MCP do plugin
// mod/navegador) abre as próprias abas e só vê e mexe nelas. Ferramentas: abrir, ler, clicar, digitar, abas, fechar;
// nenhuma roda código arbitrário na página. Ações arriscadas (gate.ts) esperam o seu ok no escritório pela trava
// `Gate` (o registro de permissões); sem resposta, nada acontece.
//
// O Chrome só abre no primeiro uso. HABBLAUD_BROWSER_HEADLESS=1 abre sem janela (testes); HABBLAUD_BROWSER=0 desliga.
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { BrowserContext, Download, Locator, Page } from 'playwright-core';
import { tr } from '../../shared/i18n';
import { errMsg, log } from '../log';
import { gateReason, lockedSite, type ElementFacts } from './gate';
import { MAX_ELEMENTS, MAX_TEXT, parseRef, renderSnapshot, TYPABLE, type ElementInfo } from './snapshot';
import {
  readMessages,
  sendMessage,
  stateMessage,
  waitState,
  WA_NAME_MAX,
  WA_READ_DEFAULT,
  WA_READ_MAX,
  WA_TEXT_MAX,
  WHATSAPP_INTERVAL_MS,
  WHATSAPP_ORIGIN,
  WhatsappError,
  type WaState,
} from './whatsapp';

/** Abas por sessão. */
export const MAX_TABS_PER_SESSION = 8;
/** Tempo de uma ação (achar o elemento, esperar ele ficar clicável). */
const ACTION_TIMEOUT_MS = 10_000;
/** Tempo para carregar uma página no `abrir`. */
const GOTO_TIMEOUT_MS = 30_000;
/** Depois de cada ação: espera a página assentar (load + DOM quieto), no máximo isto. */
const SETTLE_MS = 1_500;
const QUIET_MS = 300;
const TEXT_MAX = 4_000;
const VIEWPORT = { width: 1280, height: 800 };

export type BrowserErrorCode = 'invalid' | 'not-found' | 'stale' | 'denied' | 'failed' | 'disabled' | 'too-many' | 'not-ready' | 'ambiguous';

export class BrowserError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** O que a trava recebe para montar o cartão no escritório. */
export interface GateRequest {
  sessionId: string;
  /** Ferramenta: clicar, digitar, baixar, whatsapp_enviar. */
  tool: 'clicar' | 'digitar' | 'baixar' | 'whatsapp_enviar';
  url: string;
  /** Por que travou (gate.ts). */
  reason: string;
  /** Descrição do modelo ("botão Enviar do formulário de contato"). */
  description?: string;
  /** O que a página diz do elemento (papel e nome). */
  element?: string;
  /** Texto exato a digitar (no WhatsApp: a mensagem exata). */
  text?: string;
  signal?: AbortSignal;
}

export type GateDecision = { ok: true } | { ok: false; message: string };
export type Gate = (r: GateRequest) => Promise<GateDecision>;

export interface TabView {
  id: string;
  title: string;
  url: string;
  revision: number;
}

export interface ActionResult {
  aba: TabView;
  /** Texto pronto para o modelo: cabeçalho, avisos e a página. */
  texto: string;
}

export interface BrowserOptions {
  profileDir: string;
  downloadsDir: string;
  headless?: boolean;
  /** Executável do Chrome (HABBLAUD_BROWSER_PATH); sem ele, o canal `chrome` (o Chrome instalado). */
  executablePath?: string;
  gate: Gate;
  /**
   * Origens que contam como WhatsApp Web para as ferramentas whatsapp_* (a primeira é a que se abre). Produção: só
   * https://web.whatsapp.com; os testes apontam para uma página local que imita a estrutura dele.
   */
  whatsappOrigins?: string[];
  /** Intervalo mínimo entre dois envios no WhatsApp (padrão 20 s). */
  whatsappIntervalMs?: number;
  /** Troca o lançamento (testes). */
  launch?: (profileDir: string, opts: { headless: boolean; executablePath?: string }) => Promise<BrowserContext>;
}

interface Tab {
  id: string;
  owner: string;
  page: Page;
  revision: number;
  elements: Map<string, ElementInfo>;
  queue: Promise<unknown>;
  notices: string[];
}

const SESSION_RE = /^[A-Za-z0-9._:-]{1,200}$/;
/** Dono da aba do WhatsApp aberta pelas ferramentas whatsapp_* (nenhuma sessão casa com isto: fica fora de `abas`). */
const WA_OWNER = '#whatsapp';

export interface WhatsappStatus {
  estado: WaState;
  texto: string;
}

export interface WhatsappSent {
  contato: string;
  confirmado: boolean;
  texto: string;
}

export function checkSession(sessionId: unknown): string {
  if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) throw new BrowserError('invalid', tr('sessionId inválido'));
  return sessionId;
}

/** URL que o `abrir` aceita: http(s) (sem esquema vira https). */
export function normalizeUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 4_000) throw new BrowserError('invalid', tr('url inválida'));
  let s = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new BrowserError('invalid', tr('url inválida: {0}', [raw.slice(0, 200)]));
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BrowserError('invalid', tr('só endereços http:// ou https:// (recebido {0})', [u.protocol]));
  return u.href;
}

async function defaultLaunch(profileDir: string, opts: { headless: boolean; executablePath?: string }): Promise<BrowserContext> {
  let pw: typeof import('playwright-core');
  try {
    pw = await import('playwright-core');
  } catch {
    throw new BrowserError('disabled', tr('navegador indisponível: falta o pacote playwright-core (rode npm install)'));
  }
  return pw.chromium.launchPersistentContext(profileDir, {
    ...(opts.executablePath ? { executablePath: opts.executablePath } : { channel: 'chrome' }),
    headless: opts.headless,
    viewport: VIEWPORT,
    acceptDownloads: true,
  });
}

/** Espera a página assentar depois de uma ação: load + DOM quieto, no máximo `cap`. Navegar no meio é sucesso. */
export async function settle(page: Page, cap = SETTLE_MS): Promise<void> {
  const end = Date.now() + cap;
  const left = () => Math.max(1, end - Date.now());
  try {
    await page.waitForLoadState('load', { timeout: left() });
  } catch {
    // demorou: segue com o que tem
  }
  if (page.isClosed()) return;
  const quiet = page
    .evaluate(
      ({ quietMs, maxMs }) =>
        new Promise<void>((done) => {
          let t = setTimeout(finish, quietMs);
          const stop = setTimeout(finish, maxMs);
          const mo = new MutationObserver(() => {
            clearTimeout(t);
            t = setTimeout(finish, quietMs);
          });
          function finish() {
            mo.disconnect();
            clearTimeout(t);
            clearTimeout(stop);
            done();
          }
          mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        }),
      { quietMs: QUIET_MS, maxMs: left() },
    )
    .catch(async () => {
      // Navegou no meio (contexto destruído): espera o documento novo.
      if (!page.isClosed()) await page.waitForLoadState('domcontentloaded', { timeout: left() }).catch(() => {});
    });
  await Promise.race([quiet, new Promise((r) => setTimeout(r, left() + 50))]);
}

/** Lê do elemento o que a trava precisa (no alvo de clique mais próximo: o botão em volta de um ícone, o link). */
async function readFacts(loc: Locator, el: ElementInfo): Promise<ElementFacts> {
  const raw = await loc.evaluate((node: Element) => {
    const t = (node.closest('button, input, a[href], [role=button], [role=link], [role=menuitem], summary') ?? node) as HTMLElement & { form?: HTMLFormElement | null; value?: string };
    const tag = t.tagName.toLowerCase();
    const attrType = (t.getAttribute('type') ?? '').toLowerCase();
    const type = attrType || (tag === 'button' ? 'submit' : '');
    const form = (t.form ?? t.closest('form')) as HTMLFormElement | null;
    const submits = !!form && ((tag === 'button' && type === 'submit') || (tag === 'input' && (type === 'submit' || type === 'image')));
    const pick = (...xs: Array<string | null | undefined>) =>
      xs
        .filter((x): x is string => typeof x === 'string' && !!x.trim())
        .join(' ')
        .replace(/\s+/g, ' ')
        .slice(0, 400);
    const value = tag === 'input' && /^(submit|button|image|reset)$/.test(type) ? t.value : '';
    return {
      tag,
      type,
      submits,
      inForm: !!form,
      formHint: form ? pick(form.getAttribute('aria-label'), form.getAttribute('name'), form.id, form.getAttribute('action')) : '',
      text: pick(tag === 'input' ? '' : t.innerText, value, t.getAttribute('aria-label'), t.getAttribute('title'), t.getAttribute('alt')),
      href: (t.closest('a[href]') as HTMLAnchorElement | null)?.href ?? '',
    };
  }, undefined, { timeout: ACTION_TIMEOUT_MS / 2 });
  return { role: el.role, name: el.name, ...raw };
}

function describeEl(el: ElementInfo): string {
  return el.name ? `${el.role} “${el.name}”` : el.role;
}

function timeoutLike(err: unknown): boolean {
  return /timeout|exceeded|not attached|detached|stale|no element|resolved to 0/i.test(errMsg(err));
}

export class BrowserService {
  private ctx: Promise<BrowserContext> | undefined;
  private tabs = new Map<string, Tab>();
  private byPage = new WeakMap<Page, Tab>();
  private seq = 0;
  private stopped = false;
  private waOpening: Promise<Tab> | undefined;
  private waBusy = false;
  private waLastSend = 0;

  constructor(private readonly opts: BrowserOptions) {}

  // ------------------------------------------------------------------ ferramentas

  async abrir(sessionId: string, rawUrl: unknown): Promise<ActionResult> {
    const owner = checkSession(sessionId);
    const url = normalizeUrl(rawUrl);
    if ([...this.tabs.values()].filter((t) => t.owner === owner).length >= MAX_TABS_PER_SESSION) {
      throw new BrowserError('too-many', tr('abas demais abertas nesta sessão ({0}): feche uma com `fechar`', [MAX_TABS_PER_SESSION]));
    }
    const ctx = await this.context();
    const page = await ctx.newPage();
    const tab = this.adopt(page, owner);
    return this.run(tab, async () => {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
      } catch (err) {
        tab.notices.push(tr('a página não terminou de carregar: {0}', [errMsg(err).split('\n')[0].slice(0, 200)]));
      }
      await settle(page);
      return this.view(tab);
    });
  }

  async ler(sessionId: string, tabId: unknown): Promise<ActionResult> {
    const tab = this.tab(sessionId, tabId);
    return this.run(tab, () => this.view(tab));
  }

  async clicar(sessionId: string, tabId: unknown, ref: unknown, description: unknown, signal?: AbortSignal): Promise<ActionResult> {
    const tab = this.tab(sessionId, tabId);
    return this.run(tab, async () => {
      const el = this.element(tab, ref);
      const loc = tab.page.getByRef(el.raw);
      const facts = await this.facts(loc, el);
      const url = tab.page.url();
      const reason = gateReason({ kind: 'clicar', url, element: facts });
      if (reason) await this.ask({ sessionId: tab.owner, tool: 'clicar', url, reason, description: str(description), element: describeEl(el), signal });
      try {
        await loc.click({ timeout: ACTION_TIMEOUT_MS });
      } catch (err) {
        throw this.actionError(err, tr('não deu para clicar em {0}', [describeEl(el)]));
      }
      await settle(tab.page);
      return this.view(tab);
    });
  }

  async digitar(sessionId: string, tabId: unknown, ref: unknown, text: unknown, enviar: unknown, description: unknown, signal?: AbortSignal): Promise<ActionResult> {
    const tab = this.tab(sessionId, tabId);
    if (typeof text !== 'string' || text.length > TEXT_MAX) throw new BrowserError('invalid', tr('texto inválido (até {0} caracteres)', [TEXT_MAX]));
    const submit = enviar === true;
    return this.run(tab, async () => {
      const el = this.element(tab, ref);
      if (!TYPABLE.has(el.role)) throw new BrowserError('invalid', tr('{0} não é um campo de texto: escolha um textbox, searchbox ou combobox da última leitura', [describeEl(el)]));
      const loc = tab.page.getByRef(el.raw);
      const facts = await this.facts(loc, el);
      const url = tab.page.url();
      const reason = gateReason({ kind: 'digitar', url, element: facts, enviar: submit });
      if (reason) await this.ask({ sessionId: tab.owner, tool: 'digitar', url, reason, description: str(description), element: describeEl(el), text, signal });
      try {
        await loc.fill(text, { timeout: ACTION_TIMEOUT_MS });
        if (submit) await loc.press('Enter', { timeout: ACTION_TIMEOUT_MS });
      } catch (err) {
        throw this.actionError(err, tr('não deu para digitar em {0}', [describeEl(el)]));
      }
      await settle(tab.page);
      return this.view(tab);
    });
  }

  async abas(sessionId: string): Promise<TabView[]> {
    const owner = checkSession(sessionId);
    const mine = [...this.tabs.values()].filter((t) => t.owner === owner && !t.page.isClosed());
    return Promise.all(mine.map(async (t) => ({ id: t.id, title: await t.page.title().catch(() => ''), url: t.page.url(), revision: t.revision })));
  }

  async fechar(sessionId: string, tabId: unknown): Promise<{ fechada: string }> {
    const tab = this.tab(sessionId, tabId);
    this.tabs.delete(tab.id);
    await tab.page.close().catch(() => {});
    return { fechada: tab.id };
  }

  /** JPEG da aba (a pedida ou a mais nova da sessão), para o escritório mostrar. */
  async screenshot(sessionId: string, tabId?: unknown): Promise<Buffer> {
    const owner = checkSession(sessionId);
    const tab = tabId !== undefined ? this.tab(owner, tabId) : [...this.tabs.values()].filter((t) => t.owner === owner).at(-1);
    if (!tab) throw new BrowserError('not-found', tr('esta sessão não tem aba aberta'));
    return this.run(tab, () => tab.page.screenshot({ type: 'jpeg', quality: 60, timeout: ACTION_TIMEOUT_MS }));
  }

  // ------------------------------------------------------------------ WhatsApp (whatsapp.ts)

  /** Conectado? QR na tela? Outra janela? Navegador incompatível? */
  async whatsappStatus(sessionId: string): Promise<WhatsappStatus> {
    checkSession(sessionId);
    return this.withWhatsapp(async (page) => {
      const estado = await waitState(page);
      return { estado, texto: stateMessage(estado, !!this.opts.headless) };
    });
  }

  /** Lê as últimas mensagens de uma conversa individual (sem trava: só leitura). */
  async whatsappLer(sessionId: string, contato: unknown, quantas: unknown): Promise<{ contato: string; texto: string; mensagens: unknown[] }> {
    checkSession(sessionId);
    const name = waName(contato);
    const n = quantas === undefined ? WA_READ_DEFAULT : Number(quantas);
    if (!Number.isInteger(n) || n < 1 || n > WA_READ_MAX) throw new BrowserError('invalid', tr('quantas: de 1 a {0}', [WA_READ_MAX]));
    return this.withWhatsapp((page) => readMessages(page, name, n, !!this.opts.headless));
  }

  /**
   * Manda `texto` para a conversa individual `contato`: acha a conversa, confere o cabeçalho, escreve, pede o ok no
   * escritório (cartão com o nome do cabeçalho e o texto exato) e só então aperta Enter. Um envio por vez e um
   * intervalo mínimo entre envios.
   */
  async whatsappEnviar(sessionId: string, contato: unknown, texto: unknown, signal?: AbortSignal): Promise<WhatsappSent> {
    const owner = checkSession(sessionId);
    const name = waName(contato);
    if (typeof texto !== 'string' || !texto.trim() || texto.length > WA_TEXT_MAX) throw new BrowserError('invalid', tr('texto inválido (1 a {0} caracteres)', [WA_TEXT_MAX]));
    if (this.waBusy) throw new BrowserError('too-many', tr('já há um envio no WhatsApp em andamento: espere ele terminar (um por vez).'));
    const interval = this.opts.whatsappIntervalMs ?? WHATSAPP_INTERVAL_MS;
    const wait = this.waLastSend + interval - Date.now();
    if (wait > 0) throw new BrowserError('too-many', tr('espere {0} s antes do próximo envio no WhatsApp (mínimo de {1} s entre mensagens).', [Math.ceil(wait / 1000), Math.round(interval / 1000)]));
    this.waBusy = true;
    try {
      return await this.withWhatsapp((page) =>
        sendMessage(page, name, texto, {
          headless: !!this.opts.headless,
          onSend: () => {
            this.waLastSend = Date.now();
          },
          ask: async (shown, text) => {
            try {
              return await this.opts.gate({ sessionId: owner, tool: 'whatsapp_enviar', url: page.url(), reason: tr('enviar uma mensagem no WhatsApp'), element: shown, text, signal });
            } catch (err) {
              return { ok: false, message: tr('a trava falhou ({0}); nada foi feito', [errMsg(err)]) };
            }
          },
        }),
      );
    } finally {
      this.waBusy = false;
    }
  }

  /** É uma página do WhatsApp Web (pelas origens configuradas)? */
  isWhatsapp(url: string): boolean {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return false;
    }
    return this.waOrigins().includes(origin);
  }

  private waOrigins(): string[] {
    const list = (this.opts.whatsappOrigins ?? [WHATSAPP_ORIGIN]).map((o) => new URL(o).origin);
    return list.length ? list : [WHATSAPP_ORIGIN];
  }

  /** Roda `fn` na fila da aba do WhatsApp (a que já está aberta no perfil, ou uma nova). */
  private async withWhatsapp<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const tab = await this.whatsappTab();
    return this.run(tab, async () => {
      if (tab.page.isClosed()) throw new BrowserError('not-found', tr('a aba do WhatsApp fechou: chame de novo'));
      await tab.page.bringToFront().catch(() => {});
      try {
        return await fn(tab.page);
      } catch (err) {
        if (err instanceof WhatsappError) throw new BrowserError(err.code, err.message);
        throw this.actionError(err, tr('o WhatsApp Web não respondeu como esperado'));
      } finally {
        // Se a aba é de uma sessão, as refs da última leitura dela não valem mais.
        tab.elements = new Map();
      }
    });
  }

  private whatsappTab(): Promise<Tab> {
    for (const t of this.tabs.values()) if (!t.page.isClosed() && this.isWhatsapp(t.page.url())) return Promise.resolve(t);
    if (!this.waOpening) {
      const p = (async () => {
        const ctx = await this.context();
        const loose = ctx.pages().find((pg) => !pg.isClosed() && !this.byPage.has(pg) && this.isWhatsapp(pg.url()));
        if (loose) return this.adopt(loose, WA_OWNER);
        const page = await ctx.newPage();
        const tab = this.adopt(page, WA_OWNER);
        try {
          await page.goto(`${this.waOrigins()[0]}/`, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
        } catch (err) {
          if (page.isClosed()) throw new BrowserError('failed', tr('não deu para abrir o WhatsApp Web: {0}', [errMsg(err).split('\n')[0].slice(0, 200)]));
        }
        return tab;
      })();
      this.waOpening = p;
      void p.finally(() => {
        if (this.waOpening === p) this.waOpening = undefined;
      }).catch(() => {});
    }
    return this.waOpening;
  }

  /** Abas abertas (todas as sessões). */
  get size(): number {
    return this.tabs.size;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const ctx = this.ctx;
    this.ctx = undefined;
    this.tabs.clear();
    if (ctx) await ctx.then((c) => c.close()).catch(() => {});
  }

  // ------------------------------------------------------------------ internos

  private context(): Promise<BrowserContext> {
    if (this.stopped) return Promise.reject(new BrowserError('disabled', tr('navegador desligado')));
    if (!this.ctx) {
      const started = this.launch();
      this.ctx = started;
      started.catch(() => {
        if (this.ctx === started) this.ctx = undefined;
      });
    }
    return this.ctx;
  }

  private async launch(): Promise<BrowserContext> {
    mkdirSync(this.opts.profileDir, { recursive: true });
    const launch = this.opts.launch ?? defaultLaunch;
    let ctx: BrowserContext;
    try {
      ctx = await launch(this.opts.profileDir, { headless: !!this.opts.headless, executablePath: this.opts.executablePath });
    } catch (err) {
      if (err instanceof BrowserError) throw err;
      const msg = errMsg(err).split('\n')[0].slice(0, 300);
      log.warn(tr('Navegador: não abriu o Chrome ({0}).', [msg]));
      throw new BrowserError('failed', tr('não deu para abrir o Chrome: {0}', [msg]));
    }
    log.info(tr('Navegador: Chrome aberto (perfil em {0}).', [this.opts.profileDir]));
    ctx.on('close', () => {
      // Janela fechada à mão ou Chrome caiu: as abas somem e o próximo uso abre de novo.
      this.ctx = undefined;
      this.tabs.clear();
    });
    ctx.on('download', (d) => void this.onDownload(d));
    return ctx;
  }

  private adopt(page: Page, owner: string): Tab {
    const tab: Tab = { id: `t${++this.seq}`, owner, page, revision: 0, elements: new Map(), queue: Promise.resolve(), notices: [] };
    this.tabs.set(tab.id, tab);
    this.byPage.set(page, tab);
    page.on('close', () => {
      if (this.tabs.get(tab.id) === tab) this.tabs.delete(tab.id);
    });
    page.on('popup', (popup) => {
      if (this.tabs.get(tab.id) !== tab) return;
      const child = this.adopt(popup, owner);
      tab.notices.push(tr('a página abriu uma aba nova: {0} (use `ler` com tabId "{0}")', [child.id]));
    });
    page.on('dialog', (dialog) => {
      tab.notices.push(tr('a página mostrou um aviso ({0}): “{1}” — fechado sem confirmar', [dialog.type(), dialog.message().slice(0, 300)]));
      const d = dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss();
      d.catch(() => {});
    });
    return tab;
  }

  private tab(sessionId: string, tabId: unknown): Tab {
    const owner = checkSession(sessionId);
    const t = typeof tabId === 'string' ? this.tabs.get(tabId) : undefined;
    // Aba de outra sessão = aba que não existe (não conta que ela existe).
    if (!t || t.owner !== owner || t.page.isClosed()) throw new BrowserError('not-found', tr('aba desconhecida: {0} (veja `abas`)', [String(tabId).slice(0, 40)]));
    return t;
  }

  private run<T>(tab: Tab, fn: () => Promise<T>): Promise<T> {
    const next = tab.queue.then(fn, fn);
    tab.queue = next.catch(() => {});
    return next;
  }

  private element(tab: Tab, ref: unknown): ElementInfo {
    const parsed = typeof ref === 'string' ? parseRef(ref) : undefined;
    if (!parsed) throw new BrowserError('invalid', tr('ref inválida: use uma ref da última leitura (ex.: r3-e7)'));
    if (parsed.revision !== tab.revision) {
      throw new BrowserError('stale', tr('ref {0} é de uma leitura antiga (a aba está na revisão {1}): faça `ler` de novo', [String(ref), tab.revision]));
    }
    const el = tab.elements.get(String(ref).trim());
    if (!el) throw new BrowserError('not-found', tr('ref {0} não existe na última leitura: faça `ler` de novo', [String(ref)]));
    return el;
  }

  private async facts(loc: Locator, el: ElementInfo): Promise<ElementFacts> {
    try {
      return await readFacts(loc, el);
    } catch (err) {
      throw this.actionError(err, tr('{0} não está mais na página', [describeEl(el)]));
    }
  }

  private actionError(err: unknown, what: string): BrowserError {
    if (err instanceof BrowserError) return err;
    const first = errMsg(err).split('\n')[0].slice(0, 300);
    return timeoutLike(err) ? new BrowserError('stale', tr('{0} ({1}): faça `ler` de novo', [what, first])) : new BrowserError('failed', `${what}: ${first}`);
  }

  private async ask(r: GateRequest): Promise<void> {
    let d: GateDecision;
    try {
      d = await this.opts.gate(r);
    } catch (err) {
      d = { ok: false, message: tr('a trava falhou ({0}); nada foi feito', [errMsg(err)]) };
    }
    if (!d.ok) throw new BrowserError('denied', d.message);
  }

  /** Nova leitura da aba: revisão nova, refs novas, texto pronto. */
  private async view(tab: Tab): Promise<ActionResult> {
    const page = tab.page;
    if (page.isClosed()) {
      this.tabs.delete(tab.id);
      throw new BrowserError('not-found', tr('a aba {0} fechou', [tab.id]));
    }
    let tree: unknown;
    try {
      tree = await page.ariaSnapshotJSON({ mode: 'ai', boxes: true, timeout: ACTION_TIMEOUT_MS });
    } catch {
      // Navegando: espera o documento novo e tenta mais uma vez.
      await page.waitForLoadState('domcontentloaded', { timeout: ACTION_TIMEOUT_MS }).catch(() => {});
      tree = await page.ariaSnapshotJSON({ mode: 'ai', boxes: true, timeout: ACTION_TIMEOUT_MS }).catch(() => []);
    }
    tab.revision++;
    const snap = renderSnapshot(tree, tab.revision, page.viewportSize());
    tab.elements = snap.elements;
    const title = await page.title().catch(() => '');
    const aba: TabView = { id: tab.id, title, url: page.url(), revision: tab.revision };
    const notices = tab.notices.splice(0);
    const head = [
      tr('Aba {0} · revisão {1}', [aba.id, aba.revision]),
      tr('Título: {0}', [title || '—']),
      `URL: ${aba.url}`,
      ...(lockedSite(aba.url) ? [tr('Atenção: neste site toda ação que altera a página espera a aprovação do usuário no escritório.')] : []),
      ...notices.map((n) => tr('Aviso: {0}', [n])),
      snap.truncated ? tr('(página grande: cortada em {0} caracteres / {1} elementos com ref)', [MAX_TEXT, MAX_ELEMENTS]) : '',
      '',
    ].filter((l, i, all) => l !== '' || i === all.length - 1);
    return { aba, texto: `${head.join('\n')}\n${snap.text || tr('(página vazia)')}` };
  }

  private async onDownload(d: Download): Promise<void> {
    let tab: Tab | undefined;
    try {
      tab = this.byPage.get(d.page());
    } catch {
      tab = undefined;
    }
    const name = basename(d.suggestedFilename() || 'download').replace(/[^\w.\- ()À-ÿ]/g, '_').slice(0, 120) || 'download';
    if (!tab || this.tabs.get(tab.id) !== tab) {
      await d.cancel().catch(() => {});
      return;
    }
    const decision = await this.opts
      .gate({ sessionId: tab.owner, tool: 'baixar', url: d.url(), reason: tr('baixar um arquivo'), element: name })
      .catch((err): GateDecision => ({ ok: false, message: errMsg(err) }));
    if (!decision.ok) {
      await d.cancel().catch(() => {});
      tab.notices.push(tr('download de {0} cancelado: {1}', [name, decision.message]));
      return;
    }
    try {
      mkdirSync(this.opts.downloadsDir, { recursive: true });
      const dest = join(this.opts.downloadsDir, `${Date.now().toString(36)}-${name}`);
      await d.saveAs(dest);
      tab.notices.push(tr('download salvo em {0}', [dest]));
    } catch (err) {
      tab.notices.push(tr('download de {0} falhou: {1}', [name, errMsg(err)]));
    }
  }
}

function waName(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > WA_NAME_MAX) throw new BrowserError('invalid', tr('contato inválido: o nome da conversa como aparece no WhatsApp (até {0} caracteres)', [WA_NAME_MAX]));
  return v.trim();
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : undefined;
}

