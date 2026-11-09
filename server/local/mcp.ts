// Cliente MCP por stdio (JSON-RPC 2.0, uma mensagem por linha): o agente local usa os MESMOS servidores MCP que o
// Claude Code usa nos plugins (mod/navegador, mod/documentos), rodando como processo filho com o Node deste servidor.
// Só initialize, tools/list e tools/call. Um processo por agente e por servidor; parar = matar o processo (no
// navegador isso derruba a requisição presa numa aprovação, e o cartão sai do escritório).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { tr } from '../../shared/i18n';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpCallResult {
  content: McpContent[];
  isError: boolean;
}

export interface McpServerSpec {
  /** Nome do servidor (o mesmo do plugin: "navegador", "documentos"); vira o prefixo mcp__<nome>__ no transcript. */
  name: string;
  script: string;
  cwd: string;
  env: Record<string, string>;
}

export const MCP_PROTOCOL = '2025-06-18';
/** Prazo do initialize e do tools/list. */
export const START_TIMEOUT_MS = 15_000;
const STDERR_MAX = 2_000;

type Waiter = { ok: (v: unknown) => void; fail: (e: Error) => void };

export class McpClient {
  private child?: ChildProcessWithoutNullStreams;
  private seq = 0;
  private waiting = new Map<number, Waiter>();
  private buf = '';
  private stderr = '';
  private ready?: Promise<McpTool[]>;
  private closed = false;

  constructor(readonly spec: McpServerSpec) {}

  /** Liga o processo (uma vez) e devolve as ferramentas dele. */
  tools(): Promise<McpTool[]> {
    this.ready ??= this.boot().catch((err: unknown) => {
      this.ready = undefined;
      this.kill();
      throw err;
    });
    return this.ready;
  }

  async call(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.tools();
    const r = (await this.request('tools/call', { name, arguments: args })) as { content?: unknown; isError?: unknown };
    const content = Array.isArray(r?.content) ? (r.content as McpContent[]).filter((c) => c && typeof c.type === 'string') : [];
    return { content, isError: r?.isError === true };
  }

  /** Mata o processo; as chamadas em andamento falham. A próxima chamada liga outro. */
  kill(): void {
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    this.buf = '';
    for (const w of this.waiting.values()) w.fail(new Error(tr('o servidor {0} foi encerrado', [this.spec.name])));
    this.waiting.clear();
    if (child && child.exitCode === null) child.kill();
  }

  close(): void {
    this.closed = true;
    this.kill();
  }

  private async boot(): Promise<McpTool[]> {
    if (this.closed) throw new Error(tr('o agente já saiu'));
    const child = spawn(process.execPath, [this.spec.script], {
      cwd: this.spec.cwd,
      env: { ...process.env, ...this.spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => this.onData(d));
    child.stderr.on('data', (d: string) => {
      this.stderr = (this.stderr + d).slice(-STDERR_MAX);
    });
    child.on('error', (err) => this.failAll(err));
    child.on('exit', () => {
      if (this.child === child) {
        this.child = undefined;
        this.ready = undefined;
        this.failAll(new Error(tr('o servidor {0} parou{1}', [this.spec.name, this.stderr.trim() ? `: ${this.stderr.trim().split('\n').pop()}` : ''])));
      }
    });
    await this.request('initialize', { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'beta-tester-agente-local', version: '1.0.0' } }, START_TIMEOUT_MS);
    this.notify('notifications/initialized');
    const r = (await this.request('tools/list', {}, START_TIMEOUT_MS)) as { tools?: unknown };
    const list = Array.isArray(r?.tools) ? (r.tools as Array<Record<string, unknown>>) : [];
    return list
      .filter((t) => t && typeof t.name === 'string')
      .map((t) => ({
        name: t.name as string,
        description: typeof t.description === 'string' ? t.description : '',
        inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? (t.inputSchema as Record<string, unknown>) : { type: 'object', properties: {} },
      }));
  }

  private failAll(err: Error): void {
    for (const w of this.waiting.values()) w.fail(err);
    this.waiting.clear();
  }

  private onData(d: string): void {
    this.buf += d;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof msg.id !== 'number') continue;
      const w = this.waiting.get(msg.id);
      if (!w) continue;
      this.waiting.delete(msg.id);
      const e = msg.error as { message?: unknown } | undefined;
      if (e) w.fail(new Error(typeof e.message === 'string' ? e.message : tr('erro no servidor {0}', [this.spec.name])));
      else w.ok(msg.result);
    }
  }

  private write(msg: Record<string, unknown>): void {
    const child = this.child;
    if (!child || child.exitCode !== null || !child.stdin.writable) throw new Error(tr('o servidor {0} não está rodando', [this.spec.name]));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  }

  private notify(method: string): void {
    this.write({ method });
  }

  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((ok, fail) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (fn: () => void) => {
        if (timer) clearTimeout(timer);
        fn();
      };
      this.waiting.set(id, { ok: (v) => done(() => ok(v)), fail: (e) => done(() => fail(e)) });
      if (timeoutMs) {
        timer = setTimeout(() => {
          if (this.waiting.delete(id)) fail(new Error(tr('o servidor {0} não respondeu a tempo', [this.spec.name])));
        }, timeoutMs);
      }
      try {
        this.write({ id, method, params });
      } catch (err) {
        this.waiting.delete(id);
        done(() => fail(err as Error));
      }
    });
  }
}
