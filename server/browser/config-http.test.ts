// GET/PUT /api/browser/config (Configurações › Navegador): Host local, sem acesso de outra origem (nem de outra porta
// local), JSON obrigatório, validação, e a mudança vale na hora para a trava. Não abre o Chrome.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { request, servePermissions, type PermissionServer } from '../test/permission-server';
import { registryGate } from './approval';
import { BrowserConfigStore } from './config';
import { createBrowserRoutes } from './http';
import { BrowserService } from './service';

setQuiet(true);

describe('/api/browser/config', () => {
  let srv: PermissionServer;
  let store: BrowserConfigStore;
  let off: PermissionServer;

  beforeAll(async () => {
    store = new BrowserConfigStore(null);
    srv = await servePermissions({
      browser: (registry) =>
        createBrowserRoutes(
          new BrowserService({
            profileDir: '/nao/usado',
            downloadsDir: '/nao/usado',
            gate: registryGate(registry, 4748),
            config: store,
            launch: async () => {
              throw new Error('o Chrome não abre neste teste');
            },
          }),
        ),
    });
    off = await servePermissions({});
  });

  afterAll(async () => {
    await srv?.close();
    await off?.close();
  });

  it('GET devolve o padrão (equilibrado, sem sites)', async () => {
    const r = await request(srv.base, '/api/browser/config');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, modo: 'equilibrado', sitesConfiaveis: [] });
  });

  it('PUT da própria página (Origin igual) muda na hora; sem Origin (curl) também', async () => {
    const r = await request(srv.base, '/api/browser/config', { method: 'PUT', body: { modo: 'livre', sitesConfiaveis: ['127.0.0.1:4800'] }, headers: { Origin: srv.base } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, modo: 'livre', sitesConfiaveis: ['127.0.0.1:4800'] });
    expect(store.policy('http://127.0.0.1:4800/x')).toEqual({ mode: 'livre', trusted: true });
    const r2 = await request(srv.base, '/api/browser/config', { method: 'PUT', body: { modo: 'cauteloso' } });
    expect(r2.status).toBe(200);
    expect(store.get()).toEqual({ modo: 'cauteloso', sitesConfiaveis: ['127.0.0.1:4800'] });
  });

  it('valores inválidos → 400 e nada muda', async () => {
    for (const body of [{ modo: 'turbo' }, { sitesConfiaveis: ['web.whatsapp.com'] }, { sitesConfiaveis: 'x' }, [1]]) {
      const r = await request(srv.base, '/api/browser/config', { method: 'PUT', body });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(store.get().modo).toBe('cauteloso');
  });

  it('outra origem (site de fora ou outra porta local), Host de fora, sem JSON, POST: recusados', async () => {
    const put = (headers: Record<string, string>, body: unknown = { modo: 'livre' }) => request(srv.base, '/api/browser/config', { method: 'PUT', body, headers });
    expect((await put({ Origin: 'https://evil.example' })).status).toBe(403);
    expect((await put({ Origin: 'http://localhost:5555' })).status).toBe(403);
    expect((await put({ Origin: 'null' })).status).toBe(403);
    expect((await put({ Host: 'habblaud.lan' })).status).toBe(403);
    expect((await put({ 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await request(srv.base, '/api/browser/config', { method: 'POST', body: {} })).status).toBe(405);
    expect((await request(srv.base, '/api/browser/config', { headers: { Host: 'habblaud.lan' } })).status).toBe(403);
    expect(store.get().modo).toBe('cauteloso');
  });

  it('sem navegador: 503', async () => {
    expect((await request(off.base, '/api/browser/config')).status).toBe(503);
  });
});
