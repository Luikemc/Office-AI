// Navegador local do escritório: o servidor é o único dono de UM contexto persistente do Chrome (playwright-core,
// perfil em <dataDir>/navegador-perfil, para os logins ficarem). Cada sessão do Claude Code (pelo MCP do plugin
// mod/navegador) abre as próprias abas e só vê e mexe nelas. Ferramentas: abrir, navegar, ler (com `parte` para
// páginas longas), rolar, clicar, digitar, tecla, selecionar, passar_mouse, esperar, ver_tela, enviar_arquivo,
// pedir_ajuda, abas, fechar; nenhuma roda código arbitrário na página. Ações arriscadas (gate.ts) esperam o seu ok no
// escritório pela trava `Gate` (o registro de permissões); sem resposta, nada acontece. Senha o modelo nunca digita:
// login, captcha, código e QR são com o usuário (`pedir_ajuda`, o mesmo cartão da trava).
//
// O Chrome só abre no primeiro uso. HABBLAUD_BROWSER_HEADLESS=1 abre sem janela (testes); HABBLAUD_BROWSER=0 desliga.
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BrowserContext, Download, FileChooser, Locator, Page } from 'playwright-core';
import { tr } from '../../shared/i18n';
import { errMsg, log } from '../log';
import { gateReason, hostOf, lockedSite, normalize, type ElementFacts } from './gate';
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
/** `esperar` por um texto: no máximo isto. */
export const WAIT_TEXT_MAX_MS = 30_000;
/** `esperar` um tempo fixo: no máximo isto. */
export const WAIT_FIXED_MAX_MS = 10_000;
/** `pedir_ajuda`: quanto espera o usuário terminar na janela do Chrome. */
export const HELP_TIMEOUT_MS = 15 * 60_000;
/** `ver_tela`: maior pedaço fotografado de um elemento. */
const SHOT_MAX = { width: 1280, height: 1600 };
const SHOT_QUALITY = 60;
/** `enviar_arquivo`: arquivos por vez e tamanho de cada um. */
export const UPLOAD_MAX_FILES = 10;
export const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
/** `selecionar`: opções por vez. */
const SELECT_MAX = 20;
/** Teclas: nomes do Playwright (Enter, Tab, ArrowDown, F5, Control+a...) ou um caractere. */
const KEY_RE = /^(?:(?:Control|Shift|Alt|Meta|ControlOrMeta)\+){0,3}(?:[A-Za-z][A-Za-z0-9]{0,19}|[!-~])$/;

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
  /** Ferramenta: clicar, digitar, tecla, selecionar, enviar_arquivo, baixar, whatsapp_enviar; `ajuda` = pedir_ajuda. */
  tool: 'clicar' | 'digitar' | 'tecla' | 'selecionar' | 'enviar_arquivo' | 'baixar' | 'whatsapp_enviar' | 'ajuda';
  url: string;
  /** Por que travou (gate.ts). */
  reason: string;
  /** Descrição do modelo ("botão Enviar do formulário de contato"). */
  description?: string;
  /** O que a página diz do elemento (papel e nome). */
  element?: string;
  /** Texto exato a digitar (no WhatsApp: a mensagem exata; em `tecla`, a tecla; em `ajuda`, o motivo). */
  text?: string;
  /** enviar_arquivo: os arquivos (caminho relativo ao projeto e tamanho). */
  files?: string[];
  /** Quanto o pedido espera (padrão: o da trava, 5 min). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** `skip`: o pedido nem chegou ao escritório (ex.: 'no-viewers': ninguém com a página aberta). */
export type GateDecision = { ok: true } | { ok: false; message: string; skip?: string };
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

export interface ScreenResult {
  aba: TabView;
  texto: string;
  /** JPEG em base64. */
  imagem: string;
  mimeType: 'image/jpeg';
}

export type NavAction = 'voltar' | 'avancar' | 'recarregar';

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
  /**
   * Pasta do projeto da sessão (o cwd da sala no escritório): `enviar_arquivo` só envia arquivos dela. Sem ela (ou
   * sessão desconhecida), `enviar_arquivo` é recusado.
   */
  projectDir?: (sessionId: string) => string | undefined;
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

/** O que se lê do elemento na página: os fatos da trava e o que o serviço precisa (senha, arquivo, select). */
export interface PageFacts extends ElementFacts {
  password: boolean;
  file: boolean;
  select: boolean;
}

type RawFacts = Omit<PageFacts, 'role' | 'name'> & { roleGuess: string; nameGuess: string };

/**
 * Roda DENTRO da página (autocontida): do próprio elemento, o tipo de campo; do alvo de clique mais próximo (o botão em
 * volta de um ícone, o link), o que diz se ele envia um formulário.
 */
function factsInPage(node: Element): RawFacts {
  const t = (node.closest('button, input, a[href], [role=button], [role=link], [role=menuitem], summary') ?? node) as HTMLElement & { form?: HTMLFormElement | null; value?: string };
  const own = node as HTMLElement;
  const ownTag = own.tagName.toLowerCase();
  const ownType = (own.getAttribute('type') ?? '').toLowerCase();
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
  const value = tag === 'input' && /^(submit|button|image|reset)$/.test(type) ? (t.value ?? '') : '';
  const editable =
    (ownTag === 'input' && !/^(submit|button|image|reset|checkbox|radio|file|range|color|hidden)$/.test(ownType)) || ownTag === 'textarea' || ownTag === 'select' || own.isContentEditable;
  const roles: Record<string, string> = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', summary: 'button' };
  const inputRole = /^(submit|button|image|reset)$/.test(ownType) ? 'button' : ownType === 'checkbox' || ownType === 'radio' ? ownType : 'textbox';
  return {
    tag,
    type,
    submits,
    inForm: !!form,
    formHint: form ? pick(form.getAttribute('aria-label'), form.getAttribute('name'), form.id, form.getAttribute('action')) : '',
    text: pick(tag === 'input' ? '' : t.innerText, value, t.getAttribute('aria-label'), t.getAttribute('title'), t.getAttribute('alt')),
    href: (t.closest('a[href]') as HTMLAnchorElement | null)?.href ?? '',
    editable,
    password: ownTag === 'input' && ownType === 'password',
    file: ownTag === 'input' && ownType === 'file',
    select: ownTag === 'select',
    roleGuess: own.getAttribute('role') || (ownTag === 'input' ? inputRole : (roles[ownTag] ?? ownTag)),
    nameGuess: pick(own.getAttribute('aria-label'), ownTag === 'input' ? own.getAttribute('placeholder') : own.innerText?.slice(0, 200), own.getAttribute('title')),
  };
}

/** Lê do elemento o que a trava precisa. */
async function readFacts(loc: Locator, el: ElementInfo): Promise<PageFacts> {
  const { roleGuess: _r, nameGuess: _n, ...raw } = await loc.evaluate(factsInPage, undefined, { timeout: ACTION_TIMEOUT_MS / 2 });
  return { role: el.role, name: el.name, ...raw };
}

/**
 * Fatos do elemento com o foco (desce em iframes do mesmo site e shadow DOM). undefined = não deu para saber (iframe
 * de outro site, página navegando): quem chama trava se a tecla pode enviar.
 */
async function focusedFacts(page: Page): Promise<PageFacts | undefined> {
  try {
    const h = await page.evaluateHandle(() => {
      let a: Element | null = document.activeElement;
      for (let i = 0; a && i < 10; i++) {
        if (a.tagName === 'IFRAME' || a.tagName === 'FRAME') {
          let doc: Document | null = null;
          try {
            doc = (a as HTMLIFrameElement).contentDocument;
          } catch {
            doc = null;
          }
          if (!doc) return null;
          a = doc.activeElement;
        } else if (a.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
        else break;
      }
      return a ?? document.body;
    });
    const el = h.asElement();
    if (!el) return undefined;
    const { roleGuess, nameGuess, ...raw } = await el.evaluate(factsInPage);
    await h.dispose().catch(() => {});
    return { role: roleGuess, name: nameGuess, ...raw };
  } catch {
    return undefined;
  }
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

  /** Mesma aba: outro endereço, voltar, avançar ou recarregar (só navega: sem trava). */
  async navegar(sessionId: string, tabId: unknown, rawUrl: unknown, acao: unknown): Promise<ActionResult> {
    const tab = this.tab(sessionId, tabId);
    const hasUrl = rawUrl !== undefined && rawUrl !== null && rawUrl !== '';
    const hasAcao = acao !== undefined && acao !== null && acao !== '';
    if (hasUrl === hasAcao) throw new BrowserError('invalid', tr('use `url` (outro endereço) ou `acao` (voltar, avancar, recarregar), um dos dois'));
    const url = hasUrl ? normalizeUrl(rawUrl) : undefined;
    if (hasAcao && acao !== 'voltar' && acao !== 'avancar' && acao !== 'recarregar') throw new BrowserError('invalid', tr('acao inválida: voltar, avancar ou recarregar'));
    return this.run(tab, async () => {
      const page = tab.page;
      const opts = { waitUntil: 'domcontentloaded' as const, timeout: GOTO_TIMEOUT_MS };
      try {
        if (url) await page.goto(url, opts);
        else if (acao === 'recarregar') await page.reload(opts);
        else {
          const r = acao === 'voltar' ? await page.goBack(opts) : await page.goForward(opts);
          if (!r) tab.notices.push(acao === 'voltar' ? tr('não há página anterior nesta aba') : tr('não há página seguinte nesta aba'));
        }
      } catch (err) {
        tab.notices.push(tr('a página não terminou de carregar: {0}', [errMsg(err).split('\n')[0].slice(0, 200)]));
      }
      await settle(page);
      return this.view(tab);
    });
  }

  /** Lê a página. `parte` (1, 2, ...): só aquele pedaço da página inteira, na ordem (páginas longas). */
  async ler(sessionId: string, tabId: unknown, parte?: unknown): Promise<ActionResult> {
    const tab = this.tab(sessionId, tabId);
    let part: number | undefined;
    if (parte !== undefined && parte !== null) {
      part = Number(parte);
      if (!Number.isInteger(part) || part < 1 || part > 1_000) throw new BrowserError('invalid', tr('parte inválida: um número a partir de 1'));
    }
    return this.run(tab, () => this.view(tab, { part }));
  }

  /** Rola a página (ou o painel com rolagem em volta de `ref`) e devolve a leitura nova. Sem trava. */
  async rolar(sessionId: string, tabId: unknown, direcao: unknown, ref: unknown, quanto: unknown): Promise<ActionResult> {
    const tab = this.tab(sessionId, tabId);
    const dir = direcao === undefined || direcao === null || direcao === '' ? 'baixo' : direcao;
    if (dir !== 'baixo' && dir !== 'cima') throw new BrowserError('invalid', tr('direcao inválida: baixo ou cima'));
    const amount = quanto === undefined || quanto === null || quanto === '' ? 'pagina' : quanto;
    if (amount !== 'pagina' && amount !== 'metade') throw new BrowserError('invalid', tr('quanto inválido: pagina ou metade'));
    return this.run(tab, async () => {
      const args = { sign: dir === 'baixo' ? 1 : -1, factor: amount === 'pagina' ? 0.85 : 0.5 };
      type Pos = { moved: boolean; atStart: boolean; atEnd: boolean; pct: number; inner: boolean };
      const scroll = (start: Element, a: { sign: number; factor: number }): Pos => {
        const doc = document.scrollingElement ?? document.documentElement;
        const canScroll = (e: Element) => {
          if (e === doc) return e.scrollHeight > e.clientHeight;
          const o = getComputedStyle(e).overflowY;
          return (o === 'auto' || o === 'scroll' || o === 'overlay') && e.scrollHeight > e.clientHeight + 1;
        };
        let box: Element = doc;
        for (let e: Element | null = start; e; e = e.parentElement) {
          if (e !== doc && canScroll(e)) {
            box = e;
            break;
          }
        }
        const inner = box !== doc;
        const view = inner ? box.clientHeight : window.innerHeight;
        const before = box.scrollTop;
        box.scrollBy({ top: a.sign * Math.max(40, Math.round(view * a.factor)), behavior: 'instant' as ScrollBehavior });
        const max = Math.max(0, box.scrollHeight - (inner ? box.clientHeight : window.innerHeight));
        const top = box.scrollTop;
        return { moved: Math.abs(top - before) >= 1, atStart: top <= 1, atEnd: top >= max - 1, pct: max > 0 ? Math.round((top / max) * 100) : 100, inner };
      };
      let pos: Pos;
      try {
        if (ref !== undefined && ref !== null && ref !== '') {
          const el = this.element(tab, ref);
          pos = await tab.page.getByRef(el.raw).evaluate(scroll, args, { timeout: ACTION_TIMEOUT_MS });
        } else pos = await tab.page.locator('html').evaluate(scroll, args, { timeout: ACTION_TIMEOUT_MS });
      } catch (err) {
        throw this.actionError(err, tr('não deu para rolar a página'));
      }
      const where = pos.inner ? tr('o painel') : tr('a página');
      if (!pos.moved) tab.notices.push(dir === 'baixo' ? tr('{0} já estava no fim: não há mais para baixo', [where]) : tr('{0} já estava no topo', [where]));
      else if (pos.atEnd) tab.notices.push(tr('rolou {0} até o fim', [where]));
      else if (pos.atStart) tab.notices.push(tr('rolou {0} até o topo', [where]));
      else tab.notices.push(tr('rolou {0}: agora em {1}% da altura', [where, pos.pct]));
      await settle(tab.page, 800);
      return this.view(tab);
    });
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
      if (facts.password) throw new BrowserError('invalid', passwordRefusal());
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

  /**
   * Aperta uma tecla (nome do Playwright: Enter, Tab, Escape, ArrowDown, PageDown, Control+a...), no elemento `ref`
   * ou onde estiver o foco. Enter num campo de formulário ou Enter/Espaço num botão que envia espera a aprovação, como
   * `digitar` com `enviar`; no WhatsApp toda tecla espera.
   */
  async tecla(sessionId: string, tabId: unknown, key: unknown, ref: unknown, description: unknown, signal?: AbortSignal): Promise<ActionResult> {
    const tab = this.tab(sessionId, tabId);
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw new BrowserError('invalid', tr('tecla inválida: use o nome do Playwright (Enter, Tab, Escape, ArrowDown, PageDown, Control+a...)'));
    return this.run(tab, async () => {
      const el = present(ref) ? this.element(tab, ref) : undefined;
      const loc = el ? tab.page.getByRef(el.raw) : undefined;
      const facts = loc && el ? await this.facts(loc, el) : await focusedFacts(tab.page);
      const last = key.split('+').at(-1) ?? key;
      if (facts?.password && last.length === 1) throw new BrowserError('invalid', passwordRefusal());
      const url = tab.page.url();
      const reason = gateReason({ kind: 'tecla', url, key, element: facts });
      if (reason) {
        const shown = el ? describeEl(el) : facts ? describeFacts(facts) : tr('elemento com o foco');
        await this.ask({ sessionId: tab.owner, tool: 'tecla', url, reason, description: str(description), element: shown, text: key, signal });
      }
      try {
        if (loc) await loc.press(key, { timeout: ACTION_TIMEOUT_MS });
        else await tab.page.keyboard.press(key);
      } catch (err) {
        if (/unknown key/i.test(errMsg(err))) throw new BrowserError('invalid', tr('tecla desconhecida: {0}', [key]));
        throw this.actionError(err, tr('não deu para apertar {0}', [key]));
      }
      await settle(tab.page);
      return this.view(tab);
    });
  }

  /** Escolhe opções de um <select> nativo (pelo texto ou pelo valor). Combobox feito à mão: use clicar. */
  async selecionar(sessionId: string, tabId: unknown, ref: unknown, valores: unknown, description: unknown, signal?: AbortSignal): Promise<ActionResult> {
    const tab = this.tab(sessionId, tabId);
    const wanted = Array.isArray(valores) ? valores : typeof valores === 'string' ? [valores] : [];
    if (!wanted.length || wanted.length > SELECT_MAX || !wanted.every((v): v is string => typeof v === 'string' && v.length <= 300)) {
      throw new BrowserError('invalid', tr('valores inválidos: de 1 a {0} textos (o texto ou o valor da opção)', [SELECT_MAX]));
    }
    return this.run(tab, async () => {
      const el = this.element(tab, ref);
      const loc = tab.page.getByRef(el.raw);
      const facts = await this.facts(loc, el);
      if (!facts.select) {
        throw new BrowserError('invalid', tr('{0} não é uma lista <select> nativa: clique nela (`clicar`) para abrir e depois clique na opção (ou use `tecla` ArrowDown e Enter)', [describeEl(el)]));
      }
      let options: Array<{ value: string; label: string; disabled: boolean }>;
      try {
        options = await loc.evaluate(
          (node: Element) => [...(node as HTMLSelectElement).options].map((o) => ({ value: o.value, label: (o.label || o.text).replace(/\s+/g, ' ').trim(), disabled: o.disabled })),
          undefined,
          { timeout: ACTION_TIMEOUT_MS },
        );
      } catch (err) {
        throw this.actionError(err, tr('{0} não está mais na página', [describeEl(el)]));
      }
      const norm = (x: string) => normalize(x.replace(/\s+/g, ' ').trim());
      const chosen: string[] = [];
      const missing: string[] = [];
      for (const w of wanted) {
        const o = options.find((x) => x.value === w) ?? options.find((x) => norm(x.label) === norm(w));
        if (!o || o.disabled) missing.push(w);
        else chosen.push(o.value);
      }
      if (missing.length) {
        const list = options
          .slice(0, 40)
          .map((o) => (o.label === o.value || !o.value ? `“${o.label}”` : `“${o.label}” (${o.value})`))
          .join(', ');
        throw new BrowserError('invalid', tr('opção não encontrada: {0}. Opções: {1}', [missing.map((m) => `“${m}”`).join(', '), list || '—']));
      }
      const url = tab.page.url();
      const reason = gateReason({ kind: 'selecionar', url });
      if (reason) await this.ask({ sessionId: tab.owner, tool: 'selecionar', url, reason, description: str(description), element: describeEl(el), text: wanted.join(', '), signal });
      try {
        await loc.selectOption(
          chosen.map((value) => ({ value })),
          { timeout: ACTION_TIMEOUT_MS },
        );
      } catch (err) {
        throw this.actionError(err, tr('não deu para escolher em {0}', [describeEl(el)]));
      }
      await settle(tab.page);
      return this.view(tab);
    });
  }

  /** Passa o mouse em cima de um elemento (abre menus de passar o mouse). Sem trava. */
  async passarMouse(sessionId: string, tabId: unknown, ref: unknown): Promise<ActionResult> {
    const tab = this.tab(sessionId, tabId);
    return this.run(tab, async () => {
      const el = this.element(tab, ref);
      try {
        await tab.page.getByRef(el.raw).hover({ timeout: ACTION_TIMEOUT_MS });
      } catch (err) {
        throw this.actionError(err, tr('não deu para passar o mouse em {0}', [describeEl(el)]));
      }
      await settle(tab.page, 800);
      return this.view(tab);
    });
  }

  /**
   * Espera um texto aparecer (ou sumir, com `sumir`) na página, até `ms` (no máximo 30 s), ou só espera `ms` (no máximo
   * 10 s). Não achar a tempo não é erro: a leitura diz que não apareceu.
   */
  async esperar(sessionId: string, tabId: unknown, texto: unknown, sumir: unknown, ms: unknown): Promise<ActionResult> {
    const tab = this.tab(sessionId, tabId);
    const needle = typeof texto === 'string' ? texto.trim() : '';
    if (present(texto) && (!needle || needle.length > 300)) throw new BrowserError('invalid', tr('texto inválido (até {0} caracteres)', [300]));
    let wait: number | undefined;
    if (present(ms)) {
      wait = Number(ms);
      if (!Number.isFinite(wait) || wait < 0) throw new BrowserError('invalid', tr('ms inválido'));
    }
    if (!needle && wait === undefined) throw new BrowserError('invalid', tr('diga o `texto` a esperar ou quantos `ms`'));
    return this.run(tab, async () => {
      const page = tab.page;
      if (!needle) {
        const t = Math.min(wait!, WAIT_FIXED_MAX_MS);
        await new Promise((r) => setTimeout(r, t));
        if (wait! > WAIT_FIXED_MAX_MS) tab.notices.push(tr('espera fixa limitada a {0} s', [WAIT_FIXED_MAX_MS / 1000]));
        await settle(page, 500);
        return this.view(tab);
      }
      const t = Math.min(wait ?? WAIT_TEXT_MAX_MS, WAIT_TEXT_MAX_MS);
      const gone = sumir === true;
      const t0 = Date.now();
      const shown = clipText(needle);
      try {
        await page.waitForFunction(
          (a: { needle: string; gone: boolean }) => {
            const n = (x: string) => x.replace(/\s+/g, ' ').toLowerCase();
            const has = n(document.body?.innerText ?? '').includes(n(a.needle));
            return a.gone ? !has : has;
          },
          { needle, gone },
          { timeout: Math.max(1, t), polling: 200 },
        );
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        tab.notices.push(gone ? tr('“{0}” sumiu da página ({1} s)', [shown, secs]) : tr('“{0}” apareceu na página ({1} s)', [shown, secs]));
      } catch (err) {
        if (page.isClosed()) throw this.actionError(err, tr('a aba fechou'));
        const secs = Math.round(t / 1000);
        tab.notices.push(gone ? tr('“{0}” ainda está na página depois de {1} s', [shown, secs]) : tr('“{0}” não apareceu em {1} s', [shown, secs]));
      }
      await settle(page, 500);
      return this.view(tab);
    });
  }

  /**
   * Foto (JPEG pequeno) da parte visível da aba, ou de um elemento (`ref`), para o modelo ver o que o texto não mostra
   * (gráfico, imagem, layout). Não muda a revisão: as refs da última leitura continuam valendo.
   */
  async verTela(sessionId: string, tabId: unknown, ref: unknown): Promise<ScreenResult> {
    const tab = this.tab(sessionId, tabId);
    return this.run(tab, async () => {
      const page = tab.page;
      let jpg: Buffer;
      let what: string;
      try {
        if (present(ref)) {
          const el = this.element(tab, ref);
          const loc = page.getByRef(el.raw);
          await loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
          const box = await loc.boundingBox({ timeout: ACTION_TIMEOUT_MS });
          if (!box || box.width < 1 || box.height < 1) throw new BrowserError('invalid', tr('{0} não aparece na tela (sem tamanho)', [describeEl(el)]));
          const x = Math.max(0, box.x);
          const y = Math.max(0, box.y);
          const clip = { x, y, width: Math.min(box.width - (x - box.x), SHOT_MAX.width), height: Math.min(box.height - (y - box.y), SHOT_MAX.height) };
          jpg = await page.screenshot({ type: 'jpeg', quality: SHOT_QUALITY, clip, timeout: ACTION_TIMEOUT_MS });
          what = `${describeEl(el)} (${Math.round(clip.width)}×${Math.round(clip.height)})`;
        } else {
          jpg = await page.screenshot({ type: 'jpeg', quality: SHOT_QUALITY, timeout: ACTION_TIMEOUT_MS });
          const vp = page.viewportSize() ?? VIEWPORT;
          what = tr('parte visível da página ({0}×{1})', [vp.width, vp.height]);
        }
      } catch (err) {
        throw this.actionError(err, tr('não deu para fotografar a tela'));
      }
      const title = await page.title().catch(() => '');
      const aba: TabView = { id: tab.id, title, url: page.url(), revision: tab.revision };
      const texto = [
        tr('Tela da aba {0} · revisão {1} (as refs da última leitura continuam valendo)', [aba.id, aba.revision]),
        tr('Título: {0}', [title || '—']),
        `URL: ${aba.url}`,
        tr('Foto: {0}', [what]),
      ].join('\n');
      return { aba, texto, imagem: jpg.toString('base64'), mimeType: 'image/jpeg' };
    });
  }

  /**
   * Passa a vez ao usuário (login com senha, captcha, código de verificação, QR): traz a aba para a frente, põe um
   * cartão no escritório ("faça na janela do Chrome e clique Permitir quando terminar") e espera até 15 min. Permitir
   * → leitura nova; recusar → "não vou fazer"; sem escritório aberto → instrução para pedir no chat.
   */
  async pedirAjuda(sessionId: string, tabId: unknown, motivo: unknown, signal?: AbortSignal): Promise<ActionResult> {
    const tab = this.tab(sessionId, tabId);
    if (typeof motivo !== 'string' || !motivo.trim() || motivo.length > 300) throw new BrowserError('invalid', tr('motivo inválido (1 a {0} caracteres): ex. "login no sistema"', [300]));
    const why = motivo.trim();
    await tab.page.bringToFront().catch(() => {});
    const url = tab.page.url();
    let d: GateDecision;
    try {
      // Fora da fila da aba: enquanto o usuário mexe, o escritório ainda mostra a tela.
      d = await this.opts.gate({ sessionId: tab.owner, tool: 'ajuda', url, reason: why, text: why, timeoutMs: HELP_TIMEOUT_MS, signal });
    } catch (err) {
      d = { ok: false, message: tr('a trava falhou ({0}); nada foi feito', [errMsg(err)]) };
    }
    if (!d.ok && d.skip === 'no-viewers') {
      const title = await tab.page.title().catch(() => '');
      return {
        aba: { id: tab.id, title, url: tab.page.url(), revision: tab.revision },
        texto: tr(
          'Ninguém está com o escritório aberto para receber o pedido. Peça ao usuário, aqui no chat, para fazer isto na janela do Chrome do escritório (aba {0}, {1}): {2}. Ele NÃO deve mandar senha nem código no chat. Quando ele disser que terminou, chame `ler` com tabId "{0}".',
          [tab.id, hostOf(url) || url.slice(0, 80), why],
        ),
      };
    }
    if (!d.ok) throw new BrowserError('denied', d.message);
    return this.run(tab, async () => {
      if (tab.page.isClosed()) throw new BrowserError('not-found', tr('a aba {0} fechou', [tab.id]));
      tab.notices.push(tr('o usuário disse que terminou: {0}', [why]));
      await settle(tab.page);
      return this.view(tab);
    });
  }

  /**
   * Envia arquivos da pasta do projeto da sessão por um campo de arquivo (`input type=file`) ou pelo botão que abre a
   * escolha de arquivo. Sempre espera a aprovação (o cartão lista os arquivos e o site).
   */
  async enviarArquivo(sessionId: string, tabId: unknown, ref: unknown, caminhos: unknown, description: unknown, signal?: AbortSignal): Promise<ActionResult> {
    const tab = this.tab(sessionId, tabId);
    const root = this.opts.projectDir?.(tab.owner);
    if (!root) throw new BrowserError('denied', tr('o escritório não sabe a pasta do projeto desta sessão (só dá para enviar arquivos dela). Nada foi enviado.'));
    const files = checkUploads(root, caminhos);
    return this.run(tab, async () => {
      const el = this.element(tab, ref);
      const loc = tab.page.getByRef(el.raw);
      const facts = await this.facts(loc, el);
      const url = tab.page.url();
      const reason = gateReason({ kind: 'arquivo', url }) ?? tr('enviar arquivos do seu computador para o site');
      await this.ask({
        sessionId: tab.owner,
        tool: 'enviar_arquivo',
        url,
        reason,
        description: str(description),
        element: describeEl(el),
        files: files.map((f) => `${f.rel} (${humanSize(f.size)})`),
        signal,
      });
      // Confere de novo depois da espera (o arquivo pode ter mudado de lugar).
      const paths = checkUploads(root, files.map((f) => f.rel)).map((f) => f.real);
      try {
        if (facts.file) await loc.setInputFiles(paths, { timeout: ACTION_TIMEOUT_MS });
        else {
          const chooser = tab.page.waitForEvent('filechooser', { timeout: ACTION_TIMEOUT_MS });
          chooser.catch(() => {});
          await loc.click({ timeout: ACTION_TIMEOUT_MS });
          let fc: FileChooser;
          try {
            fc = await chooser;
          } catch {
            throw new BrowserError('invalid', tr('clicar em {0} não abriu a escolha de arquivo: use a ref do campo de arquivo', [describeEl(el)]));
          }
          if (!fc.isMultiple() && paths.length > 1) throw new BrowserError('invalid', tr('este campo aceita um arquivo só'));
          await fc.setFiles(paths, { timeout: ACTION_TIMEOUT_MS });
        }
      } catch (err) {
        throw this.actionError(err, tr('não deu para enviar os arquivos em {0}', [describeEl(el)]));
      }
      tab.notices.push(tr('arquivos escolhidos: {0}', [files.map((f) => f.rel).join(', ')]));
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

  private async facts(loc: Locator, el: ElementInfo): Promise<PageFacts> {
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

  /** Nova leitura da aba: revisão nova, refs novas, texto pronto. `part`: só aquele pedaço da página inteira. */
  private async view(tab: Tab, opts: { part?: number } = {}): Promise<ActionResult> {
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
    const snap = renderSnapshot(tree, tab.revision, page.viewportSize(), { part: opts.part });
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
      ...partLines(snap, opts.part),
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

function present(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

/** O modelo nunca digita senha: login é com o usuário. */
function passwordRefusal(): string {
  return tr('campo de senha: não digite senhas. Use `pedir_ajuda` (motivo: "login") para o usuário entrar na janela do Chrome; a sessão fica salva no perfil. Nunca peça a senha no chat.');
}

function describeFacts(f: PageFacts): string {
  return f.name ? `${f.role} “${f.name.slice(0, 80)}”` : f.role;
}

function clipText(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Linhas do cabeçalho sobre o tamanho da página: cortada? quantas partes? qual parte? */
function partLines(snap: { truncated: boolean; parts: number; part?: number }, asked?: number): string[] {
  if (asked !== undefined) {
    const k = snap.part ?? 1;
    const out = [tr('Parte {0} de {1} da página (na ordem da página)', [k, snap.parts])];
    if (asked > snap.parts) out.push(tr('a página só tem {0} parte(s): mostrando a última', [snap.parts]));
    out.push(k < snap.parts ? tr('há mais: use `ler` com parte {0}', [k + 1]) : tr('fim da página'));
    return out;
  }
  if (!snap.truncated) return [];
  return [
    tr('(página grande: cortada em {0} caracteres / {1} elementos com ref; primeiro o que está na tela)', [MAX_TEXT, MAX_ELEMENTS]),
    tr('há mais: use `rolar` ou `ler` com parte 1 a {0} (a página inteira, na ordem)', [snap.parts]),
  ];
}

export interface UploadFile {
  /** Caminho relativo à pasta do projeto (o que o cartão mostra). */
  rel: string;
  /** Caminho real (sem links) dentro da pasta do projeto. */
  real: string;
  size: number;
}

/**
 * Confere os arquivos de `enviar_arquivo`: 1 a 10, cada um um arquivo comum que existe DENTRO da pasta do projeto
 * (relativo a ela ou absoluto), sem `..` e sem link que leve para fora.
 */
export function checkUploads(root: string, caminhos: unknown): UploadFile[] {
  const list = Array.isArray(caminhos) ? caminhos : typeof caminhos === 'string' ? [caminhos] : [];
  if (!list.length || list.length > UPLOAD_MAX_FILES) throw new BrowserError('invalid', tr('caminhos: de 1 a {0} arquivos da pasta do projeto', [UPLOAD_MAX_FILES]));
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw new BrowserError('denied', tr('a pasta do projeto desta sessão não existe mais: {0}. Nada foi enviado.', [root]));
  }
  const out: UploadFile[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 1_000 || raw.includes('\0')) throw new BrowserError('invalid', tr('caminho inválido'));
    const p = raw.trim();
    if (p.split(/[\\/]+/).includes('..')) throw new BrowserError('denied', tr('caminho com "..": só arquivos dentro da pasta do projeto ({0}). Nada foi enviado.', [root]));
    const abs = isAbsolute(p) ? resolve(p) : resolve(realRoot, p);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      throw new BrowserError('not-found', tr('arquivo não encontrado: {0}', [p]));
    }
    if (real === realRoot || !real.startsWith(realRoot + sep)) throw new BrowserError('denied', tr('{0} fica fora da pasta do projeto ({1}): só dá para enviar arquivos dela. Nada foi enviado.', [p, root]));
    const st = statSync(real);
    if (!st.isFile()) throw new BrowserError('invalid', tr('{0} não é um arquivo', [p]));
    if (st.size > UPLOAD_MAX_BYTES) throw new BrowserError('invalid', tr('{0} é grande demais (máximo {1} MB)', [p, UPLOAD_MAX_BYTES / 1024 / 1024]));
    out.push({ rel: relative(realRoot, real), real, size: st.size });
  }
  return out;
}
