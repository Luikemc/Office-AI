// Fonte de agentes locais (AgentSource 'ollama', ver sources/source.ts): agentes que o PRÓPRIO servidor roda com um
// modelo do Ollama neste computador, sem chave de API e sem a nuvem. Diferente das outras fontes, não observa
// arquivos de outra ferramenta: cria o agente (Novo agente › Ollama), grava o transcript dele em
// <dataDir>/ia-local/<sessão>.jsonl no formato do Claude Code e passa cada linha pelo mesmo parser do Claude Code
// (sources/transcript.ts), que dá as atividades, o título e os números do escritório.
//
// Presença: o agente fica no escritório até sair (DELETE /api/local/agents/:id) ou o servidor parar. Não volta
// depois de reiniciar (o transcript fica no disco). Status: 'working' durante o turno, 'idle' entre turnos; a espera
// por aprovação ('waiting') vem do registro de permissões, como nas outras fontes.
//
// Ferramentas: arquivos do projeto (server/local/files.ts) e os servidores MCP dos plugins documentos e navegador,
// rodando como processos filhos com a sessão deste agente (HABBLAUD_NAVEGADOR_SESSION). O navegador acha a sala do
// agente pelo sessionId, então as travas e os cartões são os mesmos do Claude Code.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { AccountInfo, SourceInfo } from '../../shared/types';
import { tr } from '../../shared/i18n';
import { errMsg, log } from '../log';
import type { Office, TranscriptSummary } from '../model/office';
import type { AgentSource } from '../sources/source';
import { createTranscriptState, parseLine, titleOf, type TranscriptState } from '../sources/transcript';
import { LocalAgent, TOOL_GROUPS, type ToolGroup } from './agent';
import type { LocalConfigStore } from './config';
import { isModelName } from './config';
import type { Approve } from './files';
import { McpClient } from './mcp';
import { ollamaModels, ollamaVersion, type OllamaModel } from './ollama';

export const LOCAL_ACCOUNT = 'ollama';
export const ACCOUNT_COLOR = '#3fb68b';
/** Agentes locais ao mesmo tempo (cada um segura o modelo na memória enquanto trabalha). */
export const MAX_AGENTS = 4;
export const PROMPT_MAX = 20_000;
/** A cada quanto o balão "Pensando…" é renovado enquanto o modelo trabalha. */
const FILL_MS = 2_000;
const DEFAULT_GROUPS: readonly ToolGroup[] = ['arquivos', 'documentos'];

export class LocalAgentError extends Error {
  constructor(
    readonly code: 'invalid' | 'not-found' | 'unavailable' | 'too-many',
    message: string,
  ) {
    super(message);
  }
}

export interface LocalSourceOptions {
  office: Office;
  config: LocalConfigStore;
  /** <dataDir>/ia-local */
  dir: string;
  /** Raiz do repositório (para achar mod/documentos e mod/navegador). */
  rootDir: string;
  /** Porta do servidor (o MCP do navegador fala com ele). */
  port: number;
  /** Aprovação no escritório para um agente (sessionId); ausente = escrever arquivos é recusado. */
  approve?: (sessionId: string) => Approve;
  /** Navegador ligado neste servidor (lido na hora). */
  browser: () => boolean;
  now?: () => number;
}

interface Tracked {
  id: string;
  agent: LocalAgent;
  state: TranscriptState;
  path: string;
  model: string;
  folder: string;
  groups: ToolGroup[];
  timer?: ReturnType<typeof setInterval>;
}

export interface LocalAgentView {
  id: string;
  model: string;
  folder: string;
  ferramentas: ToolGroup[];
  ocupado: boolean;
}

export interface LocalStatus {
  ok: boolean;
  url: string;
  version?: string;
  error?: string;
  models: OllamaModel[];
  /** Grupos de ferramentas disponíveis neste servidor (o navegador pode estar desligado). */
  ferramentas: ToolGroup[];
}

export function parseGroups(v: unknown, available: readonly ToolGroup[]): ToolGroup[] {
  if (v === undefined) return DEFAULT_GROUPS.filter((g) => available.includes(g));
  if (!Array.isArray(v) || !v.every((g) => typeof g === 'string')) throw new LocalAgentError('invalid', tr('ferramentas: esperada uma lista'));
  const out: ToolGroup[] = [];
  for (const g of v as string[]) {
    if (!TOOL_GROUPS.includes(g as ToolGroup)) throw new LocalAgentError('invalid', tr('grupo de ferramentas desconhecido: {0}', [g]));
    if (!available.includes(g as ToolGroup)) throw new LocalAgentError('unavailable', tr('{0} não está ligado neste beta-tester', [g]));
    if (!out.includes(g as ToolGroup)) out.push(g as ToolGroup);
  }
  return out;
}

export class LocalSource implements AgentSource {
  readonly provider = 'ollama' as const;
  private agents = new Map<string, Tracked>();
  private lastError?: string;
  private readonly now: () => number;

  constructor(private readonly opts: LocalSourceOptions) {
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    // Nada a reconstruir: os agentes locais começam pelo escritório.
  }

  stop(): void {
    for (const id of [...this.agents.keys()]) this.close(id);
  }

  groups(): ToolGroup[] {
    return TOOL_GROUPS.filter((g) => g === 'arquivos' || (hasPlugin(this.opts.rootDir, g) && (g !== 'navegador' || this.opts.browser())));
  }

  sources(): SourceInfo[] {
    const busy = this.agents.size;
    return [{ label: 'Ollama', provider: 'ollama', path: this.opts.config.get().url, sessions: busy, ok: !this.lastError, ...(this.lastError ? { error: this.lastError } : {}) }];
  }

  /** A "conta" dos agentes locais, para o snapshot (cor e rótulo no escritório). */
  accounts(sessions: ReadonlyMap<string, number>): AccountInfo[] {
    return [
      {
        id: LOCAL_ACCOUNT,
        provider: 'ollama',
        short: 'O',
        name: tr('Ollama (local)'),
        color: ACCOUNT_COLOR,
        configDir: this.opts.config.get().url,
        sessions: sessions.get(LOCAL_ACCOUNT) ?? 0,
        usageStatus: 'disabled',
      },
    ];
  }

  transcriptPathOf(agentId: string): string | undefined {
    return this.agents.get(agentId)?.path;
  }

  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  list(): LocalAgentView[] {
    return [...this.agents.values()].map((t) => ({ id: t.id, model: t.model, folder: t.folder, ferramentas: t.groups, ocupado: t.agent.busy }));
  }

  /** Ollama no ar, a versão e os modelos instalados. */
  async status(): Promise<LocalStatus> {
    const url = this.opts.config.get().url;
    try {
      const [version, models] = await Promise.all([ollamaVersion(url), ollamaModels(url)]);
      this.lastError = undefined;
      return { ok: true, url, version, models, ferramentas: this.groups() };
    } catch (err) {
      this.lastError = errMsg(err);
      return { ok: false, url, error: this.lastError, models: [], ferramentas: this.groups() };
    }
  }

  /** Novo agente local: `{folder, prompt, model?, ferramentas?}`. Lança LocalAgentError. */
  async create(raw: unknown): Promise<LocalAgentView> {
    const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const folder = typeof r.folder === 'string' ? r.folder.trim().replace(/(.)\/+$/, '$1') : '';
    if (!folder || !isAbsolute(folder) || folder.length > 1024) throw new LocalAgentError('invalid', tr('escolha a pasta do projeto (caminho completo)'));
    let dir = false;
    try {
      dir = statSync(folder).isDirectory();
    } catch {
      dir = false;
    }
    if (!dir) throw new LocalAgentError('invalid', tr('a pasta não existe: {0}', [folder]));
    const prompt = typeof r.prompt === 'string' ? r.prompt : '';
    if (prompt.length > PROMPT_MAX) throw new LocalAgentError('invalid', tr('o pedido passa de {0} caracteres', [PROMPT_MAX]));
    const groups = parseGroups(r.ferramentas, this.groups());
    if (this.agents.size >= MAX_AGENTS) throw new LocalAgentError('too-many', tr('já há {0} agentes locais: tire um do escritório antes', [MAX_AGENTS]));
    const st = await this.status();
    if (!st.ok) throw new LocalAgentError('unavailable', st.error ?? tr('o Ollama não respondeu'));
    if (!st.models.length) throw new LocalAgentError('unavailable', tr('nenhum modelo instalado no Ollama (ex.: ollama pull qwen3:4b)'));
    const wanted = r.model !== undefined && r.model !== '' ? r.model : this.opts.config.get().modelo;
    if (wanted !== '' && !isModelName(wanted)) throw new LocalAgentError('invalid', tr('nome de modelo inválido'));
    const model = wanted ? st.models.find((m) => m.name === wanted || m.name === `${wanted}:latest`)?.name : st.models[0].name;
    if (!model) throw new LocalAgentError('invalid', tr('o modelo {0} não está instalado (ollama pull {0})', [wanted as string]));

    const sessionId = randomUUID();
    const id = `local-${sessionId.slice(0, 8)}`;
    mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
    const path = join(this.opts.dir, `${sessionId}.jsonl`);
    const mcp: Partial<Record<ToolGroup, McpClient>> = {};
    if (groups.includes('documentos')) mcp.documentos = this.mcp('documentos', folder, { CLAUDE_PROJECT_DIR: folder });
    if (groups.includes('navegador')) mcp.navegador = this.mcp('navegador', folder, { HABBLAUD_NAVEGADOR_SESSION: sessionId, HABBLAUD_PORT: String(this.opts.port), CLAUDE_PROJECT_DIR: folder });
    const deny: Approve = async () => ({ ok: false, message: tr('aprovação pelo escritório desligada neste beta-tester: nada foi gravado') });
    const t: Tracked = {
      id,
      path,
      model,
      folder,
      groups,
      state: createTranscriptState(),
      agent: undefined as unknown as LocalAgent,
    };
    t.agent = new LocalAgent({
      sessionId,
      folder,
      model,
      groups,
      mcp,
      settings: () => {
        const c = this.opts.config.get();
        return { url: c.url, contextTokens: c.contexto, think: c.pensar };
      },
      approve: this.opts.approve?.(sessionId) ?? deny,
      emit: (rec) => this.line(t, rec),
      onBusy: (busy) => this.busy(t, busy),
      now: this.now,
    });
    this.agents.set(id, t);
    this.opts.office.addMain({
      id,
      provider: 'ollama',
      account: LOCAL_ACCOUNT,
      sessionId,
      cwd: folder,
      role: tr('Agente local ({0})', [model]),
      startedAt: this.now(),
      status: 'idle',
    });
    if (prompt.trim()) t.agent.send(prompt);
    log.info(tr('IA local: agente {0} ({1}) em {2}.', [id, model, folder]));
    return { id, model, folder, ferramentas: groups, ocupado: t.agent.busy };
  }

  /** Mensagem do escritório para um agente local. Lança LocalAgentError. */
  send(id: string, text: string): void {
    const t = this.agents.get(id);
    if (!t) throw new LocalAgentError('not-found', tr('agente local não encontrado'));
    t.agent.send(text);
  }

  interrupt(id: string): boolean {
    const t = this.agents.get(id);
    if (!t) throw new LocalAgentError('not-found', tr('agente local não encontrado'));
    return t.agent.interrupt();
  }

  /** Tira o agente do escritório (para o que ele fazia). */
  close(id: string): boolean {
    const t = this.agents.get(id);
    if (!t) return false;
    if (t.timer) clearInterval(t.timer);
    t.agent.close();
    this.agents.delete(id);
    this.opts.office.closeMain(id);
    return true;
  }

  private mcp(name: 'documentos' | 'navegador', cwd: string, env: Record<string, string>): McpClient {
    return new McpClient({ name, script: join(this.opts.rootDir, 'mod', name, 'server.mjs'), cwd, env });
  }

  private busy(t: Tracked, busy: boolean): void {
    if (!this.agents.has(t.id)) return;
    const office = this.opts.office;
    office.setStatus(t.id, busy ? 'working' : 'idle');
    if (t.timer) clearInterval(t.timer);
    t.timer = undefined;
    if (busy) {
      office.fillWorkingActivity(t.id);
      t.timer = setInterval(() => office.fillWorkingActivity(t.id), FILL_MS);
      t.timer.unref?.();
    }
    office.markDirty();
  }

  /** Grava a linha no transcript e a passa pelo parser do Claude Code. */
  private line(t: Tracked, rec: Record<string, unknown>): void {
    const line = JSON.stringify(rec);
    try {
      appendFileSync(t.path, `${line}\n`, { mode: 0o600 });
    } catch (err) {
      log.warnOnce(`local-write:${t.id}`, tr('IA local: não deu para gravar o transcript de {0} ({1}).', [t.id, errMsg(err)]));
    }
    if (!this.agents.has(t.id)) return;
    const office = this.opts.office;
    let r;
    try {
      r = parseLine(t.state, line, { idPrefix: t.id, now: this.now() });
    } catch (err) {
      log.warnOnce(`local-parse:${t.id}:${errMsg(err)}`, tr('Linha do transcript de {0} ignorada: {1}', [t.id, errMsg(err)]));
      return;
    }
    for (const a of r.activities) office.addActivity(t.id, a.activity, a.current, { feed: true });
    if (r.changed) {
      const s = t.state;
      const summary: TranscriptSummary = { tasks: s.tasks, stats: { ...s.stats } };
      const title = titleOf(s);
      if (title) summary.title = title;
      summary.model = t.model;
      if (s.lastAt !== undefined) summary.lastAt = s.lastAt;
      office.applyTranscript(t.id, summary);
    }
  }
}

/** Existe o servidor MCP de um plugin nesta cópia do beta-tester. */
export function hasPlugin(rootDir: string, name: string): boolean {
  return existsSync(join(rootDir, 'mod', name, 'server.mjs'));
}
