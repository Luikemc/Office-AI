import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatDocument, isDocumentName, promptWithDocuments } from './document-prompt';

describe('texto de documento no pedido', () => {
  it('reconhece pdf, planilha e word', () => {
    expect(isDocumentName('a.PDF')).toBe(true);
    expect(isDocumentName('b.xlsx')).toBe(true);
    expect(isDocumentName('c.csv')).toBe(true);
    expect(isDocumentName('d.docx')).toBe(true);
    expect(isDocumentName('e.png')).toBe(false);
  });

  it('formata páginas, células e linhas', () => {
    expect(formatDocument({ sem_texto: true })).toMatch(/digitalizado/);
    expect(formatDocument({ texto_por_pagina: [{ pagina: 'p.1', texto: 'olá' }] })).toBe('p.1\nolá');
    expect(formatDocument({ linhas: [{ valores: ['a', '1'] }, { valores: ['b', '2'] }] })).toBe('a\t1\nb\t2');
  });

  it('cola o csv no pedido e cita o que não é documento', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'habblaud-docprompt-'));
    try {
      const csv = join(dir, 'itens.csv');
      writeFileSync(csv, `nome,qtd\n${'mesa,2\n'.repeat(40)}`);
      const text = await promptWithDocuments('confira', [csv, join(dir, 'foto.png')], 20_000);
      expect(text).toContain('confira');
      expect(text).toContain('mesa');
      expect(text).toContain('foto.png');
      const cut = await promptWithDocuments('confira', [csv], 180);
      expect(cut.length).toBeLessThanOrEqual(180);
      expect(cut).toContain('[texto cortado]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
