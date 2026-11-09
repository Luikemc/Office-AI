import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileToolError, listFiles, readTextFile, resolveInside, writeTextFile, type Approve } from './files';

let root: string;
let outside: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'local-files-'));
  outside = mkdtempSync(join(tmpdir(), 'local-outside-'));
  writeFileSync(join(root, 'a.txt'), 'um\ndois\ntrês\n');
  mkdirSync(join(root, 'sub'));
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(outside, 'segredo.txt'), 'não leia');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const allow: Approve = async () => ({ ok: true });

describe('ferramentas de arquivo', () => {
  it('lista a pasta, pastas primeiro, sem node_modules', () => {
    const out = listFiles(root, {});
    expect(out).toContain('sub/');
    expect(out).toContain('a.txt');
    expect(out).not.toContain('node_modules');
    expect(out.indexOf('sub/')).toBeLessThan(out.indexOf('a.txt'));
  });

  it('lê com número de linha e a partir de uma linha', () => {
    expect(readTextFile(root, { caminho: 'a.txt' })).toContain('2\tdois');
    expect(readTextFile(root, { caminho: 'a.txt', inicio: 3 })).toMatch(/^3\ttrês/);
  });

  it('recusa sair da pasta: .., absoluto de fora e link simbólico', () => {
    expect(() => readTextFile(root, { caminho: '../x' })).toThrow(FileToolError);
    expect(() => readTextFile(root, { caminho: join(outside, 'segredo.txt') })).toThrow(FileToolError);
    symlinkSync(outside, join(root, 'atalho'));
    expect(() => readTextFile(root, { caminho: 'atalho/segredo.txt' })).toThrow(/sai da pasta/);
    expect(() => resolveInside(root, 'atalho/novo.txt', true)).toThrow(/sai da pasta/);
  });

  it('recusa binário', () => {
    writeFileSync(join(root, 'b.bin'), Buffer.from([1, 0, 2]));
    expect(() => readTextFile(root, { caminho: 'b.bin' })).toThrow(/binário/);
  });

  it('escreve só depois da aprovação, criando as pastas', async () => {
    const titles: string[] = [];
    const r = await writeTextFile(root, { caminho: 'novo/c.txt', conteudo: 'oi' }, async (req) => {
      titles.push(req.title);
      expect(req.input).toContain('oi');
      return { ok: true };
    });
    expect(r.ok).toBe(true);
    expect(titles).toEqual(['Write(novo/c.txt)']);
    expect(readFileSync(join(root, 'novo', 'c.txt'), 'utf8')).toBe('oi');
  });

  it('recusa = não grava e devolve a mensagem', async () => {
    const r = await writeTextFile(root, { caminho: 'd.txt', conteudo: 'oi' }, async () => ({ ok: false, message: 'não' }));
    expect(r).toEqual({ ok: false, text: 'não' });
    expect(() => readFileSync(join(root, 'd.txt'))).toThrow();
  });

  it('escrever fora da pasta nem pergunta', async () => {
    let asked = false;
    await expect(
      writeTextFile(root, { caminho: '../fora.txt', conteudo: 'x' }, async () => {
        asked = true;
        return { ok: true };
      }),
    ).rejects.toThrow(FileToolError);
    expect(asked).toBe(false);
    await expect(writeTextFile(root, { caminho: 'sub', conteudo: 'x' }, allow)).rejects.toThrow(/não é um arquivo/);
  });
});
