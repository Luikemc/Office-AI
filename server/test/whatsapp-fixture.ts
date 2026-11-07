// Página local que imita a estrutura do WhatsApp Web (só para os testes; nunca se abre o site de verdade): lista de
// conversas em #side/#pane-side com busca, resultados com seções "Conversas"/"Mensagens", conversa em #main com
// cabeçalho, compositor contenteditable no footer (Enter envia, Shift+Enter quebra linha) e mensagens
// .message-in/.message-out. Modos (GET /state, que a página consulta a cada 200 ms): logado, QR, outra janela,
// navegador incompatível, carregando. A página conta ao servidor o que foi enviado (POST /sent) e o rascunho (POST /draft).
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type FixtureMode = 'logged' | 'qr' | 'unsupported' | 'other-window' | 'loading';

const PAGE = String.raw`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>WhatsApp</title>
<style>body{font:14px sans-serif;margin:0}#app{display:flex}#side{width:320px}#main{flex:1}.sel{white-space:pre-wrap}[role=row]{padding:6px;cursor:pointer}</style>
</head><body><div id="app"></div><script>
const CHATS = [
  { id: 'ana', name: 'Ana', msgs: [{ out: false, text: 'Oi, aqui é a Ana' }, { out: true, text: 'Oi Ana!' }] },
  { id: 'anap', name: 'Ana Paula', msgs: [] },
  { id: 'b1', name: 'Bruno', msgs: [] },
  { id: 'b2', name: 'Bruno', msgs: [] },
  { id: 'fam', name: 'Família', group: true, msgs: [{ out: false, text: 'bom dia' }] },
  { id: 'carla', name: 'Carla', header: 'Carla Mendes', msgs: [] },
  { id: 'jose', name: 'José', msgs: [] },
];
let mode = null;
let open = null;
let seq = 0;
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
};
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function chatItem(c, role) {
  const row = el('div', { role: 'row', tabindex: '-1' },
    el('span', { 'data-icon': c.group ? 'default-group' : 'default-user' }),
    el('span', { dir: 'auto', title: c.name }, c.name),
    el('span', { title: c.msgs.at(-1)?.text ?? '' }, c.msgs.at(-1)?.text ?? ''));
  row.addEventListener('click', () => openChat(c));
  return role === 'listitem' ? el('div', { role: 'listitem' }, row) : row;
}
function renderList() {
  const q = norm(document.getElementById('busca').value.trim());
  const list = document.getElementById('lista');
  list.replaceChildren();
  if (!q) {
    for (const c of CHATS) list.append(chatItem(c, 'row'));
    return;
  }
  list.append(el('div', { role: 'listitem' }, 'Conversas'));
  for (const c of CHATS) if (norm(c.name).includes(q)) list.append(chatItem(c, 'listitem'));
  list.append(el('div', { role: 'listitem' }, 'Mensagens'));
  for (const c of CHATS) for (const m of c.msgs) if (norm(m.text).includes(q)) {
    const r = el('div', { role: 'listitem' }, el('span', { dir: 'auto', title: c.name }, c.name), el('span', {}, m.text));
    r.addEventListener('click', () => openChat(c));
    list.append(r);
  }
}
function msgEl(c, m) {
  const id = (m.out ? 'true_' : 'false_') + c.id + '_' + (m.id ??= ++seq);
  return el('div', { 'data-id': id },
    el('div', { class: m.out ? 'message-out' : 'message-in' },
      el('div', { class: 'copyable-text', 'data-pre-plain-text': '[10:0' + (seq % 10) + ', 06/11/2026] ' + (m.out ? 'Eu' : c.name) + ': ' },
        el('span', { class: 'selectable-text sel', dir: 'ltr' }, m.text)),
      el('span', { 'data-icon': m.out ? 'msg-time' : '' })));
}
function send() {
  const box = document.getElementById('composer');
  const text = box.innerText.replace(/\n$/, '');
  if (!text.trim() || !open) return;
  const c = open;
  box.replaceChildren();
  post('/draft', { chat: c.name, text: '' });
  setTimeout(() => {
    const m = { out: true, text };
    c.msgs.push(m);
    document.getElementById('msgs').append(msgEl(c, m));
    post('/sent', { chat: c.name, text });
  }, 300);
}
function openChat(c) {
  open = c;
  const head = el('header', {},
    el('span', { 'data-icon': c.group ? 'default-group' : 'default-user' }),
    el('div', {}, el('span', { dir: 'auto', title: c.header ?? c.name }, c.header ?? c.name)),
    el('div', {}, el('span', {}, c.group ? 'clique para dados do grupo' : 'online')));
  const msgs = el('div', { id: 'msgs' });
  for (const m of c.msgs) msgs.append(msgEl(c, m));
  const box = el('div', { contenteditable: 'true', role: 'textbox', 'aria-label': 'Digite uma mensagem', id: 'composer', 'data-tab': '10' });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  box.addEventListener('input', () => post('/draft', { chat: c.name, text: box.innerText }));
  const btn = el('button', { 'aria-label': 'Enviar', 'data-icon': 'send' }, '>');
  btn.addEventListener('click', send);
  const main = el('div', { id: 'main' }, head, msgs, el('footer', {}, box, btn));
  document.getElementById('main')?.remove();
  document.getElementById('app').append(main);
}
function render() {
  const app = document.getElementById('app');
  app.replaceChildren();
  open = null;
  if (mode === 'logged') {
    const busca = el('input', { type: 'text', role: 'textbox', id: 'busca', 'aria-label': 'Pesquisar ou começar uma nova conversa' });
    busca.addEventListener('input', () => setTimeout(renderList, 250));
    app.append(el('div', { id: 'side' }, el('header', {}, 'Conversas'), el('div', {}, busca),
      el('div', { id: 'pane-side' }, el('div', { role: 'grid', 'aria-label': 'Lista de conversas', id: 'lista' }))));
    renderList();
  } else if (mode === 'qr') {
    app.append(el('div', {}, el('h1', {}, 'Use o WhatsApp no seu computador'),
      el('div', { 'data-ref': '2@abc' }, el('canvas', { 'aria-label': 'Scan this QR code to link a device!', width: '64', height: '64' }))));
  } else if (mode === 'unsupported') {
    app.append(el('h1', {}, 'O WhatsApp funciona com o Google Chrome 85 e mais recentes'));
  } else if (mode === 'other-window') {
    app.append(el('p', {}, 'O WhatsApp está aberto em outra janela. Clique em “Usar aqui” para usar o WhatsApp nesta janela.'), el('button', {}, 'Usar aqui'));
  } else {
    app.append(el('progress', {}), el('p', {}, 'Carregando suas conversas'));
  }
}
async function poll() {
  try {
    const j = await (await fetch('/state')).json();
    if (j.mode !== mode) {
      mode = j.mode;
      render();
    }
  } catch {}
  setTimeout(poll, 200);
}
poll();
</script></body></html>`;

export interface WhatsappFixture {
  base: string;
  mode: FixtureMode;
  sent: Array<{ chat: string; text: string }>;
  drafts: Array<{ chat: string; text: string }>;
  close(): Promise<void>;
}

export function serveWhatsappFixture(mode: FixtureMode = 'logged'): Promise<WhatsappFixture> {
  const fx = { mode, sent: [], drafts: [] } as unknown as WhatsappFixture;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'POST' && (u.pathname === '/sent' || u.pathname === '/draft')) {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        (u.pathname === '/sent' ? fx.sent : fx.drafts).push(JSON.parse(data) as { chat: string; text: string });
        res.writeHead(204).end();
      });
      return;
    }
    if (u.pathname === '/state') return void res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ mode: fx.mode }));
    if (u.pathname === '/') return void res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
    res.writeHead(404).end();
  });
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => {
      fx.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      fx.close = () => new Promise((done) => server.close(() => done()));
      ok(fx);
    }),
  );
}
