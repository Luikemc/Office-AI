// Cliente do Ollama (API nativa em http://127.0.0.1:11434): versão, modelos instalados e a conversa com ferramentas.
// Só fetch do Node, sem dependências. A conversa vai sempre em streaming (NDJSON): na CPU uma resposta leva minutos e
// sem streaming o cabeçalho só chegaria no fim (o fetch do Node desiste do cabeçalho em 5 min). Cancelável pelo
// AbortSignal (interromper o turno no escritório).
//
// Ferramentas: o formato das "functions" do Ollama ({type:'function', function:{name, description, parameters}}).
// O modelo devolve `message.tool_calls[].function.{name, arguments}` (arguments já é um objeto; alguns modelos mandam
// texto JSON, que é convertido aqui). O resultado volta como mensagem `role: 'tool'` com `tool_name`.
import { tr } from '../../shared/i18n';

export interface OllamaTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
  thinking?: string;
}

export interface ChatRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  /** Tamanho do contexto (num_ctx). */
  contextTokens: number;
  /** Modelos que pensam (qwen3...): false = responde direto (bem mais rápido na CPU). */
  think: boolean;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  thinking: string;
  toolCalls: OllamaToolCall[];
  /** Tokens lidos (prompt) e gerados nesta chamada, como o Ollama conta. */
  promptTokens: number;
  outputTokens: number;
  doneReason?: string;
}

export interface OllamaModel {
  name: string;
  /** Bytes no disco. */
  size: number;
  /** Ex.: "4.0B". */
  parameters?: string;
  family?: string;
}

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Quanto esperar o Ollama responder às perguntas rápidas (versão, modelos). */
export const QUICK_TIMEOUT_MS = 4_000;
/** Mantém o modelo carregado na memória entre os passos de um turno (e um pouco depois). */
export const KEEP_ALIVE = '15m';

function base(url: string): string {
  return url.replace(/\/+$/, '');
}

async function quick(url: string, path: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${base(url)}${path}`, { signal: AbortSignal.timeout(QUICK_TIMEOUT_MS) });
  } catch (err) {
    throw new OllamaError(unreachable(url, err));
  }
  if (!res.ok) throw new OllamaError(`HTTP ${res.status}`, res.status);
  return res.json();
}

function unreachable(url: string, err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'TimeoutError') return tr('o Ollama em {0} não respondeu a tempo', [url]);
  return tr('o Ollama não está rodando em {0} (rode `ollama serve`)', [url]);
}

export async function ollamaVersion(url: string): Promise<string> {
  const j = (await quick(url, '/api/version')) as { version?: unknown };
  return typeof j?.version === 'string' ? j.version : '?';
}

export async function ollamaModels(url: string): Promise<OllamaModel[]> {
  const j = (await quick(url, '/api/tags')) as { models?: unknown };
  if (!Array.isArray(j?.models)) return [];
  const out: OllamaModel[] = [];
  for (const m of j.models as Array<Record<string, unknown>>) {
    if (!m || typeof m.name !== 'string') continue;
    const d = (m.details ?? {}) as Record<string, unknown>;
    out.push({
      name: m.name,
      size: typeof m.size === 'number' ? m.size : 0,
      ...(typeof d.parameter_size === 'string' ? { parameters: d.parameter_size } : {}),
      ...(typeof d.family === 'string' ? { family: d.family } : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** arguments pode vir como objeto (o normal) ou como texto JSON (alguns modelos). */
export function toolArgs(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string' && v.trim()) {
    try {
      const j = JSON.parse(v) as unknown;
      if (j && typeof j === 'object' && !Array.isArray(j)) return j as Record<string, unknown>;
    } catch {
      // texto que não é JSON: sem argumentos
    }
  }
  return {};
}

/** Junta um pedaço do streaming no resultado. */
export function applyChunk(out: ChatResult, chunk: Record<string, unknown>): void {
  if (typeof chunk.error === 'string') throw new OllamaError(chunk.error);
  const m = chunk.message as Record<string, unknown> | undefined;
  if (m) {
    if (typeof m.content === 'string') out.content += m.content;
    if (typeof m.thinking === 'string') out.thinking += m.thinking;
    if (Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls as Array<Record<string, unknown>>) {
        const f = c?.function as Record<string, unknown> | undefined;
        if (f && typeof f.name === 'string' && f.name) out.toolCalls.push({ function: { name: f.name, arguments: toolArgs(f.arguments) } });
      }
    }
  }
  if (chunk.done === true) {
    if (typeof chunk.prompt_eval_count === 'number') out.promptTokens = chunk.prompt_eval_count;
    if (typeof chunk.eval_count === 'number') out.outputTokens = chunk.eval_count;
    if (typeof chunk.done_reason === 'string') out.doneReason = chunk.done_reason;
  }
}

/** Uma rodada da conversa (POST /api/chat, streaming). `onProgress` recebe o total de caracteres gerados até agora. */
export async function ollamaChat(url: string, req: ChatRequest, onProgress?: (chars: number) => void): Promise<ChatResult> {
  const body = {
    model: req.model,
    messages: req.messages,
    ...(req.tools?.length ? { tools: req.tools } : {}),
    stream: true,
    think: req.think,
    keep_alive: KEEP_ALIVE,
    options: { num_ctx: req.contextTokens },
  };
  let res: Response;
  try {
    res = await fetch(`${base(url)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: req.signal,
    });
  } catch (err) {
    if (req.signal?.aborted) throw err;
    throw new OllamaError(unreachable(url, err));
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: unknown };
      if (typeof j.error === 'string') msg = j.error;
    } catch {
      // corpo que não é JSON
    }
    throw new OllamaError(msg || `HTTP ${res.status}`, res.status);
  }
  const out: ChatResult = { content: '', thinking: '', toolCalls: [], promptTokens: 0, outputTokens: 0 };
  const decoder = new TextDecoder();
  let buf = '';
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      applyChunk(out, chunk);
      onProgress?.(out.content.length + out.thinking.length);
    }
  }
  const rest = buf.trim();
  if (rest) {
    try {
      applyChunk(out, JSON.parse(rest) as Record<string, unknown>);
    } catch (err) {
      if (err instanceof OllamaError) throw err;
    }
  }
  return out;
}
