// O cliente MCP contra o servidor de verdade do plugin documentos (Node puro, sem rede).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpClient } from './mcp';

const SCRIPT = resolve(__dirname, '../../mod/documentos/server.mjs');
let dir: string;
let client: McpClient | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'local-mcp-'));
  writeFileSync(join(dir, 'contas.csv'), 'item;valor\nluz;100,50\nágua;49,50\n');
});
afterEach(() => {
  client?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('McpClient', () => {
  it('lista as ferramentas e chama uma', async () => {
    client = new McpClient({ name: 'documentos', script: SCRIPT, cwd: dir, env: { CLAUDE_PROJECT_DIR: dir } });
    const tools = await client.tools();
    expect(tools.map((t) => t.name)).toContain('ler_documento');
    const r = await client.call('ler_documento', { caminho: 'contas.csv' });
    expect(r.isError).toBe(false);
    expect(r.content.map((c) => c.text).join('\n')).toContain('100,50');
  }, 20_000);

  it('kill derruba a chamada e a próxima liga de novo', async () => {
    client = new McpClient({ name: 'documentos', script: SCRIPT, cwd: dir, env: { CLAUDE_PROJECT_DIR: dir } });
    await client.tools();
    client.kill();
    const r = await client.call('ler_documento', { caminho: 'contas.csv' });
    expect(r.isError).toBe(false);
  }, 20_000);

  it('servidor que não existe falha com mensagem', async () => {
    client = new McpClient({ name: 'nada', script: join(dir, 'nao-existe.mjs'), cwd: dir, env: {} });
    await expect(client.tools()).rejects.toThrow(/nada/);
  }, 20_000);
});
