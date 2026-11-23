// Configuração da trava do navegador, em <dataDir>/navegador.json:
//   { "modo": "livre", "sitesConfiaveis": ["127.0.0.1:4800", "erp.example.com:443"] }
// Arquivo ausente ou inválido = o padrão (livre, nenhum site). Gravado de uma vez (arquivo .tmp + rename).
// Muda na hora (as configurações do escritório e o "Permitir e confiar neste site" do cartão): sem reiniciar.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tr } from '../../shared/i18n';
import { errMsg, log } from '../log';
import { DEFAULT_MODE, isBrowserMode, lockedHost, type BrowserMode, type GatePolicy } from './gate';

export interface BrowserConfig {
  modo: BrowserMode;
  /** Sites confiáveis, por host:porta (porta sempre explícita: "loja.example:443"). */
  sitesConfiaveis: string[];
}

export const MAX_TRUSTED_SITES = 200;

export class InvalidBrowserConfig extends Error {}

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))*|\[[0-9a-f:.]+\]):\d{1,5}$/;

/** Site (host:porta, porta explícita) de uma URL http(s), ou undefined. */
export function siteKey(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  if (!u.hostname) return undefined;
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return `${u.hostname.toLowerCase()}:${port}`;
}

/**
 * Site digitado ou guardado → host:porta. Aceita "host:porta", "host" (porta 443) ou uma URL http(s). Undefined =
 * inválido. Sites do WhatsApp não entram (o envio não passa pela lista de confiáveis).
 */
export function parseSite(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().toLowerCase();
  if (!s || s.length > 300) return undefined;
  let key: string | undefined;
  if (/^https?:\/\//.test(s)) key = siteKey(s);
  else if (HOST_RE.test(s)) key = s;
  else if (HOST_RE.test(`${s}:443`)) key = `${s}:443`;
  if (!key || !HOST_RE.test(key)) return undefined;
  const port = Number(key.slice(key.lastIndexOf(':') + 1));
  if (!(port >= 1 && port <= 65535)) return undefined;
  if (lockedHost(key.slice(0, key.lastIndexOf(':')))) return undefined;
  return key;
}

export function defaultConfig(): BrowserConfig {
  return { modo: DEFAULT_MODE, sitesConfiaveis: [] };
}

/** Conteúdo lido do disco → configuração válida (o que não serve é ignorado; nada servível = padrão). */
export function sanitizeConfig(raw: unknown): BrowserConfig {
  const out = defaultConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (isBrowserMode(r.modo)) out.modo = r.modo;
  if (Array.isArray(r.sitesConfiaveis)) {
    const seen = new Set<string>();
    for (const s of r.sitesConfiaveis) {
      const k = parseSite(s);
      if (k && !seen.has(k) && seen.size < MAX_TRUSTED_SITES) seen.add(k);
    }
    out.sitesConfiaveis = [...seen];
  }
  return out;
}

export class BrowserConfigStore {
  private cfg: BrowserConfig;

  /** `file` null = só em memória (testes). `initial` vale quando não há arquivo (ou para os testes). */
  constructor(
    private readonly file: string | null,
    initial?: Partial<BrowserConfig>,
  ) {
    this.cfg = { ...defaultConfig(), ...(initial ? sanitizeConfig({ ...defaultConfig(), ...initial }) : {}) };
    if (file) this.load();
  }

  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.file!, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(tr('navegador.json ilegível ({0}); usando o modo livre.', [errMsg(err)]));
      return;
    }
    try {
      this.cfg = sanitizeConfig(JSON.parse(text));
    } catch (err) {
      this.cfg = defaultConfig();
      log.warn(tr('navegador.json ilegível ({0}); usando o modo livre.', [errMsg(err)]));
    }
  }

  get(): BrowserConfig {
    return { modo: this.cfg.modo, sitesConfiaveis: [...this.cfg.sitesConfiaveis] };
  }

  /** O site desta URL está entre os confiáveis? */
  isTrusted(url: string): boolean {
    const k = siteKey(url);
    return !!k && this.cfg.sitesConfiaveis.includes(k);
  }

  /** Política para uma ação nesta URL (modo atual e se o site é confiável). */
  policy(url: string): GatePolicy {
    return { mode: this.cfg.modo, trusted: this.isTrusted(url) };
  }

  /**
   * Troca o modo e/ou a lista inteira (as configurações do escritório). Valor inválido → InvalidBrowserConfig e nada
   * muda.
   */
  update(patch: unknown): BrowserConfig {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new InvalidBrowserConfig(tr('esperado {modo?, sitesConfiaveis?}'));
    const p = patch as Record<string, unknown>;
    const next = this.get();
    if (p.modo !== undefined) {
      if (!isBrowserMode(p.modo)) throw new InvalidBrowserConfig(tr('modo inválido: use cauteloso, equilibrado ou livre'));
      next.modo = p.modo;
    }
    if (p.sitesConfiaveis !== undefined) {
      if (!Array.isArray(p.sitesConfiaveis) || p.sitesConfiaveis.length > MAX_TRUSTED_SITES) throw new InvalidBrowserConfig(tr('sitesConfiaveis: uma lista de até {0} sites (host:porta)', [MAX_TRUSTED_SITES]));
      const list: string[] = [];
      for (const s of p.sitesConfiaveis) {
        const k = parseSite(s);
        if (!k) throw new InvalidBrowserConfig(tr('site inválido: {0} (use host:porta, ex. 127.0.0.1:4800; WhatsApp não entra)', [String(s).slice(0, 100)]));
        if (!list.includes(k)) list.push(k);
      }
      next.sitesConfiaveis = list;
    }
    this.cfg = next;
    this.save();
    return this.get();
  }

  /** Põe o site da URL entre os confiáveis (o cartão "Permitir e confiar neste site"). Devolve o site, ou undefined. */
  trust(urlOrSite: string): string | undefined {
    const k = /^https?:\/\//i.test(urlOrSite) ? parseSite(siteKey(urlOrSite) ?? '') : parseSite(urlOrSite);
    if (!k) return undefined;
    if (!this.cfg.sitesConfiaveis.includes(k)) {
      if (this.cfg.sitesConfiaveis.length >= MAX_TRUSTED_SITES) return undefined;
      this.cfg = { ...this.cfg, sitesConfiaveis: [...this.cfg.sitesConfiaveis, k] };
      this.save();
    }
    return k;
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.cfg, null, 2)}\n`);
      renameSync(tmp, this.file);
    } catch (err) {
      log.warn(tr('Não consegui gravar {0}: {1}', [this.file, errMsg(err)]));
    }
  }
}
