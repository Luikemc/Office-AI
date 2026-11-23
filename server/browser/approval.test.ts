// Trava do navegador no registro de permissões (requestInternal + registryGate): o pedido aparece na sala (status
// 'waiting'), aprovação/recusa chegam à ação, e falha fecha (sem página, sessão desconhecida, expirado, cancelado).
// O relógio do registro não solta o pedido interno como órfão nem pela busca no transcript.
import { describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { parseDecision, PermissionRegistry } from '../permissions/registry';
import { appendLines, L, tempDir, writeLines } from '../test/fixtures';
import { cardInput, cardText, registryGate } from './approval';
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
    expect(await gate(req())).toEqual({ ok: false, message: expect.stringMatching(/abrir o beta-tester \(http:\/\/localhost:4749\)/), skip: 'no-viewers' });
    setViewers(1);
    expect(await gate(req({ sessionId: 'outra' }))).toEqual({ ok: false, message: expect.stringMatching(/não conhece esta sessão/), skip: 'unknown-session' });
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

describe('cartão do WhatsApp', () => {
  it('para quem (nome do cabeçalho) e o texto exato, sem site nem elemento', () => {
    const r: GateRequest = { sessionId: 's', tool: 'whatsapp_enviar', url: 'https://web.whatsapp.com/', reason: 'x', element: 'Ana', text: 'linha 1\nlinha 2' };
    expect(cardText(r)).toBe('Enviar no WhatsApp para Ana');
    expect(cardInput(r)).toBe('Para: Ana (nome no cabeçalho da conversa aberta)\nMensagem que será enviada:\nlinha 1\nlinha 2');
  });
});

describe('cartões das ferramentas novas', () => {
  it('pedir_ajuda: cartão "Ajuda no navegador", espera longa, recusa = "não vai fazer"', async () => {
    const { office, registry, clock } = setup();
    const gate = registryGate(registry, 4748);
    const p = gate(req({ tool: 'ajuda', reason: 'login', text: 'login no sistema', url: 'http://127.0.0.1:4800/login', timeoutMs: 15 * 60_000 }));
    await flush();
    const a = office.commit().snapshot.agents.find((x) => x.id === MAIN)!;
    expect(a.status).toBe('waiting');
    expect(a.permission).toMatchObject({ tool: 'mcp__navegador__pedir_ajuda', icon: '🙋', text: expect.stringMatching(/^Ajuda no navegador: login no sistema — abra Navegador na barra/) });
    expect(registry.detail(a.permission!.id)!.input).toMatch(/Nunca mande senhas/);
    // Passa dos 5 min padrão e continua esperando.
    clock.advance(10 * 60_000);
    registry.tick();
    expect(registry.size).toBe(1);
    registry.decide(a.permission!.id, { behavior: 'deny' });
    expect(await p).toEqual({ ok: false, message: expect.stringMatching(/não vai fazer/) });
  });

  it('tecla, selecionar e enviar_arquivo: o que vai acontecer está no cartão', () => {
    const base = { sessionId: 's', url: 'https://erp.example/clientes', reason: 'r' };
    expect(cardText({ ...base, tool: 'tecla', text: 'Enter' })).toBe('Apertar Enter em erp.example');
    expect(cardInput({ ...base, tool: 'tecla', text: 'Enter', element: 'textbox “Nome”' })).toMatch(/Tecla: Enter/);
    expect(cardText({ ...base, tool: 'selecionar', text: 'SP' })).toBe('Escolher SP em erp.example');
    const up: GateRequest = { ...base, tool: 'enviar_arquivo', files: ['docs/a.pdf (1.0 KB)', 'b.png (3 B)'] };
    expect(cardText(up)).toBe('Enviar 2 arquivo(s) para erp.example');
    expect(cardInput(up)).toMatch(/Arquivos que serão enviados:\n- docs\/a\.pdf \(1\.0 KB\)\n- b\.png \(3 B\)/);
  });
});

describe('"Permitir e confiar neste site"', () => {
  it('o cartão oferece o site; allow com trustSite volta para a trava; sem oferta = inválido', async () => {
    const { office, registry } = setup();
    const gate = registryGate(registry, 4748);
    const p = gate(req({ tool: 'enviar_arquivo', url: 'http://127.0.0.1:4800/clientes/novo', files: ['a.txt (1 B)'], trustSite: '127.0.0.1:4800' }));
    await flush();
    const a = office.commit().snapshot.agents.find((x) => x.id === MAIN)!;
    expect(a.permission?.trustSite).toBe('127.0.0.1:4800');
    expect(registry.decide(a.permission!.id, { behavior: 'allow', trustSite: true })).toBe('ok');
    expect(await p).toEqual({ ok: true, trustSite: true });
    expect(JSON.stringify(office.commit().snapshot.agents.find((x) => x.id === MAIN))).toMatch(/site confiável/);

    // Sem oferta (pagamento): trustSite é recusado e o pedido continua esperando.
    const p2 = gate(req());
    await flush();
    const id2 = office.commit().snapshot.agents.find((x) => x.id === MAIN)!.permission!.id;
    expect(registry.detail(id2)?.trustSite).toBeUndefined();
    expect(registry.decide(id2, { behavior: 'allow', trustSite: true })).toBe('invalid');
    expect(registry.size).toBe(1);
    expect(registry.decide(id2, { behavior: 'allow' })).toBe('ok');
    expect(await p2).toEqual({ ok: true });

    // O envio do WhatsApp e o pedido de ajuda nunca levam a oferta, mesmo se o serviço mandasse.
    const p3 = gate(req({ tool: 'whatsapp_enviar', url: 'https://web.whatsapp.com/', element: 'Ana', text: 'oi', trustSite: 'web.whatsapp.com:443' }));
    await flush();
    const id3 = office.commit().snapshot.agents.find((x) => x.id === MAIN)!.permission!.id;
    expect(registry.detail(id3)?.trustSite).toBeUndefined();
    registry.decide(id3, { behavior: 'deny' });
    expect((await p3).ok).toBe(false);
  });

  it('parseDecision: trustSite só true e só no allow', () => {
    expect(parseDecision({ behavior: 'allow', trustSite: true })).toEqual({ behavior: 'allow', trustSite: true });
    expect(parseDecision({ behavior: 'allow', trustSite: 'sim' })).toBeUndefined();
    expect(parseDecision({ behavior: 'deny', trustSite: true })).toEqual({ behavior: 'deny' });
  });
});
