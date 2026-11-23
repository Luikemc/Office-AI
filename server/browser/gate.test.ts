// Trava do navegador (classificação) e fotografia da página (refs por revisão, limites, primeiro o que está na tela).
import { describe, expect, it } from 'vitest';
import { gateReason, lockedSite, riskyText, type ElementFacts } from './gate';
import { parseRef, publicRef, renderSnapshot } from './snapshot';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSession, checkUploads, normalizeUrl, parsePoint } from './service';

const el = (over: Partial<ElementFacts> = {}): ElementFacts => ({ role: 'button', name: '', ...over });
const click = (element: ElementFacts, url = 'https://loja.example/x') => gateReason({ kind: 'clicar', url, element });

describe('gateReason', () => {
  it('leitura e navegação passam: link comum, botão "Próxima página", checkbox num formulário', () => {
    expect(click(el({ role: 'link', name: 'Ver detalhes', href: 'https://loja.example/p/1' }))).toBeUndefined();
    expect(click(el({ name: 'Próxima página' }))).toBeUndefined();
    expect(click(el({ role: 'checkbox', name: 'Lembrar de mim', inForm: true, formHint: 'enviar-pedido' }))).toBeUndefined();
    expect(click(el({ name: 'Menu', tag: 'button', type: 'button', inForm: false }))).toBeUndefined();
  });

  it('palavras de enviar/pagar/confirmar/apagar/publicar (pt, en, es; sem acentos e maiúsculas)', () => {
    for (const name of ['Enviar', 'ENVIAR MENSAGEM', 'Send', 'Submit', 'Pagar agora', 'Pay now', 'Comprar', 'Finalizar compra', 'Confirmar', 'Excluir conta', 'Apagar', 'Delete', 'Publicar', 'Postar', 'Eliminar', 'Borrar', 'Fazer pedido', 'Place order', 'Pix']) {
      expect(click(el({ name })), name).toBeDefined();
    }
    expect(riskyText('Página 2')).toBe(false);
    expect(riskyText('Postagens recentes')).toBe(false);
    expect(riskyText('Envío gratis')).toBe(true);
  });

  it('o texto do próprio elemento também conta (ícone com aria-label)', () => {
    expect(click(el({ name: '', text: 'Excluir' }))).toBeDefined();
  });

  it('botão que submete um formulário (type=submit, input submit/image) trava mesmo sem palavra', () => {
    expect(click(el({ name: 'OK', tag: 'button', type: 'submit', submits: true, inForm: true }))).toMatch(/formulário/);
    expect(click(el({ name: 'Ir', tag: 'input', type: 'image', inForm: true }))).toMatch(/formulário/);
    expect(click(el({ name: 'Ir', role: 'button', inForm: true, formHint: 'checkout' }))).toBeDefined();
  });

  it('digitar só trava com enviar=true; no WhatsApp a ação segue sem pedir', () => {
    const field = el({ role: 'textbox', name: 'Mensagem' });
    expect(gateReason({ kind: 'digitar', url: 'https://x.example', element: field, enviar: false })).toBeUndefined();
    expect(gateReason({ kind: 'digitar', url: 'https://x.example', element: field, enviar: true })).toBeDefined();
    expect(gateReason({ kind: 'digitar', url: 'https://web.whatsapp.com/', element: field, enviar: false })).toBeUndefined();
    expect(gateReason({ kind: 'digitar', url: 'https://web.whatsapp.com/', element: field, enviar: true })).toBeUndefined();
    expect(click(el({ role: 'link', name: 'Conversas' }), 'https://web.whatsapp.com/')).toBeUndefined();
    expect(lockedSite('https://whatsapp.com.evil.example/')).toBe(false);
    expect(gateReason({ kind: 'download', url: 'https://x.example/a.zip' })).toBeDefined();
  });
});

describe('trava das ferramentas novas', () => {
  const field = el({ role: 'textbox', name: 'Nome', tag: 'input', type: 'text', editable: true, inForm: true });
  const key = (k: string, element?: ElementFacts, url = 'https://erp.example/') => gateReason({ kind: 'tecla', url, key: k, element });

  it('tecla: Enter num campo de formulário trava; Tab, setas e Escape passam; foco desconhecido + Enter trava', () => {
    expect(key('Enter', field)).toMatch(/Enter/);
    expect(key('Control+Enter', field)).toBeDefined();
    expect(key('Meta+Enter', el({ role: 'textbox', tag: 'textarea', editable: true }))).toBeDefined();
    for (const k of ['Tab', 'ArrowDown', 'Escape', 'PageDown', 'Control+a', 'a']) expect(key(k, field), k).toBeUndefined();
    expect(key('Enter')).toBeDefined();
    expect(key('Enter', el({ role: 'body', tag: 'body' }))).toBeUndefined();
    expect(key('Enter', el({ role: 'link', name: 'Clientes', tag: 'a', href: 'https://erp.example/c' }))).toBeUndefined();
  });

  it('tecla: Enter ou Espaço num botão que envia trava como o clique; no WhatsApp a tecla segue', () => {
    const salvar = el({ role: 'button', name: 'Salvar', tag: 'button', type: 'submit', submits: true, inForm: true });
    expect(key('Enter', salvar)).toBeDefined();
    expect(key(' ', salvar)).toBeDefined();
    expect(key('Space', salvar)).toBeDefined();
    expect(key('Enter', el({ role: 'button', name: 'Menu', tag: 'button', type: 'button' }))).toBeUndefined();
    expect(key('ArrowDown', field, 'https://web.whatsapp.com/')).toBeUndefined();
    expect(key('Enter', field, 'https://web.whatsapp.com/')).toBeUndefined();
  });

  it('selecionar não trava; enviar arquivo sempre trava', () => {
    expect(gateReason({ kind: 'selecionar', url: 'https://erp.example/' })).toBeUndefined();
    expect(gateReason({ kind: 'selecionar', url: 'https://web.whatsapp.com/' })).toBeUndefined();
    expect(gateReason({ kind: 'arquivo', url: 'https://erp.example/' })).toMatch(/arquivos/);
  });
});

describe('fotografia', () => {
  const tree = [
    {
      role: 'generic',
      ref: 'e1',
      children: [
        { role: 'heading', name: 'Olá', level: 1, ref: 'e2' },
        { role: 'paragraph', ref: 'e3', text: 'texto livre' },
        { role: 'textbox', name: 'Nome', ref: 'e6', text: 'abc' },
        { role: 'button', name: 'Enviar', disabled: true, ref: 'e7' },
        { role: 'iframe', ref: 'e13', children: [{ role: 'button', name: 'No iframe', ref: 'f1e2' }] },
      ],
    },
  ];

  it('refs só nos elementos de ação, com a revisão; genéricos vazios somem', () => {
    const s = renderSnapshot(tree, 4, null);
    expect(s.text).toBe(
      [
        '- heading "Olá" [level=1]',
        '- paragraph: texto livre',
        '- textbox "Nome" [ref=r4-e6]: abc',
        '- button "Enviar" [disabled] [ref=r4-e7]',
        '- iframe',
        '  - button "No iframe" [ref=r4-f1e2]',
      ].join('\n'),
    );
    expect([...s.elements.keys()]).toEqual(['r4-e6', 'r4-e7', 'r4-f1e2']);
    expect(s.elements.get('r4-f1e2')).toEqual({ raw: 'f1e2', role: 'button', name: 'No iframe' });
    expect(s.truncated).toBe(false);
  });

  it('parseRef: só o formato rN-eM / rN-fKeM', () => {
    expect(parseRef(publicRef(3, 'e7'))).toEqual({ revision: 3, raw: 'e7' });
    expect(parseRef('r12-f1e3')).toEqual({ revision: 12, raw: 'f1e3' });
    for (const bad of ['e7', 'r3-x7', 'r3-e7; drop', 'r-e1', '']) expect(parseRef(bad), bad).toBeUndefined();
  });

  it('limites: elementos e texto; cortando, primeiro o que está na tela', () => {
    const many = { role: 'list', name: 'itens', children: Array.from({ length: 300 }, (_, i) => ({ role: 'link', name: `item ${i}`, ref: `e${i + 10}` })) };
    const s = renderSnapshot([many], 1, null, { maxElements: 200 });
    expect(s.elements.size).toBe(200);
    expect(s.truncated).toBe(true);

    const vp = { width: 800, height: 600 };
    const page = [
      { role: 'paragraph', ref: 'e1', text: 'x'.repeat(250), box: { x: 0, y: 5000, width: 800, height: 20 } },
      { role: 'paragraph', ref: 'e2', text: 'na tela', box: { x: 0, y: 10, width: 800, height: 20 } },
      { role: 'paragraph', ref: 'e3', text: 'y'.repeat(250), box: { x: 0, y: 6000, width: 800, height: 20 } },
    ];
    const cut = renderSnapshot(page, 1, vp, { maxText: 320 });
    expect(cut.truncated).toBe(true);
    expect(cut.text.split('\n').slice(0, 3)).toEqual(['# na tela', '- paragraph: na tela', '# fora da tela']);
    expect(cut.text.length).toBeLessThanOrEqual(320);
    expect(cut.parts).toBeGreaterThan(1);
  });

  it('partes: a página inteira na ordem, cada parte dentro dos limites, refs só da parte', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ role: 'link', name: `linha ${i + 1}`, ref: `e${i + 10}` }));
    const all = renderSnapshot(rows, 2, null, { maxText: 400, maxElements: 15 });
    expect(all.truncated).toBe(true);
    const seen: string[] = [];
    for (let k = 1; k <= all.parts; k++) {
      const s = renderSnapshot(rows, 2, null, { maxText: 400, maxElements: 15, part: k });
      expect(s.part).toBe(k);
      expect(s.parts).toBe(all.parts);
      expect(s.text.length).toBeLessThanOrEqual(400);
      expect(s.elements.size).toBeLessThanOrEqual(15);
      for (const [r, info] of s.elements) expect(s.text).toContain(`[ref=${r}]`), seen.push(info.name);
    }
    expect(seen).toEqual(rows.map((r) => r.name));
    // Parte além do fim: a última.
    expect(renderSnapshot(rows, 2, null, { maxText: 400, maxElements: 15, part: 999 }).part).toBe(all.parts);
    // Página pequena: uma parte só.
    expect(renderSnapshot(tree, 1, null, { part: 1 })).toMatchObject({ parts: 1, part: 1, truncated: false });
  });
});

describe('entradas', () => {
  it('url: só http/https; sem esquema vira https', () => {
    expect(normalizeUrl('exemplo.com')).toBe('https://exemplo.com/');
    expect(normalizeUrl('http://127.0.0.1:8080/a')).toBe('http://127.0.0.1:8080/a');
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'data:text/html,x', '', 42]) expect(() => normalizeUrl(bad), String(bad)).toThrow();
  });

  it('arquivos para enviar: só dentro da pasta do projeto, sem "..", sem link para fora, existentes', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'habblaud-up-'));
    try {
      const proj = join(tmp, 'proj');
      mkdirSync(join(proj, 'sub'), { recursive: true });
      writeFileSync(join(proj, 'sub', 'a.txt'), 'abc');
      writeFileSync(join(tmp, 'fora.txt'), 'x');
      symlinkSync(join(tmp, 'fora.txt'), join(proj, 'link.txt'));
      symlinkSync(join(proj, 'sub', 'a.txt'), join(proj, 'dentro.txt'));
      expect(checkUploads(proj, ['sub/a.txt']).map((f) => [f.rel, f.size])).toEqual([[join('sub', 'a.txt'), 3]]);
      expect(checkUploads(proj, [join(proj, 'sub', 'a.txt'), 'dentro.txt']).map((f) => f.rel)).toEqual([join('sub', 'a.txt'), join('sub', 'a.txt')]);
      for (const bad of [['../fora.txt'], ['sub/../../fora.txt'], [join(tmp, 'fora.txt')], ['link.txt'], ['nao.txt'], ['sub'], [], ['.'], Array(11).fill('sub/a.txt'), [42]]) {
        expect(() => checkUploads(proj, bad), JSON.stringify(bad)).toThrow();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('sessionId: texto curto e sem caracteres estranhos', () => {
    expect(checkSession('2b89ac5e-4444-4407-97ee-9f727991e71f')).toBeTruthy();
    for (const bad of ['', '../x', 'a b', undefined, 'x'.repeat(201)]) expect(() => checkSession(bad)).toThrow();
  });

  it('parsePoint: pixel da foto 1280×800, canto superior esquerdo', () => {
    expect(parsePoint(0, 0, 1280, 800)).toEqual({ x: 0, y: 0 });
    expect(parsePoint(12.4, 799.2, 1280, 800)).toEqual({ x: 12, y: 799 });
    expect(parsePoint('40', '10', 1280, 800)).toEqual({ x: 40, y: 10 });
    expect(parsePoint(1280, 0, 1280, 800)).toBeUndefined();
    expect(parsePoint(-1, 10, 1280, 800)).toBeUndefined();
    expect(parsePoint('x', 10, 1280, 800)).toBeUndefined();
  });
});
