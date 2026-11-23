// Um agente local: a conversa com um modelo do Ollama, as ferramentas e o transcript.
//
// O laço de cada turno: manda a conversa ao modelo; se ele pedir ferramentas, roda uma a uma (as arriscadas esperam a
// aprovação no escritório, como no Claude Code) e devolve os resultados; repete até ele responder sem ferramentas ou
// até MAX_STEPS. Mensagens que chegam no meio do turno esperam a vez (como as digitadas com o Claude Code ocupado).
//
// O transcript é gravado no formato do Claude Code (linhas user/assistant com blocos text/tool_use/tool_result e a
// linha system turn_duration no fim do turno): o escritório, o terminal e as estatísticas leem como leem o Claude
// Code. As ferramentas aparecem com os nomes do Claude Code (LS, Read, Write) ou mcp__<servidor>__<ferramenta>.
//
// O modelo nunca vê a pasta de dados nem nada fora do projeto: as ferramentas de arquivo ficam na pasta da sala e as
// do navegador e dos documentos são os mesmos servidores MCP dos plugins, com as mesmas travas.
import { randomUUID } from 'node:crypto';
import { tr } from '../../shared/i18n';
import { errMsg } from '../log';
import { CLAUDE_NAMES, FILE_TOOLS, FileToolError, listFiles, readTextFile, writeTextFile, type Approve } from './files';
import type { McpClient, McpTool } from './mcp';
import { ollamaChat, type ChatRequest, type ChatResult, type OllamaMessage, type OllamaTool } from './ollama';

/** Passos (chamadas ao modelo) por turno. */
export const MAX_STEPS = 30;
/** Resultado de ferramenta que o modelo recebe, em caracteres (o contexto de um modelo local é curto). */
export const RESULT_TO_MODEL_MAX = 6_000;
/** Resultado gravado no transcript (o terminal corta de novo). */
const RESULT_TO_TRANSCRIPT_MAX = 20_000;
/** Caracteres por token, na conta grosseira do tamanho da conversa. */
const CHARS_PER_TOKEN = 3.2;
/** Parte do contexto reservada para a resposta. */
const ANSWER_RESERVE = 0.25;
/** Descrição de ferramenta e de campo que o modelo recebe (as dos plugins são escritas para o Claude, bem mais longas). */
export const TOOL_DESC_MAX = 160;
export const FIELD_DESC_MAX = 80;
/**
 * Ferramentas dos plugins que o agente local não recebe: ver_tela devolve uma foto, e as imagens não chegam ao modelo
 * (ver runTool).
 */
export const SKIPPED_TOOLS = new Set(['ver_tela']);
/** Contexto mínimo com o navegador: as ferramentas dele sozinhas ocupam uns 4 mil tokens. */
export const BROWSER_MIN_CONTEXT = 16_384;

export type ToolGroup = 'arquivos' | 'documentos' | 'navegador';
export const TOOL_GROUPS: readonly ToolGroup[] = ['arquivos', 'documentos', 'navegador'];

export interface AgentSettings {
  url: string;
  contextTokens: number;
  think: boolean;
}

export interface LocalAgentOptions {
  sessionId: string;
  folder: string;
  model: string;
  groups: readonly ToolGroup[];
  /** Servidores MCP por grupo (documentos, navegador). */
  mcp: Partial<Record<ToolGroup, McpClient>>;
  /** Configuração atual (lida a cada passo). */
  settings: () => AgentSettings;
  approve: Approve;
  /** Cada linha nova do transcript (objeto no formato do Claude Code). */
  emit: (rec: Record<string, unknown>) => void;
  /** Começou ou terminou um turno. */
  onBusy: (busy: boolean) => void;
  /** Conversa com o modelo (troca nos testes). */
  chat?: (url: string, req: ChatRequest) => Promise<ChatResult>;
  now?: () => number;
}

interface ToolEntry {
  def: OllamaTool;
  group: ToolGroup;
  /** Nome no transcript. */
  transcriptName: string;
}

export function systemPrompt(folder: string, model: string, groups: readonly ToolGroup[]): string {
  const lines = [
    `Você é um agente do escritório beta-tester, rodando localmente no modelo ${model} (Ollama), neste computador.`,
    `Pasta do projeto: ${folder}. Caminhos de arquivo são relativos a ela.`,
    'Responda em português do Brasil, curto e direto. Use as ferramentas quando precisar de fatos; não invente conteúdo de arquivos ou páginas.',
    'Algumas ações pedem aprovação ao usuário no escritório. Se ele recusar, não tente de novo nem por outro caminho: explique e pergunte como seguir.',
  ];
  if (groups.includes('documentos')) lines.push('Para PDF, planilha (xlsx, csv) e Word use ler_documento; contas, só com as ferramentas de conferir. Se o pedido já trouxer o texto de um documento anexado, use esse texto.');
  if (groups.includes('navegador')) {
    lines.push('No navegador: abrir e ler devolvem o texto da página com refs (ex.: r3-e7) para clicar e digitar. Se a leitura não tiver o botão (tela desenhada, canvas), use ver_tela e clicar_ponto com x e y da foto (0,0 é o canto superior esquerdo). Senha, captcha e código de verificação são com o usuário: chame pedir_ajuda.');
  }
  return lines.join('\n');
}

function textOf(r: { content: Array<{ type: string; text?: string }> }): { text: string; images: number } {
  let images = 0;
  const parts: string[] = [];
  for (const c of r.content) {
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'image') images++;
  }
  return { text: parts.join('\n'), images };
}

/** Encurta um texto até a primeira frase que caiba (ou corta no limite). */
export function shortText(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; '));
  return end >= 40 ? head.slice(0, end + 1) : `${head.slice(0, max - 1).trimEnd()}…`;
}

/** Esquema JSON com as descrições dos campos encurtadas (o resto fica igual). */
export function compactSchema(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(compactSchema);
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === 'description' && typeof x === 'string') out[k] = shortText(x, FIELD_DESC_MAX);
    else if (k === '$schema' || k === 'title') continue;
    else out[k] = compactSchema(x);
  }
  return out;
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n${tr('[cortado: {0} caracteres a mais]', [s.length - max])}` : s;
}

export class LocalAgent {
  readonly opts: LocalAgentOptions;
  private readonly queue: string[] = [];
  private readonly messages: OllamaMessage[] = [];
  private running = false;
  private abort?: AbortController;
  private closed = false;
  private tools?: Map<string, ToolEntry>;
  private readonly now: () => number;
  private readonly chat: (url: string, req: ChatRequest) => Promise<ChatResult>;

  constructor(opts: LocalAgentOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.chat = opts.chat ?? ((url, req) => ollamaChat(url, req));
    this.messages.push({ role: 'system', content: systemPrompt(opts.folder, opts.model, opts.groups) });
  }

  get busy(): boolean {
    return this.running;
  }

  /** Mensagem do usuário: começa um turno agora ou espera o atual terminar. */
  send(text: string): void {
    if (this.closed) throw new Error(tr('o agente já saiu'));
    this.queue.push(text);
    if (!this.running) void this.drain();
  }

  /** Interrompe o turno atual (a resposta em andamento e a ferramenta que espera aprovação). */
  interrupt(): boolean {
    if (!this.running || !this.abort) return false;
    this.abort.abort();
    // O navegador pode estar preso numa aprovação: matar o processo derruba a requisição e o cartão.
    this.opts.mcp.navegador?.kill();
    return true;
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
    this.abort?.abort();
    for (const c of Object.values(this.opts.mcp)) c?.close();
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  private base(type: string): Record<string, unknown> {
    return { type, uuid: randomUUID(), timestamp: this.stamp(), sessionId: this.opts.sessionId, cwd: this.opts.folder };
  }

  private async drain(): Promise<void> {
    this.running = true;
    this.opts.onBusy(true);
    try {
      while (this.queue.length && !this.closed) {
        const text = this.queue.shift()!;
        await this.turn(text);
      }
    } finally {
      this.running = false;
      if (!this.closed) this.opts.onBusy(false);
    }
  }

  private async turn(prompt: string): Promise<void> {
    const started = this.now();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.opts.emit({ ...this.base('user'), message: { role: 'user', content: prompt } });
    this.opts.emit({ type: 'last-prompt', lastPrompt: prompt, sessionId: this.opts.sessionId });
    this.messages.push({ role: 'user', content: prompt });
    try {
      const tools = await this.loadTools();
      for (let step = 0; step < MAX_STEPS; step++) {
        if (signal.aborted) throw new Error('aborted');
        const settings = this.opts.settings();
        const contextTokens = this.opts.groups.includes('navegador') ? Math.max(settings.contextTokens, BROWSER_MIN_CONTEXT) : settings.contextTokens;
        const defs = [...tools.values()].map((t) => t.def);
        this.fit(contextTokens, JSON.stringify(defs).length);
        const r = await this.chat(settings.url, { model: this.opts.model, messages: this.messages, tools: defs, contextTokens, think: settings.think, signal });
        const msgId = `msg_local_${randomUUID()}`;
        const usage = { input_tokens: r.promptTokens, output_tokens: r.outputTokens };
        const calls = r.toolCalls.map((c) => ({ ...c, id: `toolu_local_${randomUUID().replace(/-/g, '').slice(0, 24)}` }));
        const assistant = (content: unknown[], stop: string | null) =>
          this.opts.emit({ ...this.base('assistant'), message: { id: msgId, role: 'assistant', model: this.opts.model, content, stop_reason: stop, usage } });
        if (r.thinking.trim()) assistant([{ type: 'thinking', thinking: r.thinking }], null);
        const text = r.content.trim();
        if (text) assistant([{ type: 'text', text }], calls.length ? null : 'end_turn');
        this.messages.push({ role: 'assistant', content: r.content, ...(calls.length ? { tool_calls: r.toolCalls } : {}) });
        if (!calls.length) {
          if (!text) assistant([{ type: 'text', text: tr('(o modelo não respondeu nada)') }], 'end_turn');
          return;
        }
        for (const c of calls) {
          const entry = tools.get(c.function.name);
          const name = entry?.transcriptName ?? c.function.name;
          assistant([{ type: 'tool_use', id: c.id, name, input: this.transcriptInput(entry, c.function.arguments) }], 'tool_use');
          let result: { text: string; error: boolean };
          if (!entry) {
            result = { text: tr('ferramenta desconhecida: {0}. As disponíveis: {1}', [c.function.name, [...tools.keys()].join(', ')]), error: true };
          } else {
            result = await this.runTool(entry, c.function.name, c.function.arguments, signal);
          }
          if (signal.aborted) throw new Error('aborted');
          this.opts.emit({
            ...this.base('user'),
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: c.id, content: cut(result.text, RESULT_TO_TRANSCRIPT_MAX), is_error: result.error }] },
          });
          this.messages.push({ role: 'tool', tool_name: c.function.name, content: cut(result.error ? `${tr('Erro')}: ${result.text}` : result.text, RESULT_TO_MODEL_MAX) });
        }
      }
      this.synthetic(tr('Parei depois de {0} passos neste turno. Mande outra mensagem para continuar.', [MAX_STEPS]));
    } catch (err) {
      if (signal.aborted) {
        this.opts.emit({ ...this.base('user'), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
        this.messages.push({ role: 'user', content: tr('[o usuário interrompeu]') });
      } else {
        this.synthetic(tr('Erro do Ollama: {0}', [errMsg(err)]), true);
      }
    } finally {
      this.opts.emit({ ...this.base('system'), subtype: 'turn_duration', durationMs: this.now() - started });
      this.abort = undefined;
    }
  }

  /** Mensagem do próprio escritório no lugar do modelo (erro, limite de passos). */
  private synthetic(text: string, error = false): void {
    this.opts.emit({
      ...this.base('assistant'),
      ...(error ? { isApiErrorMessage: true } : {}),
      message: { id: `msg_local_${randomUUID()}`, role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
    });
  }

  /** Ferramentas do agente (as dos servidores MCP são buscadas uma vez). Um servidor que não sobe fica de fora. */
  private async loadTools(): Promise<Map<string, ToolEntry>> {
    if (this.tools) return this.tools;
    const out = new Map<string, ToolEntry>();
    if (this.opts.groups.includes('arquivos')) {
      for (const def of FILE_TOOLS) out.set(def.function.name, { def, group: 'arquivos', transcriptName: CLAUDE_NAMES[def.function.name] ?? def.function.name });
    }
    for (const group of ['documentos', 'navegador'] as const) {
      const client = this.opts.mcp[group];
      if (!this.opts.groups.includes(group) || !client) continue;
      let list: McpTool[];
      try {
        list = await client.tools();
      } catch (err) {
        this.synthetic(tr('As ferramentas de {0} não ligaram: {1}', [group, errMsg(err)]), true);
        continue;
      }
      for (const t of list) {
        if (out.has(t.name) || SKIPPED_TOOLS.has(t.name)) continue;
        out.set(t.name, {
          def: { type: 'function', function: { name: t.name, description: shortText(t.description, TOOL_DESC_MAX), parameters: compactSchema(t.inputSchema) as Record<string, unknown> } },
          group,
          transcriptName: `mcp__${client.spec.name}__${t.name}`,
        });
      }
    }
    this.tools = out;
    return out;
  }

  /** Argumentos como o Claude Code os grava (LS/Read/Write com caminho absoluto), para o escritório descrever. */
  private transcriptInput(entry: ToolEntry | undefined, args: Record<string, unknown>): Record<string, unknown> {
    if (!entry || entry.group !== 'arquivos') return args;
    const abs = (p: unknown) => `${this.opts.folder.replace(/\/+$/, '')}/${typeof p === 'string' ? p.replace(/^\.?\/+/, '') : ''}`.replace(/\/$/, '') || this.opts.folder;
    if (entry.transcriptName === 'LS') return { path: abs(args.pasta) };
    if (entry.transcriptName === 'Read') return { file_path: abs(args.caminho) };
    if (entry.transcriptName === 'Write') return { file_path: abs(args.caminho), content: typeof args.conteudo === 'string' ? args.conteudo : '' };
    return args;
  }

  private async runTool(entry: ToolEntry, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ text: string; error: boolean }> {
    try {
      if (entry.group === 'arquivos') {
        if (name === 'listar_arquivos') return { text: listFiles(this.opts.folder, args), error: false };
        if (name === 'ler_arquivo') return { text: readTextFile(this.opts.folder, args), error: false };
        const w = await writeTextFile(this.opts.folder, args, this.opts.approve, signal);
        return { text: w.text, error: !w.ok };
      }
      const client = this.opts.mcp[entry.group]!;
      const r = await client.call(name, args);
      const { text, images } = textOf(r);
      const note = images ? `\n${tr('[{0} imagem(ns) que este modelo não vê]', [images])}` : '';
      return { text: (text || tr('(sem texto)')) + note, error: r.isError };
    } catch (err) {
      return { text: err instanceof FileToolError ? err.message : errMsg(err), error: true };
    }
  }

  /**
   * Cabe a conversa no contexto: primeiro esvazia os resultados de ferramenta mais antigos, depois tira as trocas mais
   * antigas (o pedido de sistema e a última mensagem ficam sempre).
   */
  private fit(contextTokens: number, toolChars: number): void {
    const budget = contextTokens * (1 - ANSWER_RESERVE) * CHARS_PER_TOKEN - toolChars;
    const size = () => this.messages.reduce((n, m) => n + m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0) + 16, 0);
    for (let i = 1; i < this.messages.length - 1 && size() > budget; i++) {
      const m = this.messages[i];
      if (m.role === 'tool' && m.content.length > 200) m.content = tr('[resultado antigo omitido para caber no contexto]');
    }
    while (this.messages.length > 2 && size() > budget) this.messages.splice(1, 1);
    // A conversa não pode começar com uma resposta de ferramenta solta.
    while (this.messages.length > 2 && this.messages[1].role === 'tool') this.messages.splice(1, 1);
  }
}
