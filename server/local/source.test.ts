// A fonte de agentes locais de ponta a ponta, com um Ollama falso por HTTP: o agente entra no escritório como
// 'ollama', escrever pede aprovação na sala, a mensagem do escritório começa outro turno e sair tira o agente.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { MessageRegistry } from '../messages/registry';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { PermissionRegistry } from '../permissions/registry';
import { registryApprove } from './approve';
import { LocalConfigStore } from './config';
import { LocalSource } from './source';

setQuiet(true);

type Step = Record<string, unknown>;
let ollama: Server;
let url: string;
let script: Step[];
let chats: Array<Record<string, unknown>>;
let project: string;
let data: string;

beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), 'local-src-proj-'));
  data = mkdtempSync(join(tmpdir(), 'local-src-data-'));
  script = [];
  chats = [];
  ollama = createServer((req, res) => {
    if (req.url === '/api/version') return void res.end(JSON.stringify({ version: '0.40.15' }));
    if (req.url === '/api/tags') return void res.end(JSON.stringify({ models: [{ name: 'qwen3:4b', size: 2_500_000_000, details: { parameter_size: '4.0B', family: 'qwen3' } }] }));
    if (req.url === '/api/chat') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        chats.push(JSON.parse(body) as Record<string, unknown>);
        const step = script.shift() ?? { content: 'pronto' };
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ message: { role: 'assistant', content: step.content ?? '', ...(step.tool_calls ? { tool_calls: step.tool_calls } : {}) }, done: false })}\n`);
        res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 50, eval_count: 9 })}\n`);
      });
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((r) => ollama.close(r));
  rmSync(project, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

function setup() {
  let registry: PermissionRegistry | undefined;
  let local: LocalSource | undefined;
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: 0,
    accounts: (s) => local?.accounts(s) ?? [],
    sources: () => local?.sources() ?? [],
    accountName: () => undefined,
    permissions: () => registry?.snapshot() ?? new Map(),
  });
  registry = new PermissionRegistry({ office, viewers: () => 1, transcriptPathOf: () => undefined });
  const config = new LocalConfigStore(join(data, 'ia-local.json'));
  config.update({ url });
  local = new LocalSource({
    office,
    config,
    dir: join(data, 'ia-local'),
    rootDir: resolve(__dirname, '../..'),
    port: 4748,
    approve: (sid) => registryApprove(registry!, 4748, sid),
    browser: () => false,
  });
  const messages = new MessageRegistry({ office, local: { deliver: (id, text) => local!.send(id, text) } });
  return { office, registry, local, messages };
}

async function until(fn: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('tempo esgotado');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('LocalSource', () => {
  it('agente local no escritório: aprovação na sala, mensagem e saída', async () => {
    const { office, registry, local, messages } = setup();
    script = [{ tool_calls: [{ function: { name: 'escrever_arquivo', arguments: { caminho: 'oi.txt', conteudo: 'olá' } } }] }, { content: 'Criei oi.txt.' }];
    const view = await local.create({ folder: project, prompt: 'crie oi.txt', ferramentas: ['arquivos'] });
    expect(view.model).toBe('qwen3:4b');
    const agent = () => office.commit().snapshot.agents.find((a) => a.id === view.id);
    expect(agent()).toMatchObject({ provider: 'ollama', account: 'ollama', kind: 'main' });
    expect(office.commit().snapshot.accounts.find((a) => a.id === 'ollama')).toMatchObject({ provider: 'ollama', short: 'O' });

    // Escrever pede aprovação: a sala espera com o cartão.
    await until(() => agent()?.status === 'waiting');
    const perm = agent()!.permission!;
    expect(perm.title).toBe('Write(oi.txt)');
    expect(registry.decide(perm.id, { behavior: 'allow' })).toBe('ok');
    await until(() => agent()?.status === 'idle');
    expect(readFileSync(join(project, 'oi.txt'), 'utf8')).toBe('olá');
    expect(agent()!.title).toBe('crie oi.txt');
    expect(agent()!.stats.toolCalls).toBe(1);
    expect(agent()!.model).toBe('qwen3:4b');
    // O modelo recebeu o resultado da ferramenta.
    const second = chats[1].messages as Array<{ role: string; content: string }>;
    expect(second.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('gravado') });
    expect((chats[0].options as { num_ctx: number }).num_ctx).toBe(8192);

    // Mensagem pelo escritório: entregue na hora e começa outro turno.
    expect(messages.canMessage(view.id)).toBe(true);
    expect(messages.reachable().has(view.id)).toBe(true);
    script = [{ content: 'De nada!' }];
    const sent = messages.send({ agentId: view.id, text: 'obrigado' });
    expect('message' in sent && sent.message.status).toBe('delivered');
    await until(() => chats.length === 3 && agent()?.status === 'idle');
    expect((chats[2].messages as Array<{ content: string }>).at(-1)!.content).toBe('obrigado');

    // O transcript está no disco, no formato do Claude Code.
    const path = local.transcriptPathOf(view.id)!;
    expect(readFileSync(path, 'utf8')).toContain('"turn_duration"');

    expect(local.close(view.id)).toBe(true);
    expect(office.get(view.id)?.status).toBe('offline');
    expect(local.close(view.id)).toBe(false);
  });

  it('recusa pasta inexistente, modelo não instalado, grupo desligado e Ollama fora do ar', async () => {
    const { local } = setup();
    await expect(local.create({ folder: join(project, 'nao-existe') })).rejects.toMatchObject({ code: 'invalid' });
    await expect(local.create({ folder: 'relativo' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(local.create({ folder: project, model: 'llama9:70b' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(local.create({ folder: project, ferramentas: ['navegador'] })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(local.create({ folder: project, ferramentas: ['shell'] })).rejects.toMatchObject({ code: 'invalid' });
    await new Promise((r) => ollama.close(r));
    const st = await local.status();
    expect(st.ok).toBe(false);
    expect(st.error).toMatch(/não está rodando/);
    expect(local.sources()[0]).toMatchObject({ provider: 'ollama', ok: false });
    await expect(local.create({ folder: project })).rejects.toMatchObject({ code: 'unavailable' });
    ollama.listen(0);
  });

  it('interromper para o turno e a sala volta a ociosa', async () => {
    const { office, local } = setup();
    // O Ollama falso não responde a este pedido até a conexão cair.
    ollama.removeAllListeners('request');
    let hung = 0;
    ollama.on('request', (req, res) => {
      if (req.url === '/api/version') return void res.end(JSON.stringify({ version: '0.40.15' }));
      if (req.url === '/api/tags') return void res.end(JSON.stringify({ models: [{ name: 'qwen3:4b', size: 1 }] }));
      hung++;
      req.resume();
    });
    const view = await local.create({ folder: project, prompt: 'pense', ferramentas: [] });
    await until(() => hung === 1 && office.get(view.id)?.status === 'working');
    expect(local.interrupt(view.id)).toBe(true);
    await until(() => office.get(view.id)?.status === 'idle');
    expect(readFileSync(local.transcriptPathOf(view.id)!, 'utf8')).toContain('Request interrupted by user');
    local.close(view.id);
    ollama.closeAllConnections();
  });
});
