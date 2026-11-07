// "Sistema Exemplo": um sistema interno de mentira, local, para testar o navegador do escritório como num sistema de
// verdade (nunca se abre um site de fora). Tem login com usuário e senha (cookie), painel com menu de passar o mouse,
// uma tabela de 300 clientes (longa: precisa de `rolar`/`ler parte`), o formulário "Novo cliente" (campos de texto,
// <select> de UF, checkbox, arquivo e o botão Salvar, que envia), uma página lenta (o texto aparece depois de 2 s) e um
// gráfico em <canvas> (só dá para ver com `ver_tela`). Testes: startSistemaExemplo() numa porta livre;
// à mão: npm run sistema:exemplo (porta 4800).
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Credenciais fixas de teste (não são segredo: só existem neste sistema de mentira). */
export const CREDENCIAIS = { usuario: 'admin', senha: 'exemplo123' } as const;

export const UFS: ReadonlyArray<[string, string]> = [
  ['AC', 'Acre'],
  ['AL', 'Alagoas'],
  ['AM', 'Amazonas'],
  ['BA', 'Bahia'],
  ['CE', 'Ceará'],
  ['DF', 'Distrito Federal'],
  ['ES', 'Espírito Santo'],
  ['GO', 'Goiás'],
  ['MG', 'Minas Gerais'],
  ['PA', 'Pará'],
  ['PR', 'Paraná'],
  ['PE', 'Pernambuco'],
  ['RJ', 'Rio de Janeiro'],
  ['RS', 'Rio Grande do Sul'],
  ['SC', 'Santa Catarina'],
  ['SP', 'São Paulo'],
];

export interface Cadastro {
  nome: string;
  email: string;
  uf: string;
  ativo: boolean;
  arquivo?: { nome: string; tamanho: number; conteudo: string };
}

export interface SistemaExemplo {
  base: string;
  port: number;
  /** Cadastros recebidos pelo "Salvar" (na ordem). */
  cadastros: Cadastro[];
  /** Logins que deram certo. */
  logins: number;
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, opts: { menu?: boolean } = {}): string {
  const menu = opts.menu
    ? `<nav aria-label="Menu principal">
  <div class="menu"><button type="button" aria-haspopup="true">Cadastros</button>
    <ul class="sub" role="menu">
      <li role="none"><a role="menuitem" href="/clientes">Clientes</a></li>
      <li role="none"><a role="menuitem" href="/clientes/novo">Novo cliente</a></li>
    </ul></div>
  <a href="/relatorio">Relatório lento</a> <a href="/grafico">Gráfico de vendas</a> <a href="/logout">Encerrar sessão</a>
</nav>`
    : '';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(title)} · Sistema Exemplo</title>
<style>body{font:14px sans-serif;margin:16px}.menu{display:inline-block;position:relative}.sub{display:none;position:absolute;background:#fff;border:1px solid #999;margin:0;padding:6px;list-style:none;width:160px}.menu:hover .sub{display:block}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:2px 6px}</style>
</head><body>${menu}<main>${body}</main></body></html>`;
}

const LOGIN = (erro = '') =>
  page(
    'Entrar',
    `<h1>Sistema Exemplo</h1>${erro ? `<p role="alert">${esc(erro)}</p>` : ''}
<form method="post" action="/login" aria-label="Entrar no sistema">
  <p><label>Usuário <input name="usuario" autocomplete="username"></label></p>
  <p><label>Senha <input name="senha" type="password" autocomplete="current-password"></label></p>
  <p><button>Entrar</button></p>
</form>`,
  );

const CIDADES = ['São Paulo', 'Rio de Janeiro', 'Belo Horizonte', 'Curitiba', 'Salvador', 'Recife'];
const CIDADE_UF = ['SP', 'RJ', 'MG', 'PR', 'BA', 'PE'];

function clientes(extra: Cadastro[]): string {
  const rows: string[] = [];
  for (let i = 1; i <= 300; i++) {
    const n = String(i).padStart(3, '0');
    rows.push(`<tr><td>${i}</td><td>Cliente ${n}</td><td>cliente${n}@exemplo.test</td><td>${CIDADES[i % 6]}</td><td>${CIDADE_UF[i % 6]}</td></tr>`);
  }
  extra.forEach((c, k) => rows.push(`<tr><td>${301 + k}</td><td>${esc(c.nome)}</td><td>${esc(c.email)}</td><td>—</td><td>${esc(c.uf)}</td></tr>`));
  return page(
    'Clientes',
    `<h1>Clientes</h1><p>${300 + extra.length} clientes cadastrados.</p>
<table aria-label="Clientes"><thead><tr><th>#</th><th>Nome</th><th>E-mail</th><th>Cidade</th><th>UF</th></tr></thead><tbody>${rows.join('')}</tbody></table>
<p>Fim da lista de clientes.</p>`,
    { menu: true },
  );
}

const NOVO = () =>
  page(
    'Novo cliente',
    `<h1>Novo cliente</h1>
<form method="post" action="/clientes" enctype="multipart/form-data" aria-label="Cadastro de cliente">
  <p><label>Nome <input name="nome"></label></p>
  <p><label>E-mail <input name="email" type="email"></label></p>
  <p><label>UF <select name="uf"><option value="">Escolha…</option>${UFS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label></p>
  <p><label><input type="checkbox" name="ativo" value="sim"> Cliente ativo</label></p>
  <p><label>Documento <input type="file" name="documento"></label></p>
  <p><button>Salvar</button> <a href="/painel">Voltar ao painel</a></p>
</form>`,
    { menu: true },
  );

const RELATORIO = () =>
  page(
    'Relatório',
    `<h1>Relatório mensal</h1><p id="st">Carregando relatório…</p>
<script>setTimeout(() => { document.getElementById('st').textContent = 'Relatório pronto: 42 pedidos em outubro.'; }, 2000);</script>`,
    { menu: true },
  );

const GRAFICO = () =>
  page(
    'Gráfico',
    `<h1>Vendas por mês</h1><canvas id="c" width="600" height="300"></canvas>
<script>
const c = document.getElementById('c').getContext('2d');
c.fillStyle = '#fff'; c.fillRect(0, 0, 600, 300);
const v = [120, 180, 90, 240, 200, 280];
v.forEach((h, i) => { c.fillStyle = i === 5 ? '#d33' : '#36c'; c.fillRect(40 + i * 90, 280 - h, 60, h); });
</script>`,
    { menu: true },
  );

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

/** multipart/form-data simples: campos de texto e arquivos (o bastante para o formulário daqui). */
function parseMultipart(body: Buffer, contentType: string): Map<string, { value: string; filename?: string; size: number }> {
  const out = new Map<string, { value: string; filename?: string; size: number }>();
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return out;
  const boundary = `--${m[1] ?? m[2]}`;
  const raw = body.toString('latin1');
  for (const part of raw.split(boundary)) {
    const sepAt = part.indexOf('\r\n\r\n');
    if (sepAt < 0) continue;
    const head = part.slice(0, sepAt);
    let content = part.slice(sepAt + 4);
    if (content.endsWith('\r\n')) content = content.slice(0, -2);
    const name = /name="([^"]*)"/i.exec(head)?.[1];
    if (!name) continue;
    const filename = /filename="([^"]*)"/i.exec(head)?.[1];
    const buf = Buffer.from(content, 'latin1');
    out.set(name, { value: buf.toString('utf8'), filename: filename !== undefined ? Buffer.from(filename, 'latin1').toString('utf8') : undefined, size: buf.length });
  }
  return out;
}

export async function startSistemaExemplo(port = 0, host = '127.0.0.1'): Promise<SistemaExemplo> {
  const sessions = new Set<string>();
  const state = { cadastros: [] as Cadastro[], logins: 0 };
  const html = (res: http.ServerResponse, body: string, status = 200, headers: Record<string, string> = {}) =>
    void res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers }).end(body);
  const go = (res: http.ServerResponse, to: string, headers: Record<string, string> = {}) => void res.writeHead(303, { Location: to, ...headers }).end();

  const server = http.createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? '/', 'http://x');
      const cookie = /(?:^|;\s*)sessao=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1];
      const logged = !!cookie && sessions.has(cookie);
      const method = req.method ?? 'GET';
      if (u.pathname === '/login' && method === 'GET') return html(res, LOGIN());
      if (u.pathname === '/login' && method === 'POST') {
        const form = new URLSearchParams((await readBody(req)).toString('utf8'));
        if (form.get('usuario') === CREDENCIAIS.usuario && form.get('senha') === CREDENCIAIS.senha) {
          const token = randomBytes(12).toString('base64url');
          sessions.add(token);
          state.logins++;
          return go(res, '/painel', { 'Set-Cookie': `sessao=${token}; HttpOnly; Path=/; SameSite=Lax` });
        }
        return html(res, LOGIN('Usuário ou senha inválidos.'), 401);
      }
      if (!logged) return go(res, '/login');
      if (u.pathname === '/' || u.pathname === '/painel') {
        return html(res, page('Painel', `<h1>Painel</h1><p>Bem-vindo, ${esc(CREDENCIAIS.usuario)}. Use o menu Cadastros.</p>`, { menu: true }));
      }
      if (u.pathname === '/clientes' && method === 'GET') return html(res, clientes(state.cadastros));
      if (u.pathname === '/clientes/novo') return html(res, NOVO());
      if (u.pathname === '/clientes' && method === 'POST') {
        const parts = parseMultipart(await readBody(req), String(req.headers['content-type'] ?? ''));
        const doc = parts.get('documento');
        const c: Cadastro = {
          nome: parts.get('nome')?.value ?? '',
          email: parts.get('email')?.value ?? '',
          uf: parts.get('uf')?.value ?? '',
          ativo: parts.get('ativo')?.value === 'sim',
          ...(doc?.filename ? { arquivo: { nome: doc.filename, tamanho: doc.size, conteudo: doc.value.slice(0, 200) } } : {}),
        };
        state.cadastros.push(c);
        return go(res, `/clientes/salvo?n=${state.cadastros.length}`);
      }
      if (u.pathname === '/clientes/salvo') {
        const c = state.cadastros[Number(u.searchParams.get('n')) - 1];
        if (!c) return html(res, page('Não achado', '<p>Cadastro não encontrado.</p>', { menu: true }), 404);
        const arq = c.arquivo ? `${esc(c.arquivo.nome)} (${c.arquivo.tamanho} bytes)` : 'nenhum';
        return html(res, page('Cliente salvo', `<h1>Cliente salvo</h1><p>Nome: ${esc(c.nome)} · UF: ${esc(c.uf || '—')} · Ativo: ${c.ativo ? 'sim' : 'não'} · Documento: ${arq}</p>`, { menu: true }));
      }
      if (u.pathname === '/relatorio') return html(res, RELATORIO());
      if (u.pathname === '/grafico') return html(res, GRAFICO());
      if (u.pathname === '/logout') {
        if (cookie) sessions.delete(cookie);
        return go(res, '/login', { 'Set-Cookie': 'sessao=; Path=/; Max-Age=0' });
      }
      return html(res, page('Não achado', '<p>Página não encontrada.</p>', { menu: true }), 404);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end('erro');
    });
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => ok());
  });
  const actual = (server.address() as AddressInfo).port;
  return {
    base: `http://${host}:${actual}`,
    port: actual,
    get cadastros() {
      return state.cadastros;
    },
    get logins() {
      return state.logins;
    },
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
