import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTerminalParser } from '../sources/terminal';
import { createTranscriptState, parseLine } from '../sources/transcript';
import { LocalAgent, MAX_STEPS, systemPrompt } from './agent';
import type { Approve } from './files';
import type { ChatRequest, ChatResult } from './ollama';

function reply(p: Partial<ChatResult>): ChatResult {
  return { content: '', thinking: '', toolCalls: [], promptTokens: 10, outputTokens: 5, ...p };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'local-agent-'));
  writeFileSync(join(dir, 'notas.txt'), 'linha um\nlinha dois\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function make(script: Array<(req: ChatRequest) => ChatResult | Promise<ChatResult>>, approve: Approve = async () => ({ ok: true })) {
  const lines: Record<string, unknown>[] = [];
  const busy: boolean[] = [];
  const requests: ChatRequest[] = [];
  let i = 0;
  let done!: () => void;
  let idle = new Promise<void>((r) => (done = r));
  const agent = new LocalAgent({
    sessionId: 's-1',
    folder: dir,
    model: 'qwen3:4b',
    groups: ['arquivos'],
    mcp: {},
    settings: () => ({ url: 'http://127.0.0.1:11434', contextTokens: 8192, think: false }),
    approve,
    emit: (r) => lines.push(r),
    onBusy: (b) => {
      busy.push(b);
      if (!b) {
        done();
        idle = new Promise<void>((r) => (done = r));
      }
    },
    chat: async (_url, req) => {
      requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
      const step = script[Math.min(i++, script.length - 1)];
      return step(req);
    },
  });
  return { agent, lines, busy, requests, idle: () => idle };
}

describe('LocalAgent', () => {
  it('responde sem ferramentas e grava o turno no formato do Claude Code', async () => {
    const t = make([() => reply({ content: 'Olá!' })]);
    const idle = t.idle();
    t.agent.send('oi');
    await idle;
    expect(t.busy).toEqual([true, false]);
    const types = t.lines.map((l) => `${l.type}${l.subtype ? `:${l.subtype}` : ''}`);
    expect(types).toEqual(['user', 'last-prompt', 'assistant', 'system:turn_duration']);
    const a = t.lines[2].message as { content: Array<{ text: string }>; stop_reason: string; model: string };
    expect(a.content[0].text).toBe('Olá!');
    expect(a.stop_reason).toBe('end_turn');
    expect(a.model).toBe('qwen3:4b');
    expect(t.requests[0].messages[0].role).toBe('system');
    expect(t.requests[0].tools?.map((x) => x.function.name)).toEqual(['listar_arquivos', 'ler_arquivo', 'escrever_arquivo']);
  });

  it('roda ferramentas, devolve o resultado ao modelo e o parser do escritório entende', async () => {
    const t = make([
      () => reply({ toolCalls: [{ function: { name: 'ler_arquivo', arguments: { caminho: 'notas.txt' } } }] }),
      (req) => {
        const tool = req.messages.at(-1)!;
        expect(tool.role).toBe('tool');
        expect(tool.tool_name).toBe('ler_arquivo');
        expect(tool.content).toContain('linha dois');
        return reply({ content: 'O arquivo tem duas linhas.' });
      },
    ]);
    const idle = t.idle();
    t.agent.send('quantas linhas tem notas.txt?');
    await idle;
    const use = t.lines.find((l) => l.type === 'assistant' && JSON.stringify(l).includes('tool_use'))!;
    const block = (use.message as { content: Array<{ name: string; input: { file_path: string } }> }).content[0];
    expect(block.name).toBe('Read');
    expect(block.input.file_path).toBe(join(dir, 'notas.txt'));
    // O mesmo parser do Claude Code: atividade de leitura, fim de turno e tokens contados.
    const state = createTranscriptState();
    const acts = t.lines.flatMap((l) => parseLine(state, JSON.stringify(l), { idPrefix: 'local-1', now: Date.now() }).activities);
    expect(acts.some((a) => a.activity.tool === 'Read')).toBe(true);
    expect(state.ended).toBe(true);
    expect(state.stats.toolCalls).toBe(1);
    expect(state.stats.tokensOut).toBeGreaterThan(0);
    // E o terminal mostra a conversa.
    const term = createTerminalParser();
    const entries = t.lines.flatMap((l) => term.push(JSON.stringify(l)));
    expect(entries.map((e) => e.kind)).toEqual(expect.arrayContaining(['user', 'tool', 'result', 'assistant']));
  });

  it('escrever_arquivo só grava com aprovação', async () => {
    const asked: string[] = [];
    const deny: Approve = async (r) => {
      asked.push(r.title);
      return { ok: false, message: 'o usuário recusou' };
    };
    const t = make(
      [
        () => reply({ toolCalls: [{ function: { name: 'escrever_arquivo', arguments: { caminho: 'novo.txt', conteudo: 'x' } } }] }),
        (req) => {
          expect(req.messages.at(-1)!.content).toContain('recusou');
          return reply({ content: 'Entendido.' });
        },
      ],
      deny,
    );
    const idle = t.idle();
    t.agent.send('crie novo.txt');
    await idle;
    expect(asked).toEqual(['Write(novo.txt)']);
    expect(() => readFileSync(join(dir, 'novo.txt'))).toThrow();
    const result = t.lines.find((l) => JSON.stringify(l).includes('tool_result'))!;
    expect(JSON.stringify(result)).toContain('"is_error":true');
  });

  it('ferramenta desconhecida vira erro para o modelo, sem derrubar o turno', async () => {
    const t = make([() => reply({ toolCalls: [{ function: { name: 'rodar_shell', arguments: {} } }] }), () => reply({ content: 'ok' })]);
    const idle = t.idle();
    t.agent.send('rode ls');
    await idle;
    expect(t.requests[1].messages.at(-1)!.content).toContain('ferramenta desconhecida');
  });

  it('para no limite de passos', async () => {
    const t = make([() => reply({ toolCalls: [{ function: { name: 'listar_arquivos', arguments: {} } }] })]);
    const idle = t.idle();
    t.agent.send('liste para sempre');
    await idle;
    expect(t.requests).toHaveLength(MAX_STEPS);
    const last = t.lines.filter((l) => l.type === 'assistant').at(-1)!;
    expect((last.message as { model: string }).model).toBe('<synthetic>');
  });

  it('erro do Ollama vira mensagem de erro e fecha o turno', async () => {
    const t = make([
      () => {
        throw new Error('model not found');
      },
    ]);
    const idle = t.idle();
    t.agent.send('oi');
    await idle;
    const err = t.lines.find((l) => l.isApiErrorMessage)!;
    expect(JSON.stringify(err)).toContain('model not found');
    expect(t.lines.at(-1)!.subtype).toBe('turn_duration');
  });

  it('interromper aborta a resposta em andamento', async () => {
    let release!: () => void;
    const t = make([
      (req) =>
        new Promise<ChatResult>((_ok, fail) => {
          req.signal?.addEventListener('abort', () => fail(new Error('aborted')));
          release = () => undefined;
        }),
    ]);
    const idle = t.idle();
    t.agent.send('pense bastante');
    await new Promise((r) => setTimeout(r, 10));
    expect(t.agent.busy).toBe(true);
    expect(t.agent.interrupt()).toBe(true);
    await idle;
    release();
    expect(JSON.stringify(t.lines)).toContain('[Request interrupted by user]');
    expect(t.agent.busy).toBe(false);
  });

  it('mensagens no meio do turno esperam a vez', async () => {
    const t = make([() => reply({ content: 'um' }), () => reply({ content: 'dois' })]);
    const idle = t.idle();
    t.agent.send('primeira');
    t.agent.send('segunda');
    await idle;
    const prompts = t.lines.filter((l) => l.type === 'user' && typeof (l.message as { content: unknown }).content === 'string').map((l) => (l.message as { content: string }).content);
    expect(prompts).toEqual(['primeira', 'segunda']);
    expect(t.busy).toEqual([true, false]);
  });

  it('esvazia resultados antigos quando a conversa passa do contexto', async () => {
    writeFileSync(join(dir, 'grande.txt'), 'x'.repeat(5_000) + '\n');
    const t = make([
      ...Array.from({ length: 6 }, () => () => reply({ toolCalls: [{ function: { name: 'ler_arquivo', arguments: { caminho: 'grande.txt' } } }] })),
      () => reply({ content: 'fim' }),
    ]);
    const idle = t.idle();
    t.agent.send('leia seis vezes');
    await idle;
    const lastReq = t.requests.at(-1)!;
    const size = lastReq.messages.reduce((n, m) => n + m.content.length, 0);
    expect(size).toBeLessThan(8192 * 0.75 * 3.2);
    expect(lastReq.messages.some((m) => m.content.includes('omitido'))).toBe(true);
    expect(lastReq.messages[0].role).toBe('system');
  });

  it('o pedido de sistema cita a pasta, o modelo e as regras', () => {
    const p = systemPrompt('/home/x/proj', 'qwen3:4b', ['arquivos', 'navegador']);
    expect(p).toContain('/home/x/proj');
    expect(p).toContain('qwen3:4b');
    expect(p).toContain('pedir_ajuda');
    expect(p).toContain('clicar_ponto');
  });
});

describe('ferramentas compactas para modelos locais', () => {
  it('encurta descrições na primeira frase e os campos do esquema', async () => {
    const { shortText, compactSchema } = await import('./agent');
    expect(shortText('Abre a página no navegador do escritório. Depois faz muitas outras coisas que não cabem.', 60)).toBe('Abre a página no navegador do escritório.');
    expect(shortText('curto', 40)).toBe('curto');
    expect(shortText('x'.repeat(100), 20)).toHaveLength(20);
    const s = compactSchema({ $schema: 'x', type: 'object', properties: { a: { type: 'string', description: 'y'.repeat(300) } } }) as { properties: { a: { description: string } }; $schema?: string };
    expect(s.$schema).toBeUndefined();
    expect(s.properties.a.description.length).toBeLessThanOrEqual(80);
  });
});
