// Rotas de /api/browser (o MCP do plugin mod/navegador). A trava de borda (porta local, Host e conexão pelo loopback,
// sem Origin) já foi conferida em http/app.ts; o guard já exigiu JSON nos POST.
//
//   POST /api/browser/abrir     {sessionId, url}                          → {ok, aba, texto}
//   POST /api/browser/ler       {sessionId, tabId}                        → {ok, aba, texto}
//   POST /api/browser/clicar    {sessionId, tabId, ref, elemento}         → {ok, aba, texto}
//   POST /api/browser/digitar   {sessionId, tabId, ref, texto, enviar?}   → {ok, aba, texto}
//   POST /api/browser/abas      {sessionId}                               → {ok, abas}
//   POST /api/browser/fechar    {sessionId, tabId}                        → {ok, fechada}
//   POST /api/browser/whatsapp_status {sessionId}                         → {ok, estado, texto}
//   POST /api/browser/whatsapp_enviar {sessionId, contato, texto}         → {ok, contato, confirmado, texto}
//   POST /api/browser/whatsapp_ler    {sessionId, contato, quantas?}      → {ok, contato, mensagens, texto}
//   GET  /api/browser/screenshot?sessionId=&tabId=                       → image/jpeg da aba (a mais nova sem tabId)
//
// Erros: {ok: false, code, error} (400 invalid, 404 not-found, 409 stale/not-ready/ambiguous, 403 denied, 429 too-many,
// 503 disabled, 500).
// Uma ação que espera a aprovação no escritório segura a requisição até a resposta (até APPROVAL_TIMEOUT_MS): o MCP
// usa node:http sem tempo limite. Se a conexão cair antes, o pedido sai do escritório e a ação não roda.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from '../http/app';
import { tr } from '../../shared/i18n';
import { errMsg, log } from '../log';
import { BrowserError, type BrowserService } from './service';

const STATUS: Record<BrowserError['code'], number> = { invalid: 400, 'not-found': 404, stale: 409, denied: 403, 'too-many': 429, disabled: 503, failed: 500, 'not-ready': 409, ambiguous: 409 };

const ACTIONS = new Set(['abrir', 'ler', 'clicar', 'digitar', 'abas', 'fechar', 'whatsapp_status', 'whatsapp_enviar', 'whatsapp_ler']);

type Rec = Record<string, unknown>;

function fail(res: ServerResponse, err: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) return void res.destroy();
  if (err instanceof BrowserError) return sendJson(res, STATUS[err.code], { ok: false, code: err.code, error: err.message });
  if (err instanceof HttpError) return sendJson(res, err.status, { ok: false, code: 'invalid', error: err.message });
  log.warnOnce(`browser:${errMsg(err)}`, tr('Navegador: erro ({0}).', [errMsg(err)]));
  sendJson(res, 500, { ok: false, code: 'failed', error: errMsg(err).split('\n')[0].slice(0, 300) });
}

export function createBrowserRoutes(browser: BrowserService): (req: IncomingMessage, res: ServerResponse, url: URL) => void {
  const act = async (action: string, body: Rec, signal: AbortSignal): Promise<Rec> => {
    const sid = body.sessionId as string;
    switch (action) {
      case 'abrir':
        return { ok: true, ...(await browser.abrir(sid, body.url)) };
      case 'ler':
        return { ok: true, ...(await browser.ler(sid, body.tabId)) };
      case 'clicar':
        return { ok: true, ...(await browser.clicar(sid, body.tabId, body.ref, body.elemento, signal)) };
      case 'digitar':
        return { ok: true, ...(await browser.digitar(sid, body.tabId, body.ref, body.texto, body.enviar, body.elemento, signal)) };
      case 'whatsapp_status':
        return { ok: true, ...(await browser.whatsappStatus(sid)) };
      case 'whatsapp_enviar':
        return { ok: true, ...(await browser.whatsappEnviar(sid, body.contato, body.texto, signal)) };
      case 'whatsapp_ler':
        return { ok: true, ...(await browser.whatsappLer(sid, body.contato, body.quantas)) };
      case 'abas':
        return { ok: true, abas: await browser.abas(sid) };
      default:
        return { ok: true, ...(await browser.fechar(sid, body.tabId)) };
    }
  };

  return (req, res, url) => {
    const action = url.pathname.slice('/api/browser/'.length);
    const method = req.method ?? 'GET';
    if (action === 'screenshot') {
      if (method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return sendJson(res, 405, { ok: false, error: tr('método não permitido') });
      }
      const tabId = url.searchParams.get('tabId') ?? undefined;
      browser.screenshot(url.searchParams.get('sessionId') ?? '', tabId).then(
        (jpg) => {
          if (res.destroyed) return;
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpg.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          res.end(jpg);
        },
        (err) => fail(res, err),
      );
      return;
    }
    if (!ACTIONS.has(action)) return sendJson(res, 404, { ok: false, error: tr('rota desconhecida') });
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendJson(res, 405, { ok: false, error: tr('método não permitido') });
    }
    // Espera de aprovação: sem tempo limite no socket; conexão fechada = desistiu (a trava solta o pedido).
    req.socket.setTimeout(0);
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });
    readJson(req)
      .then((raw) => {
        const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Rec) : {};
        return act(action, body, ac.signal);
      })
      .then(
        (out) => {
          if (!res.destroyed && !res.writableEnded) sendJson(res, 200, out);
        },
        (err) => fail(res, err),
      );
  };
}
