// Plugins do Claude Code no próprio repositório (.claude-plugin/marketplace.json + mod/): versões alinhadas
// com o package.json e estrutura que o Claude Code consegue carregar. O comportamento dos mods em si é
// testado pelo Claude Code (`claude plugin test` em mod/habblaud e mod/habblaud-mensagens); aqui fica o que o
// vitest consegue conferir sem o Claude Code: arquivos, versões, o hook de permissão do plugin rodando de verdade.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hookCommand, hookEntry, STATUS_MESSAGE } from '../../scripts/hooks-install';
import { MAX_TIMEOUT_MS } from '../permissions/registry';
import { posixShell } from './fixtures';

const ROOT = resolve(__dirname, '../..');
const SH = posixShell();
const PLUGINS = ['habblaud', 'habblaud-permissoes', 'habblaud-mensagens', 'navegador', 'documentos'];
/** Plugins que são só um servidor MCP (.mcp.json), sem hooks. */
const MCP_PLUGINS = new Set(['navegador', 'documentos']);

type Rec = Record<string, unknown>;

function json(path: string): Rec {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as Rec;
}

const pkg = json('package.json');
const market = json('.claude-plugin/marketplace.json');
const entries = (market.plugins as Rec[]) ?? [];

/** Os hooks de settings de um hooks.json de plugin: {matcher, hooks:[{type, command, ...}]} por evento. */
function settingsHooks(file: Rec): Array<{ event: string; matcher: unknown; hook: Rec }> {
  const out: Array<{ event: string; matcher: unknown; hook: Rec }> = [];
  for (const [event, groups] of Object.entries((file.hooks as Rec | undefined) ?? {})) {
    for (const g of groups as Rec[]) for (const hook of g.hooks as Rec[]) out.push({ event, matcher: g.matcher, hook });
  }
  return out;
}

/** Especificadores de `import ... from '...'`, `import '...'` e `export ... from '...'` de um arquivo. */
function importsOf(path: string): string[] {
  const src = readFileSync(path, 'utf8');
  const imports = [...src.matchAll(/^\s*import\s+(?:[^'";]*?\s*from\s*)?['"]([^'"]+)['"]/gm)];
  const reexports = [...src.matchAll(/^\s*export\s+[^'";]*?\s*from\s*['"]([^'"]+)['"]/gm)];
  return [...imports, ...reexports].map((m) => m[1]);
}

describe('marketplace e plugins do Claude Code', () => {
  it('versões do marketplace e dos plugin.json = versão do package.json', () => {
    expect(typeof pkg.version).toBe('string');
    expect(market.version).toBe(pkg.version);
    for (const name of PLUGINS) {
      expect(json(`mod/${name}/.claude-plugin/plugin.json`).version, name).toBe(pkg.version);
      const entry = entries.find((e) => e.name === name);
      if (entry?.version !== undefined) expect(entry.version, `entrada ${name}`).toBe(pkg.version);
    }
  });

  it('marketplace "habblaud" com os plugins, cada um numa pasta que existe e com o mesmo nome', () => {
    expect(market.name).toBe('habblaud');
    expect(entries.map((e) => e.name)).toEqual(PLUGINS);
    for (const e of entries) {
      const source = String(e.source);
      expect(source.startsWith('./'), source).toBe(true);
      expect(source).not.toContain('..');
      const dir = join(ROOT, source);
      expect(statSync(dir).isDirectory(), source).toBe(true);
      expect(json(join(source, '.claude-plugin/plugin.json')).name).toBe(e.name);
      const marca = MCP_PLUGINS.has(String(e.name)) ? '.mcp.json' : join('hooks', 'hooks.json');
      expect(existsSync(join(dir, marca)), `${source}/${marca}`).toBe(true);
    }
  });

  it('plugins MCP: o .mcp.json roda um script que existe, e o servidor é Node puro (só node:* e arquivos dele)', () => {
    for (const name of MCP_PLUGINS) {
      const dir = join(ROOT, 'mod', name);
      const servers = Object.values((json(`mod/${name}/.mcp.json`).mcpServers as Rec) ?? {}) as Rec[];
      expect(servers.length, name).toBeGreaterThan(0);
      for (const s of servers) {
        expect(s.command).toBe('node');
        const path = /^\$\{CLAUDE_PLUGIN_ROOT\}(\/.+)$/.exec(String((s.args as string[])[0]))?.[1];
        expect(path, name).toBeDefined();
        expect(existsSync(join(dir, path!)), path).toBe(true);
      }
      // O Claude Code copia só a pasta do plugin para o cache, sem npm install: nada de pacote de fora.
      const lib = join(dir, 'lib');
      const files = [join(dir, 'server.mjs'), ...(existsSync(lib) ? readdirSync(lib).filter((f) => f.endsWith('.mjs')).map((f) => join(lib, f)) : [])];
      for (const f of files) {
        for (const spec of importsOf(f)) expect(spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'), `${f}: ${spec}`).toBe(true);
      }
    }
  });

  it('hooks.json: os módulos dos mods e o script do hook de permissão existem', () => {
    for (const e of entries.filter((x) => !MCP_PLUGINS.has(String(x.name)))) {
      const dir = join(ROOT, String(e.source));
      const hooksJson = join(dir, 'hooks', 'hooks.json');
      const file = JSON.parse(readFileSync(hooksJson, 'utf8')) as Rec;
      for (const m of (file.modules as string[] | undefined) ?? []) {
        expect(m.startsWith('./'), m).toBe(true);
        expect(existsSync(resolve(dirname(hooksJson), m)), m).toBe(true);
      }
      for (const { hook } of settingsHooks(file)) {
        const path = /\$\{CLAUDE_PLUGIN_ROOT\}(\/[^"'\s]+)/.exec(String(hook.command))?.[1];
        expect(path, String(hook.command)).toBeDefined();
        expect(existsSync(join(dir, path!)), path).toBe(true);
      }
    }
    expect(json('mod/habblaud/hooks/hooks.json').modules).toEqual(['./register.ts']);
    expect(json('mod/habblaud-mensagens/hooks/hooks.json').modules).toEqual(['./register.ts']);
  });

  it('os mods só importam arquivos deles mesmos e tipos de "claude-code" (regra do Claude Code)', () => {
    for (const mod of ['habblaud', 'habblaud-mensagens']) {
      for (const spec of importsOf(join(ROOT, `mod/${mod}/hooks/register.ts`))) {
        expect(spec === 'claude-code' || spec.startsWith('./') || spec.startsWith('../'), `${mod}: ${spec}`).toBe(true);
      }
    }
  });
});

describe('plugin habblaud-permissoes', () => {
  const dir = join(ROOT, 'mod/habblaud-permissoes');
  const hooks = settingsHooks(json('mod/habblaud-permissoes/hooks/hooks.json'));

  // No plugin a espera vem do ambiente (HABBLAUD_PERMISSION_TIMEOUT), não do comando: o tempo limite do Claude Code
  // precisa caber a maior espera que o hook aceita, senão ele mata o hook antes (era 330 s e cortava em 5 min; a espera vai até 24 h).
  it('o mesmo hook do instalador: PermissionRequest, matcher "*", mensagem igual e tempo limite que cabe a espera máxima', () => {
    const installed = hookEntry(hookCommand('node', '/x/permission-hook.mjs', { port: 4747, timeoutS: MAX_TIMEOUT_MS / 1000 }), { port: 4747, timeoutS: MAX_TIMEOUT_MS / 1000 });
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toEqual({
      event: 'PermissionRequest',
      matcher: '*',
      hook: { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/permission-hook.mjs"', timeout: installed.timeout, statusMessage: STATUS_MESSAGE },
    });
  });

  it('o script é Node puro (só node:*): o Claude Code copia sozinha a pasta do plugin para o cache', () => {
    const specs = importsOf(join(dir, 'hooks/permission-hook.mjs'));
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(spec.startsWith('node:'), spec).toBe(true);
  });

  it.skipIf(!SH)('o comando do plugin roda de verdade: com o Habblaud fora do ar, sai rápido e sem decisão', () => {
    const input = JSON.stringify({ session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
    const t0 = Date.now();
    // O Claude Code troca ${CLAUDE_PLUGIN_ROOT} no comando e também o exporta; o sh expande do ambiente igual.
    const r = spawnSync(SH!, ['-c', String(hooks[0]?.hook.command)], {
      input,
      encoding: 'utf8',
      env: { PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`, CLAUDE_PLUGIN_ROOT: dir, HABBLAUD_PORT: '1' },
      timeout: 10_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('o caminho antigo (scripts/permission-hook.mjs, das instalações até a 0.2) continua funcionando como atalho', () => {
    const input = JSON.stringify({ session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'permission-hook.mjs')], {
      input,
      encoding: 'utf8',
      // Com o debug ligado o script conta no stderr o que fez: prova que o main do script novo rodou.
      env: { PATH: process.env.PATH ?? '', HABBLAUD_PORT: '1', HABBLAUD_HOOK_DEBUG: '1' },
      timeout: 10_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/habblaud/i);
  });
});

describe('plugin navegador (MCP)', () => {
  const dir = join(ROOT, 'mod/navegador');

  it('.mcp.json abre o server.mjs do plugin com node; o servidor é Node puro e tem a versão do package.json', async () => {
    const mcp = json('mod/navegador/.mcp.json');
    const srv = (mcp.mcpServers as Rec).navegador as Rec;
    expect(srv.command).toBe('node');
    expect(srv.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/server.mjs']);
    for (const spec of importsOf(join(dir, 'server.mjs'))) expect(spec.startsWith('node:'), spec).toBe(true);
    const mod = (await import(join(dir, 'server.mjs'))) as { VERSION: string };
    expect(mod.VERSION).toBe(pkg.version);
  });
});
