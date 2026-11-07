// Política da trava: classify (categoria por tabela de palavras, pt/en/es, sem falsos positivos conhecidos),
// needsApproval (3 modos × site confiável × categorias) e a configuração em navegador.json (config.ts).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { BrowserConfigStore, parseSite, sanitizeConfig, siteKey } from './config';
import { BROWSER_MODES, classify, gateReason, judge, needsApproval, textCategory, type ElementFacts, type GateCategory } from './gate';

setQuiet(true);

const el = (over: Partial<ElementFacts> = {}): ElementFacts => ({ role: 'button', name: '', ...over });
const click = (e: ElementFacts, url = 'https://erp.example/x') => classify({ kind: 'clicar', url, element: e });
const btn = (name: string) => click(el({ name }));

describe('classify: palavras', () => {
  it('dinheiro (pt/en/es)', () => {
    const money = [
      'Pagar',
      'Pagar agora',
      'Pague com cartão',
      'Confirmar pagamento',
      'Comprar',
      'Compre já',
      'Finalizar compra',
      'Finalizar pedido',
      'Fazer pedido',
      'Fechar pedido',
      'Checkout',
      'Check out',
      'Transferir',
      'Nova transferência',
      'Pagar com Pix',
      'Pix',
      'Assinar plano',
      'Assine agora',
      'Doar',
      'Pay',
      'Pay now',
      'Buy now',
      'Purchase',
      'Place order',
      'Order now',
      'Subscribe',
      'Donate',
      'Upgrade',
      'Realizar pedido',
      'Suscribirse',
      'Donar',
      'Comprar ahora',
    ];
    for (const n of money) expect(btn(n), n).toBe('dinheiro');
  });

  it('destrutivo (pt/en/es)', () => {
    const destr = [
      'Excluir',
      'Excluir cliente',
      'Confirmar exclusão',
      'Apagar',
      'Remover',
      'Remova o item',
      'Deletar',
      'Delete',
      'Remove',
      'Eliminar',
      'Eliminar cuenta',
      'Borrar',
      'Cancelar conta',
      'Cancelar assinatura',
      'Cancel subscription',
      'Cancel my account',
      'Encerrar conta',
      'Desativar conta',
      'Deactivate account',
      'Revogar acesso',
      'Revoke',
    ];
    for (const n of destr) expect(btn(n), n).toBe('destrutivo');
  });

  it('mensagem / publicar (pt/en/es)', () => {
    const msg = ['Publicar', 'Postar', 'Post', 'Tweet', 'Publish', 'Enviar mensagem', 'Enviar e-mail', 'Send message', 'Send email', 'Responder', 'Reply', 'Comentar', 'Comment', 'Enviar mensaje', 'Convidar'];
    for (const n of msg) expect(btn(n), n).toBe('mensagem');
    // "Enviar"/"Send" sozinho: fora de formulário (app de mensagem) = mensagem; num <form> = envio comum.
    expect(btn('Enviar')).toBe('mensagem');
    expect(btn('Send')).toBe('mensagem');
    expect(click(el({ name: 'Enviar', inForm: true, submits: true, type: 'submit' }))).toBe('envio');
  });

  it('falsos positivos: navegação, nomes parecidos, menus no plural', () => {
    const none = [
      'Página 2',
      'Próxima página',
      'Pagamentos', // menu
      'Compras', // menu
      'Transferências', // menu
      'Postagens recentes',
      'Comentários',
      'Disco removível',
      'Removido',
      'Guardar borrador',
      'Envío gratis',
      'Pixel art',
      'Excluídos',
      'Detalhes',
      'Clientes',
      'Novo cliente',
      'Ver pedido',
      'Pedidos',
    ];
    for (const n of none) expect(textCategory(n), n).toBeUndefined();
    // Remover filtro / do carrinho não é destrutivo.
    expect(textCategory('Remover filtro')).toBeUndefined();
    expect(textCategory('Remove from cart')).toBeUndefined();
    expect(textCategory('Limpar busca')).toBeUndefined();
    // Botão comum sem palavra: nada.
    expect(btn('Menu')).toBeUndefined();
    expect(click(el({ role: 'link', name: 'Ver detalhes', href: 'https://erp.example/1' }))).toBeUndefined();
  });

  it('envio (só o cauteloso pede): salvar, confirmar, aceitar, submit sem palavra', () => {
    for (const n of ['Salvar', 'Save', 'Guardar', 'Confirmar', 'Aceitar', 'Accept', 'Aceptar', 'Cadastrar e salvar', 'Aprovar']) expect(btn(n), n).toBe('envio');
    expect(click(el({ name: 'OK', tag: 'button', type: 'submit', submits: true, inForm: true }))).toBe('envio');
    expect(click(el({ name: 'Entrar', tag: 'button', type: 'submit', submits: true, inForm: true, formHint: 'Entrar no sistema' }))).toBe('envio');
  });

  it('o formulário diz o risco do botão sem palavra (checkout, excluir conta)', () => {
    expect(click(el({ name: 'Continuar', inForm: true, submits: true, formHint: 'checkout' }))).toBe('dinheiro');
    expect(click(el({ name: 'OK', inForm: true, submits: true, formHint: 'excluir-conta /conta/excluir' }))).toBe('destrutivo');
    expect(click(el({ name: 'OK', inForm: true, submits: true, formHint: 'Cadastro de cliente /clientes' }))).toBe('envio');
  });

  it('teclas, digitar com enviar, upload, download, WhatsApp', () => {
    const field = el({ role: 'textbox', name: 'Nome', tag: 'input', type: 'text', editable: true, inForm: true, formHint: 'Cadastro de cliente' });
    expect(classify({ kind: 'tecla', url: 'https://erp.example/', key: 'Enter', element: field })).toBe('envio');
    expect(classify({ kind: 'tecla', url: 'https://erp.example/', key: 'Tab', element: field })).toBeUndefined();
    expect(classify({ kind: 'tecla', url: 'https://erp.example/', key: 'Enter' })).toBe('mensagem');
    expect(classify({ kind: 'tecla', url: 'https://erp.example/', key: ' ', element: el({ name: 'Excluir', tag: 'button' }) })).toBe('destrutivo');
    expect(classify({ kind: 'digitar', url: 'https://erp.example/', element: field, enviar: true })).toBe('envio');
    expect(classify({ kind: 'digitar', url: 'https://erp.example/', element: field, enviar: false })).toBeUndefined();
    const chat = el({ role: 'textbox', name: 'Escreva uma mensagem', editable: true });
    expect(classify({ kind: 'digitar', url: 'https://chat.example/', element: chat, enviar: true })).toBe('mensagem');
    expect(classify({ kind: 'digitar', url: 'https://loja.example/', element: { ...field, formHint: 'checkout' }, enviar: true })).toBe('dinheiro');
    expect(classify({ kind: 'arquivo', url: 'https://erp.example/' })).toBe('upload');
    expect(classify({ kind: 'download', url: 'https://erp.example/a.zip' })).toBe('download');
    expect(classify({ kind: 'selecionar', url: 'https://erp.example/' })).toBeUndefined();
    for (const a of [
      { kind: 'clicar', url: 'https://web.whatsapp.com/', element: el({ role: 'link', name: 'Conversas' }) },
      { kind: 'digitar', url: 'https://web.whatsapp.com/', element: chat, enviar: false },
      { kind: 'selecionar', url: 'https://web.whatsapp.com/' },
      { kind: 'arquivo', url: 'https://web.whatsapp.com/' },
      { kind: 'tecla', url: 'https://web.whatsapp.com/', key: 'ArrowDown', element: chat },
    ] as const) {
      expect(classify(a), a.kind).toBe('whatsapp');
    }
  });
});

describe('needsApproval: modos × site confiável × categorias', () => {
  const cats: GateCategory[] = ['dinheiro', 'destrutivo', 'mensagem', 'upload', 'envio', 'download', 'whatsapp'];
  const expected: Record<string, GateCategory[]> = {
    cauteloso: cats,
    equilibrado: ['dinheiro', 'destrutivo', 'mensagem', 'upload', 'whatsapp'],
    livre: ['dinheiro', 'whatsapp'],
  };
  for (const mode of BROWSER_MODES) {
    it(`${mode}: pede exatamente o esperado; confiável = livre`, () => {
      for (const c of cats) {
        expect(needsApproval(c, mode, false), `${mode}/${c}`).toBe(expected[mode].includes(c));
        expect(needsApproval(c, mode, true), `${mode}/${c}/confiável`).toBe(expected.livre.includes(c));
      }
      expect(needsApproval(undefined, mode, false)).toBe(false);
    });
  }

  it('modo desconhecido conta como cauteloso; gateReason sem política = cauteloso', () => {
    expect(needsApproval('envio', 'xyz' as never, false)).toBe(true);
    expect(gateReason({ kind: 'clicar', url: 'https://erp.example/', element: el({ name: 'Salvar' }) })).toBeDefined();
  });

  it('judge: Salvar no equilibrado passa; Excluir pede; Pagar pede até em site confiável', () => {
    const p = { mode: 'equilibrado' as const, trusted: false };
    expect(judge({ kind: 'clicar', url: 'https://erp.example/', element: el({ name: 'Salvar', submits: true, inForm: true }) }, p).reason).toBeUndefined();
    expect(judge({ kind: 'clicar', url: 'https://erp.example/', element: el({ name: 'Excluir cliente' }) }, p).reason).toMatch(/excluir/);
    expect(judge({ kind: 'clicar', url: 'https://erp.example/', element: el({ name: 'Pagar' }) }, { mode: 'livre', trusted: true }).reason).toMatch(/pagamento/);
    expect(judge({ kind: 'download', url: 'https://erp.example/' }, p).reason).toBeUndefined();
    expect(judge({ kind: 'arquivo', url: 'https://erp.example/' }, { mode: 'equilibrado', trusted: true }).reason).toBeUndefined();
    expect(judge({ kind: 'tecla', url: 'https://erp.example/', key: 'Enter', element: el({ role: 'textbox', editable: true, inForm: true }) }, p).reason).toBeUndefined();
  });
});

describe('configuração (navegador.json)', () => {
  it('siteKey e parseSite: host:porta com a porta explícita; WhatsApp e lixo recusados', () => {
    expect(siteKey('http://127.0.0.1:4800/painel')).toBe('127.0.0.1:4800');
    expect(siteKey('https://Erp.Example/x')).toBe('erp.example:443');
    expect(siteKey('http://erp.example/')).toBe('erp.example:80');
    expect(siteKey('file:///etc/passwd')).toBeUndefined();
    expect(parseSite('127.0.0.1:4800')).toBe('127.0.0.1:4800');
    expect(parseSite('erp.example')).toBe('erp.example:443');
    expect(parseSite('http://localhost:3000/a')).toBe('localhost:3000');
    for (const bad of ['', 'web.whatsapp.com:443', 'web.whatsapp.com', 'a b', 'x:99999', 42, '../x', 'javascript:alert(1)']) expect(parseSite(bad), String(bad)).toBeUndefined();
  });

  it('arquivo ausente = equilibrado; corrompido = padrão; campos inválidos ignorados', () => {
    const dir = mkdtempSync(join(tmpdir(), 'habblaud-navcfg-'));
    try {
      const file = join(dir, 'navegador.json');
      expect(new BrowserConfigStore(file).get()).toEqual({ modo: 'equilibrado', sitesConfiaveis: [] });
      writeFileSync(file, '{ isto não é json');
      expect(new BrowserConfigStore(file).get()).toEqual({ modo: 'equilibrado', sitesConfiaveis: [] });
      writeFileSync(file, JSON.stringify({ modo: 'turbo', sitesConfiaveis: ['127.0.0.1:4800', 'web.whatsapp.com:443', 7, '127.0.0.1:4800'] }));
      expect(new BrowserConfigStore(file).get()).toEqual({ modo: 'equilibrado', sitesConfiaveis: ['127.0.0.1:4800'] });
      expect(sanitizeConfig(null)).toEqual({ modo: 'equilibrado', sitesConfiaveis: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('update, trust e persistência; inválido não muda nada', () => {
    const dir = mkdtempSync(join(tmpdir(), 'habblaud-navcfg-'));
    try {
      const file = join(dir, 'sub', 'navegador.json');
      const s = new BrowserConfigStore(file);
      expect(s.update({ modo: 'livre' }).modo).toBe('livre');
      expect(s.trust('http://127.0.0.1:4800/clientes/novo')).toBe('127.0.0.1:4800');
      expect(s.trust('https://web.whatsapp.com/')).toBeUndefined();
      expect(s.isTrusted('http://127.0.0.1:4800/outra')).toBe(true);
      expect(s.isTrusted('http://127.0.0.1:4801/')).toBe(false);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ modo: 'livre', sitesConfiaveis: ['127.0.0.1:4800'] });
      expect(() => s.update({ modo: 'turbo' })).toThrow(/modo/);
      expect(() => s.update({ sitesConfiaveis: ['ok.example:443', 'web.whatsapp.com'] })).toThrow(/site inválido/);
      expect(() => s.update([])).toThrow();
      expect(new BrowserConfigStore(file).get()).toEqual({ modo: 'livre', sitesConfiaveis: ['127.0.0.1:4800'] });
      expect(s.update({ sitesConfiaveis: [] }).sitesConfiaveis).toEqual([]);
      expect(s.policy('http://127.0.0.1:4800/')).toEqual({ mode: 'livre', trusted: false });
      expect(new BrowserConfigStore(null, { modo: 'cauteloso' }).get().modo).toBe('cauteloso');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
