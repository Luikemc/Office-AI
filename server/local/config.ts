// Configuração da IA local (Ollama), em <dataDir>/ia-local.json:
//   { "url": "http://127.0.0.1:11434", "modelo": "qwen3:4b", "contexto": 8192, "pensar": false }
// Arquivo ausente ou inválido = o padrão. Gravado de uma vez (arquivo .tmp + rename). Vale para os próximos agentes
// e para o próximo passo dos que já estão rodando (o modelo de um agente fica o que ele começou).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tr } from '../../shared/i18n';
import { errMsg, log } from '../log';

export interface LocalConfig {
  /** Endereço do Ollama. Só deste computador (localhost, 127.0.0.1 ou ::1): a IA é local. */
  url: string;
  /** Modelo padrão dos agentes novos ("" = o primeiro instalado). */
  modelo: string;
  /** num_ctx: quanto da conversa o modelo enxerga, em tokens. Mais = mais memória. */
  contexto: number;
  /** Deixar o modelo "pensar" antes de responder (qwen3 e parecidos). Mais lento na CPU. */
  pensar: boolean;
}

export const DEFAULT_URL = 'http://127.0.0.1:11434';
export const MIN_CONTEXT = 2_048;
export const MAX_CONTEXT = 131_072;
export const DEFAULT_CONFIG: LocalConfig = { url: DEFAULT_URL, modelo: '', contexto: 8_192, pensar: false };
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,200}$/;

export class InvalidLocalConfig extends Error {}

/** URL do Ollama neste computador; undefined se não for local ou não for http(s). */
export function localUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 300) return undefined;
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return undefined;
  if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return undefined;
  return `${u.protocol}//${u.host}`;
}

export function isModelName(v: unknown): v is string {
  return typeof v === 'string' && MODEL_RE.test(v);
}

/** Aplica um pedaço (PUT /api/local/config) sobre a configuração atual. Lança InvalidLocalConfig. */
export function mergeLocalConfig(cur: LocalConfig, raw: unknown): LocalConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidLocalConfig(tr('esperado um objeto'));
  const r = raw as Record<string, unknown>;
  const next = { ...cur };
  if (r.url !== undefined) {
    const url = localUrl(r.url);
    if (!url) throw new InvalidLocalConfig(tr('o endereço do Ollama precisa ser deste computador (http://127.0.0.1:11434)'));
    next.url = url;
  }
  if (r.modelo !== undefined) {
    if (r.modelo !== '' && !isModelName(r.modelo)) throw new InvalidLocalConfig(tr('nome de modelo inválido'));
    next.modelo = r.modelo as string;
  }
  if (r.contexto !== undefined) {
    if (typeof r.contexto !== 'number' || !Number.isInteger(r.contexto) || r.contexto < MIN_CONTEXT || r.contexto > MAX_CONTEXT) {
      throw new InvalidLocalConfig(tr('o contexto vai de {0} a {1} tokens', [MIN_CONTEXT, MAX_CONTEXT]));
    }
    next.contexto = r.contexto;
  }
  if (r.pensar !== undefined) {
    if (typeof r.pensar !== 'boolean') throw new InvalidLocalConfig(tr('pensar é verdadeiro ou falso'));
    next.pensar = r.pensar;
  }
  return next;
}

export class LocalConfigStore {
  private cur: LocalConfig;

  constructor(private readonly path: string) {
    this.cur = this.read();
  }

  get(): LocalConfig {
    return { ...this.cur };
  }

  update(raw: unknown): LocalConfig {
    const next = mergeLocalConfig(this.cur, raw);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
    this.cur = next;
    return this.get();
  }

  private read(): LocalConfig {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(tr('IA local: {0} inválido, usando o padrão ({1}).', [this.path, errMsg(err)]));
      return { ...DEFAULT_CONFIG };
    }
    try {
      return mergeLocalConfig(DEFAULT_CONFIG, raw);
    } catch (err) {
      log.warn(tr('IA local: {0} inválido, usando o padrão ({1}).', [this.path, errMsg(err)]));
      return { ...DEFAULT_CONFIG };
    }
  }
}
