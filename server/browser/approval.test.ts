// Trava do navegador no registro de permissões (requestInternal + registryGate): o pedido aparece na sala (status
// 'waiting'), aprovação/recusa chegam à ação, e falha fecha (sem página, sessão desconhecida, expirado, cancelado).
// O relógio do registro não solta o pedido interno como órfão nem pela busca no transcript.
import { describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { PermissionRegistry } from '../permissions/registry';
import { appendLines, L, tempDir, writeLines } from '../test/fixtures';
import { registryGate } from './approval';
import type { GateRequest } from './service';

setQuiet(true);

const MAIN = 'acc:1';
const SESSION = 'sess-1';

function setup(opts: { viewers?: number; transcript?: string } = {}) {
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  let registry: PermissionRegistry | undefined;
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: 0,
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    permissions: () => registry?.snapshot() ?? new Map(),
    now: clock.now,
  });
  office.addMain({ id: MAIN, account: 'acc', sessionId: SESSION, cwd: '/p/loja', role: 'Agente principal', startedAt: 0, status: 'working' });
  let viewers = opts.viewers ?? 1;
  registry = new PermissionRegistry({ office, viewers: () => viewers, now: clock.now, transcriptPathOf: () => opts.transcript });
  return { office, registry, clock, setViewers: (n: number) => (viewers = n) };
}

const req = (over: Partial<GateRequest> = {}): GateRequest => ({
  sessionId: SESSION,
  tool: 'clicar',
  url: 'https://loja.example/checkout',
  reason: 'enviar um formulário',
  element: 'button “Pagar”',
  description: 'botão Pagar',
  ...over,
});

const flush = () => new Promise((r) => setImmediate(r));

describe('trava do navegador no registro', () => {
  it('pedido na sala: waiting com o cartão (site, elemento, descrição); aprovado → ok', async () => {
    const { office, registry } = setup();
    const gate = registryGate(registry, 4747);
    const pending = gate(req());
    await flush();
    const a = office.commit().snapshot.agents.find((x) => x.id === MAIN)!;
    expect(a.status).toBe('waiting');
    expect(a.permission).toMatchObject({ tool: 'mcp__navegador__clicar', title: 'mcp__navegador__clicar(loja.example)', text: expect.stringMatching(/Pagar.*loja\.example/) });
    const detail = registry.detail(a.permission!.id)!;
    expect(detail.input).toMatch(/Site: https:\/\/loja\.example\/checkout/);
    expect(detail.input).toMatch(/Descrição do agente: botão Pagar/);
    expect(registry.decide(a.permission!.id, { behavior: 'allow' })).toBe('ok');
    expect(await pending).toEqual({ ok: true });
    expect(registry.size).toBe(0);
  });

  it('recusado (com motivo), "responder no terminal" e expirado: nada roda', async () => {
    const { registry, clock } = setup();
    const gate = registryGate(registry, 4747, 10_000);
    const p1 = gate(req());
    await flush();
    registry.decide([...registry.snapshot().values()][0].id, { behavior: 'deny', message: 'não compre' });
    expect(await p1).toEqual({ ok: false, message: expect.stringMatching(/não compre/) });

    const p2 = gate(req({ tool: 'digitar', text: 'olá' }));
    await flush();
    const id2 = [...registry.snapshot().values()][0].id;
    expect(registry.detail(id2)?.input).toMatch(/Texto que será digitado:\nolá/);
    registry.decide(id2, { behavior: 'terminal' });
    expect((await p2).ok).toBe(false);

    const p3 = gate(req());
    await flush();
    clock.advance(20_000);
    registry.tick();
    expect(await p3).toEqual({ ok: false, message: expect.stringMatching(/a tempo/) });
  });

  it('sem página aberta ou sessão desconhecida: recusa na hora, mandando abrir o escritório', async () => {
    const { registry, setViewers } = setup({ viewers: 0 });
    const gate = registryGate(registry, 4749);
    expect(await gate(req())).toEqual({ ok: false, message: expect.stringMatching(/abrir o Habblaud \(http:\/\/localhost:4749\)/) });
    setViewers(1);
    expect(await gate(req({ sessionId: 'outra' }))).toEqual({ ok: false, message: expect.stringMatching(/não conhece esta sessão/) });
    expect(registry.size).toBe(0);
  });

  it('o relógio não solta o pedido interno: sem long-poll (órfão) e com a chamada respondida no transcript', async () => {
    const tmp = tempDir();
    const transcript = `${tmp.dir}/t.jsonl`;
    writeLines(transcript, [L.prompt('abre o site')]);
    const { registry, clock } = setup({ transcript });
    const gate = registryGate(registry, 4747);
    const p = gate(req());
    await flush();
    // Uma chamada qualquer, já respondida, no transcript (o que soltaria um pedido do hook).
    appendLines(transcript, [L.assistant([L.tool('tu1', 'mcp__navegador__clicar', {})]), L.result('tu1', 'ok')]);
    for (let i = 0; i < 40; i++) {
      clock.advance(1_000);
      registry.tick();
    }
    expect(registry.size).toBe(1);
    registry.decide([...registry.snapshot().values()][0].id, { behavior: 'allow' });
    expect(await p).toEqual({ ok: true });
    tmp.cleanup();
  });

  it('a ação cancelada (conexão do MCP caiu) tira o pedido da sala', async () => {
    const { registry } = setup();
    const ac = new AbortController();
    const p = registryGate(registry, 4747)(req({ signal: ac.signal }));
    await flush();
    expect(registry.size).toBe(1);
    ac.abort();
    expect((await p).ok).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('agente que saiu: o pedido some e a ação é recusada', async () => {
    const { registry, office } = setup();
    const p = registryGate(registry, 4747)(req());
    await flush();
    office.closeMain(MAIN);
    registry.tick();
    expect(await p).toEqual({ ok: false, message: expect.stringMatching(/saiu do escritório/) });
    expect(registry.size).toBe(0);
  });
});
