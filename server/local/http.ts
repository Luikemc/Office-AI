// Rotas de /api/local (IA local pelo Ollama), usadas pela página do escritório (Novo agente › Ollama e
// Configurações › IA local). O app.ts confere Host local, conexão pelo loopback e, fora do GET, Origin ausente ou da
// mesma origem (o guard já recusou origens de fora e exigiu JSON):
//
//   GET    /api/local/status                 → {ok, url, version?, error?, models, ferramentas, config, agents}
//   PUT    /api/local/config  {url?, modelo?, contexto?, pensar?} → {ok, config}
//   POST   /api/local/agents  {folder, prompt?, model?, ferramentas?, attachments?} → 201 {ok, agent}
//   POST   /api/local/agents/:id/interrupt   → {ok, interrupted}
//   DELETE /api/local/agents/:id             → {ok}
//
// Erros: {ok: false, code, error} (400 invalid, 404 not-found, 429 too-many, 503 unavailable, 500).
// As mensagens a um agente local vão pela rota de sempre (POST /api/messages, messages/registry.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tr } from '../../shared/i18n';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg, log } from '../log';
import { InvalidLocalConfig, type LocalConfigStore } from './config';
import { LocalAgentError, type LocalSource } from './source';

const STATUS: Record<LocalAgentError['code'], number> = { invalid: 400, 'not-found': 404, unavailable: 503, 'too-many': 429 };

function fail(res: ServerResponse, err: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  if (err instanceof LocalAgentError) return sendJson(res, STATUS[err.code], { ok: false, code: err.code, error: err.message });
  if (err instanceof InvalidLocalConfig) return sendJson(res, 400, { ok: false, code: 'invalid', error: err.message });
  if (err instanceof HttpError) return sendJson(res, err.status, { ok: false, code: 'invalid', error: err.message });
  log.warnOnce(`local:${errMsg(err)}`, tr('IA local: erro ({0}).', [errMsg(err)]));
  sendJson(res, 500, { ok: false, code: 'failed', error: errMsg(err).split('\n')[0].slice(0, 300) });
}

function notAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('Allow', allow);
  sendJson(res, 405, { ok: false, error: tr('método não permitido') });
}

export function createLocalRoutes(source: LocalSource, config: LocalConfigStore): (req: IncomingMessage, res: ServerResponse, url: URL) => void {
  return (req, res, url) => {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (path === '/api/local/status') {
      if (method !== 'GET' && method !== 'HEAD') return notAllowed(res, 'GET');
      source
        .status()
        .then((st) => sendJson(res, 200, { ...st, config: config.get(), agents: source.list() }))
        .catch((err) => fail(res, err));
      return;
    }
    if (path === '/api/local/config') {
      if (method === 'GET' || method === 'HEAD') return sendJson(res, 200, { ok: true, config: config.get() });
      if (method !== 'PUT') return notAllowed(res, 'GET, PUT');
      readJson(req)
        .then((body) => sendJson(res, 200, { ok: true, config: config.update(body) }))
        .catch((err) => fail(res, err));
      return;
    }
    if (path === '/api/local/agents') {
      if (method !== 'POST') return notAllowed(res, 'POST');
      readJson(req)
        .then((body) => source.create(body))
        .then((agent) => sendJson(res, 201, { ok: true, agent }))
        .catch((err) => fail(res, err));
      return;
    }
    const m = /^\/api\/local\/agents\/([^/]+)(\/interrupt)?$/.exec(path);
    if (m) {
      let id: string;
      try {
        id = decodeURIComponent(m[1]);
      } catch {
        return sendJson(res, 400, { ok: false, code: 'invalid', error: tr('id inválido') });
      }
      if (m[2]) {
        if (method !== 'POST') return notAllowed(res, 'POST');
        req.resume();
        try {
          return sendJson(res, 200, { ok: true, interrupted: source.interrupt(id) });
        } catch (err) {
          return fail(res, err);
        }
      }
      if (method !== 'DELETE') return notAllowed(res, 'DELETE');
      req.resume();
      if (!source.close(id)) return sendJson(res, 404, { ok: false, code: 'not-found', error: tr('agente local não encontrado') });
      return sendJson(res, 200, { ok: true });
    }
    req.resume();
    sendJson(res, 404, { ok: false, code: 'not-found', error: tr('rota desconhecida') });
  };
}
