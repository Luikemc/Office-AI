// Plugin mod/documentos (servidor MCP local de documentos): leitura com origem, contas conferidas em código,
// boleto (DVs, valor, vencimento), caminhos presos à pasta do projeto, correção sempre em arquivo novo e o
// protocolo stdio rodando de verdade. Os arquivos de teste são gerados aqui (xlsx/docx = zip + XML; PDF à mão).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildZip,
  crc32,
  datasDoFator,
  deslocar,
  executar,
  FERRAMENTAS,
  formatarLinhaBancaria,
  lerPdf,
  linhaDasBarrasBancarias,
  mod10,
  mod11Bancario,
  openZip,
  parseFormula,
  avaliar,
  parseNumero,
  cpfValido,
  cnpjValido,
  vencimentoDoFator,
  verificarCodigo,
} from '../../mod/documentos/lib/index.mjs';
import { describeTool } from '../../shared/activity';

const ROOT = resolve(__dirname, '../..');
const PLUGIN = join(ROOT, 'mod/documentos');
const TEM_PDFTOTEXT = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' }).error === undefined;
const T = 20_000; // máquina lenta

// ------------------------------------------------------------------------------------------------
// Geradores de arquivos
// ------------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Celula {
  v?: number | string;
  f?: string;
  shared?: { si: number; ref?: string };
}

function sheetXml(cells: Record<string, Celula>, strings: string[]): string {
  const porLinha = new Map<number, string[]>();
  for (const [addr, c] of Object.entries(cells)) {
    const row = Number(/\d+/.exec(addr)![0]);
    let xml: string;
    const f = c.shared ? `<f t="shared" si="${c.shared.si}"${c.shared.ref ? ` ref="${c.shared.ref}"` : ''}${c.f ? `>${esc(c.f)}</f>` : '/>'}` : c.f ? `<f>${esc(c.f)}</f>` : '';
    if (typeof c.v === 'string') {
      let i = strings.indexOf(c.v);
      if (i < 0) i = strings.push(c.v) - 1;
      xml = `<c r="${addr}" t="s">${f}<v>${i}</v></c>`;
    } else xml = `<c r="${addr}">${f}${c.v === undefined ? '' : `<v>${c.v}</v>`}</c>`;
    if (!porLinha.has(row)) porLinha.set(row, []);
    porLinha.get(row)!.push(xml);
  }
  const rows = [...porLinha.entries()].sort((a, b) => a[0] - b[0]).map(([r, cs]) => `<row r="${r}">${cs.join('')}</row>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:E6"/><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

function xlsx(sheets: Array<[string, Record<string, Celula>]>): Buffer {
  const strings: string[] = [];
  const files: Record<string, string> = {};
  sheets.forEach(([, cells], i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(cells, strings)));
  files['[Content_Types].xml'] =
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>`;
  files['_rels/.rels'] = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  files['xl/workbook.xml'] =
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
    sheets.map(([nome], i) => `<sheet name="${esc(nome)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    `</sheets><calcPr calcId="191029"/></workbook>`;
  files['xl/_rels/workbook.xml.rels'] =
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId90" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId91" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>`;
  files['xl/sharedStrings.xml'] = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`;
  files['xl/calcChain.xml'] = `<?xml version="1.0" encoding="UTF-8"?><calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="B6" i="1"/></calcChain>`;
  return buildZip(files);
}

/** Planilha de contas com a soma errada: B6 =SUM(B2:B5) guardou 1300, mas a soma dá 1350,5. */
const PLANILHA = (): Buffer =>
  xlsx([
    [
      'Plan1',
      {
        A1: { v: 'Item' },
        B1: { v: 'Valor' },
        C1: { v: 'Imposto' },
        A2: { v: 'Aluguel' },
        B2: { v: 1000 },
        C2: { v: 100, f: 'B2*0.1', shared: { si: 0, ref: 'C2:C5' } },
        A3: { v: 'Luz' },
        B3: { v: 150.5 },
        C3: { v: 15.05, shared: { si: 0 } },
        A4: { v: 'Água' },
        B4: { v: 80 },
        C4: { v: 9, shared: { si: 0 } }, // errado: B4*0.1 = 8
        A5: { v: 'Internet' },
        B5: { v: 120 },
        C5: { v: 12, shared: { si: 0 } },
        A6: { v: 'Total' },
        B6: { v: 1300, f: 'SUM(B2:B5)' },
        E2: { v: 1000, f: 'ROUND(B2,0)' },
      },
    ],
    [
      'Resumo',
      {
        A1: { v: 'Categoria' },
        B1: { v: 'Jan' },
        C1: { v: 'Fev' },
        D1: { v: 'Total' },
        A2: { v: 'Casa' },
        B2: { v: 500 },
        C2: { v: 600 },
        D2: { v: 1100 },
        A3: { v: 'Carro' },
        B3: { v: 200 },
        C3: { v: 250 },
        D3: { v: 460 }, // errado: 450
        A4: { v: 'Total' },
        B4: { v: 700 },
        C4: { v: 800 }, // errado: 850
        A6: { v: 'Contas do mês' },
        B6: { v: 1300, f: 'Plan1!B6' },
      },
    ],
  ]);

const CSV = 'Descrição;Valor\nMercado;"1.200,00"\nFarmácia;85,40\nPadaria;30,10\nTotal;1.305,50\n'; // certo: 1.315,50

function docx(): Buffer {
  const p = (runs: string[]) => `<w:p>${runs.map((r) => `<w:r><w:t xml:space="preserve">${esc(r)}</w:t></w:r>`).join('')}</w:p>`;
  const tc = (t: string) => `<w:tc><w:p><w:r><w:t>${esc(t)}</w:t></w:r></w:p></w:tc>`;
  const body =
    p(['Contrato de prestação de serviços']) +
    p([]) +
    p(['Valor total: R$ ', '1.300', ',00', ' a pagar até 10/03/2026.']) +
    `<w:tbl><w:tr>${tc('Parcela')}${tc('Valor')}</w:tr><w:tr>${tc('1')}${tc('R$ 650,00')}</w:tr></w:tbl>` +
    p(['Contratante: CNPJ 11.222.333/0001-81']);
  return buildZip({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  });
}

/** PDF mínimo com texto (Helvetica, WinAnsi), uma página por item de `paginas` (linhas de texto). */
function pdf(paginas: string[][]): Buffer {
  const objs: string[] = [];
  const add = (s: string) => objs.push(s) - 1 + 1; // número do objeto
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('PAGES');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const linhas of paginas) {
    const ops = ['BT', '/F1 11 Tf', '14 TL', '50 780 Td'];
    for (const l of linhas) ops.push(`(${l.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')}) Tj T*`);
    ops.push('ET');
    const stream = Buffer.from(ops.join('\n'), 'latin1');
    const c = add(`<< /Length ${stream.length} >>\nstream\n${stream.toString('latin1')}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${c} 0 R >>`));
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// Boleto fictício (banco 001), vencimento 10/03/2026 (fator 1381, segundo ciclo), R$ 1.205,00 na linha.
const LIVRE = '0000001234567890123456717';
const FATOR = 1381;
const BARRAS_SEM_DV = `0019${FATOR}0000120500${LIVRE}`;
const BARRAS = BARRAS_SEM_DV.slice(0, 4) + String(mod11Bancario(BARRAS_SEM_DV)) + BARRAS_SEM_DV.slice(4);
const LINHA = formatarLinhaBancaria(linhaDasBarrasBancarias(BARRAS));

const BOLETO = (linha = LINHA, valorImpresso = 'R$ 1.250,00') =>
  pdf([
    ['Banco do Brasil S.A.   001-9   ' + linha, 'Local de pagamento: pagável em qualquer banco', 'Vencimento', '10/03/2026', 'Beneficiário: Escola Exemplo Ltda  CNPJ 11.222.333/0001-81', '(=) Valor do documento', valorImpresso, 'Pagador: Fulano de Tal  CPF 123.456.789-09'],
    ['Recibo do pagador', 'Valor: ' + valorImpresso, linha],
  ]);

// ------------------------------------------------------------------------------------------------

let dir: string;
let fora: string;
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'documentos-'));
  fora = mkdtempSync(join(tmpdir(), 'documentos-fora-'));
  writeFileSync(join(dir, 'contas.xlsx'), PLANILHA());
  writeFileSync(join(dir, 'gastos.csv'), CSV);
  writeFileSync(join(dir, 'contrato.docx'), docx());
  writeFileSync(join(dir, 'boleto.pdf'), BOLETO());
  writeFileSync(join(dir, 'boleto-ok.pdf'), BOLETO(LINHA, 'R$ 1.205,00'));
  writeFileSync(join(dir, 'digitalizado.pdf'), pdf([[]]));
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(fora, 'segredo.csv'), 'a;b\n1;2\n');
  symlinkSync(join(fora, 'segredo.csv'), join(dir, 'link.csv'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(fora, { recursive: true, force: true });
});

describe('documentos: peças', () => {
  it('crc32 e zip: ida e volta', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    const z = openZip(buildZip({ 'a.txt': 'olá', 'b/c.xml': '<x/>' }));
    expect(z.text('a.txt')).toBe('olá');
    expect(z.text('b/c.xml')).toBe('<x/>');
    expect(z.has('nada')).toBe(false);
  });

  it('fórmulas: SUM e aritmética sobre células e intervalos; deslocamento de fórmula compartilhada', () => {
    const vals: Record<string, number | string> = { '1,1': 2, '2,1': 3, '3,1': 'x', '1,2': 10 };
    const get = (_s: string, r: number, c: number) => vals[`${r},${c}`] ?? null;
    expect(avaliar(parseFormula('SUM(A1:A3)+B1*2'), 'P', get)).toBe(25);
    expect(avaliar(parseFormula('=(A1+A2)/-5'), 'P', get)).toBe(-1);
    expect(() => avaliar(parseFormula('A3+1'), 'P', get)).toThrow(/texto/);
    expect(() => parseFormula('VLOOKUP(A1,B1:C9,2)')).toThrow(/VLOOKUP/);
    expect(deslocar('B2*0.1+$A$1+Plan2!C3', 2, 1)).toBe('C4*0.1+$A$1+Plan2!D5');
  });

  it('números, CPF e CNPJ', () => {
    expect(parseNumero('R$ 1.234,56')).toBe(1234.56);
    expect(parseNumero('-85,4')).toBe(-85.4);
    expect(parseNumero('1234.5')).toBe(1234.5);
    expect(parseNumero('abc')).toBeUndefined();
    expect(cpfValido('123.456.789-09')).toBe(true);
    expect(cpfValido('123.456.789-00')).toBe(false);
    expect(cnpjValido('11.222.333/0001-81')).toBe(true);
    expect(cnpjValido('11.222.333/0001-80')).toBe(false);
  });
});

describe('documentos: boleto (FEBRABAN)', () => {
  // Implementação independente (pesos em lista), para não conferir o código com ele mesmo.
  const m10 = (s: string) => {
    const soma = [...s].reverse().reduce((acc, d, i) => {
      const p = Number(d) * (i % 2 === 0 ? 2 : 1);
      return acc + (p > 9 ? p - 9 : p);
    }, 0);
    return (10 - (soma % 10)) % 10;
  };
  const m11 = (s: string) => {
    const pesos = [2, 3, 4, 5, 6, 7, 8, 9];
    const soma = [...s].reverse().reduce((acc, d, i) => acc + Number(d) * pesos[i % 8], 0);
    const dv = 11 - (soma % 11);
    return dv > 9 || dv === 0 ? 1 : dv;
  };

  it('DVs da linha montada batem com uma conta independente', () => {
    const l = LINHA.replace(/\D/g, '');
    expect(l).toHaveLength(47);
    expect(LINHA).toBe('00190.00009 01234.567897 01234.567178 8 13810000120500');
    expect(Number(l[9])).toBe(m10(l.slice(0, 9)));
    expect(Number(l[20])).toBe(m10(l.slice(10, 20)));
    expect(Number(l[31])).toBe(m10(l.slice(21, 31)));
    expect(Number(BARRAS[4])).toBe(m11(BARRAS.slice(0, 4) + BARRAS.slice(5)));
    expect(mod10('001900000')).toBe(9);
  });

  it('valor e vencimento da linha; fator nos dois ciclos (o de 2025 recomeça em 1000)', () => {
    const v = verificarCodigo(LINHA);
    expect(v).toMatchObject({ tipo: 'bancario', banco: '001', digitos_ok: true, valor_na_linha: 1205, fator_vencimento: FATOR, codigo_de_barras: BARRAS });
    expect(datasDoFator(1000)).toEqual(['2000-07-03', '2025-02-22']);
    expect(datasDoFator(9999)[0]).toBe('2025-02-21');
    expect(datasDoFator(FATOR)).toEqual(['2001-07-19', '2026-03-10']);
    expect(vencimentoDoFator(FATOR, '2026-03-01')).toBe('2026-03-10');
    expect(vencimentoDoFator(FATOR, '2001-08-01')).toBe('2001-07-19');
    // o código de barras (44) sozinho também é conferido
    expect(verificarCodigo(BARRAS)).toMatchObject({ digitos_ok: true, valor_na_linha: 1205 });
  });

  it('dígito errado: aponta o campo e o DV certo', () => {
    const errada = LINHA.replace('01234.567897', '01234.567891');
    const v = verificarCodigo(errada);
    expect(v.digitos_ok).toBe(false);
    expect(v.erros_dv).toContainEqual(expect.objectContaining({ campo: 'campo 2', dv_encontrado: '1', dv_esperado: '7' }));
  });

  it('arrecadação (48 dígitos, módulo 10)', () => {
    const corpo = '8260000001' + '0' + '5' + '00010000000000000000000000000000'.slice(0, 32); // 44 com o DV geral na 4ª posição
    const semDv = corpo.slice(0, 3) + corpo.slice(4);
    const barras = corpo.slice(0, 3) + String(mod10(semDv)) + corpo.slice(4);
    const linha = [0, 1, 2, 3].map((i) => barras.slice(i * 11, i * 11 + 11) + String(mod10(barras.slice(i * 11, i * 11 + 11)))).join(' ');
    const v = verificarCodigo(linha);
    expect(v).toMatchObject({ tipo: 'arrecadacao', digitos_ok: true });
    expect(v.valor_na_linha).toBe(Number(barras.slice(4, 15)) / 100);
  });
});

describe('documentos: ler_documento', () => {
  it('xlsx: células com endereço, valor guardado e fórmula (também a compartilhada)', async () => {
    const r = await executar('ler_documento', { caminho: 'contas.xlsx' }, dir);
    expect(r.planilhas_no_arquivo).toEqual(['Plan1', 'Resumo']);
    const cel = (r.planilhas[0].celulas as Array<{ celula: string }>).reduce<Record<string, unknown>>((m, c) => ({ ...m, [c.celula]: c }), {});
    expect(cel['Plan1!B6']).toEqual({ celula: 'Plan1!B6', valor: 1300, formula: '=SUM(B2:B5)' });
    expect(cel['Plan1!A4']).toEqual({ celula: 'Plan1!A4', valor: 'Água' });
    expect(cel['Plan1!C4']).toEqual({ celula: 'Plan1!C4', valor: 9, formula: '=B4*0.1' });
    expect(r.planilhas[1].celulas).toContainEqual({ celula: 'Resumo!B6', valor: 1300, formula: '=Plan1!B6' });
  });

  it('csv: linhas, colunas e valores', async () => {
    const r = await executar('ler_documento', { caminho: 'gastos.csv' }, dir);
    expect(r).toMatchObject({ separador: ';', total_linhas: 5, total_colunas: 2 });
    expect(r.linhas[1]).toEqual({ linha: 2, valores: ['Mercado', '1.200,00'] });
  });

  it('docx: parágrafos §n (contando os vazios), tabelas T1:L2:C2 e valores com o local', async () => {
    const r = await executar('ler_documento', { caminho: 'contrato.docx' }, dir);
    expect(r.total_paragrafos).toBe(4);
    expect(r.paragrafos).toContainEqual({ local: '§3', texto: 'Valor total: R$ 1.300,00 a pagar até 10/03/2026.' });
    expect(r.tabelas).toEqual([{ tabela: 'T1', linhas: [['Parcela', 'Valor'], ['1', 'R$ 650,00']] }]);
    expect(r.achados.valores).toContainEqual(expect.objectContaining({ valor: 1300, local: '§3' }));
    expect(r.achados.valores).toContainEqual(expect.objectContaining({ valor: 650, local: 'T1:L2:C2' }));
    expect(r.achados.documentos).toContainEqual(expect.objectContaining({ tipo: 'CNPJ', valido: true, local: '§4' }));
  });

  it.skipIf(!TEM_PDFTOTEXT)(
    'pdf com texto (pdftotext): texto por página e valores com página e trecho',
    async () => {
      const r = await executar('ler_documento', { caminho: 'boleto.pdf' }, dir);
      expect(r).toMatchObject({ paginas: 2, extrator: 'pdftotext' });
      expect(r.texto_por_pagina[1].pagina).toBe('p.2');
      expect(r.achados.valores).toContainEqual(expect.objectContaining({ valor: 1250, pagina: 'p.1', trecho: 'R$ 1.250,00' }));
      expect(r.achados.valores).toContainEqual(expect.objectContaining({ valor: 1250, pagina: 'p.2' }));
      expect(r.achados.linhas_digitaveis[0]).toMatchObject({ tipo: 'linha_digitavel', pagina: 'p.1' });
      expect(r.achados.documentos).toContainEqual(expect.objectContaining({ tipo: 'CPF', texto: '123.456.789-09', valido: true }));
      expect(r.achados.datas).toContainEqual(expect.objectContaining({ iso: '2026-03-10', pagina: 'p.1' }));
    },
    T,
  );

  it('pdf sem pdftotext: o extrator embutido lê as páginas', async () => {
    const r = await lerPdf(join(dir, 'boleto.pdf'), readFileSync(join(dir, 'boleto.pdf')), { pdftotext: '' });
    expect(r.extrator).toBe('embutido');
    expect(r.paginas).toHaveLength(2);
    expect(r.paginas[0]).toContain('(=) Valor do documento');
    expect(r.paginas[0]).toContain(LINHA);
    expect(r.paginas[1]).toContain('Recibo do pagador');
    const faltando = await lerPdf(join(dir, 'boleto.pdf'), readFileSync(join(dir, 'boleto.pdf')), { pdftotext: '/nao/existe/pdftotext' });
    expect(faltando.extrator).toBe('embutido');
    expect(faltando.aviso).toMatch(/não encontrado/);
  });

  it('pdf sem texto (digitalizado): diz claramente que não dá para ler', async () => {
    const r = await executar('ler_documento', { caminho: 'digitalizado.pdf' }, dir);
    expect(r.sem_texto).toBe(true);
    expect(r.aviso).toMatch(/não tem texto extraível.*não faz OCR/);
  }, T);

  it('formato não suportado', async () => {
    writeFileSync(join(dir, 'velho.xls'), 'x');
    await expect(executar('ler_documento', { caminho: 'velho.xls' }, dir)).rejects.toThrow(/salve como \.xlsx/);
  });
});

describe('documentos: conferir_planilha', () => {
  it('xlsx: acha a soma errada (com o valor certo), a fórmula compartilhada errada e os totais digitados errados', async () => {
    const r = await executar('conferir_planilha', { caminho: 'contas.xlsx' }, dir);
    const por = Object.fromEntries((r.divergencias as Array<{ celula: string; trecho: string }>).map((d) => [d.celula, d]));
    expect(por['Plan1!B6']).toMatchObject({ tipo: 'formula', valor_encontrado: 1300, valor_esperado: 1350.5, diferenca: -50.5, formula: '=SUM(B2:B5)' });
    expect(por['Plan1!B6'].trecho).toContain('linha 6 "Total"');
    expect(por['Plan1!C4']).toMatchObject({ tipo: 'formula', valor_encontrado: 9, valor_esperado: 8, diferenca: 1 });
    expect(por['Resumo!C4']).toMatchObject({ tipo: 'total', valor_encontrado: 800, valor_esperado: 850, diferenca: -50, itens: 'C2:C3' });
    expect(por['Resumo!D3']).toMatchObject({ tipo: 'total_da_linha', valor_encontrado: 460, valor_esperado: 450, diferenca: 10 });
    // o que está certo não aparece
    for (const ok of ['Plan1!C2', 'Plan1!C3', 'Resumo!B4', 'Resumo!D2', 'Resumo!B6']) expect(por[ok], ok).toBeUndefined();
    expect(Object.keys(por).sort()).toEqual(['Plan1!B6', 'Plan1!C4', 'Resumo!C4', 'Resumo!D3']);
    expect(r.nao_conferidas).toEqual([{ celula: 'Plan1!E2', formula: '=ROUND(B2,0)', motivo: 'não conferida: função ROUND' }]);
    expect(r.conclusao).toContain('Plan1!B6 está 1.300,00, o certo seria 1.350,50');
  });

  it('só uma planilha', async () => {
    const r = await executar('conferir_planilha', { caminho: 'contas.xlsx', planilha: 'resumo' }, dir);
    expect(r.planilhas).toEqual(['Resumo']);
    expect(r.divergencias.map((d: { celula: string }) => d.celula).sort()).toEqual(['Resumo!C4', 'Resumo!D3']);
  });

  it('csv: total digitado errado', async () => {
    const r = await executar('conferir_planilha', { caminho: 'gastos.csv' }, dir);
    expect(r.divergencias).toHaveLength(1);
    expect(r.divergencias[0]).toMatchObject({ celula: 'gastos.csv!B5', valor_encontrado: 1305.5, valor_esperado: 1315.5, diferenca: -10, itens: 'B2:B4' });
  });
});

describe('documentos: conferir_boleto', () => {
  it.skipIf(!TEM_PDFTOTEXT)(
    'linha válida, valor impresso diferente: aponta o certo (o da linha) e o errado (o impresso)',
    async () => {
      const r = await executar('conferir_boleto', { caminho: 'boleto.pdf' }, dir);
      expect(r.boletos[0]).toMatchObject({ digitos_ok: true, valor_na_linha: 1205, vencimento_na_linha: '2026-03-10', pagina: 'p.1' });
      expect(r.valor_impresso).toMatchObject({ valor: 1250, pagina: 'p.1', texto: 'R$ 1.250,00' });
      expect(r.boletos[0].comparacao.valor).toMatch(/^NÃO CONFERE: a linha diz 1\.205,00, o impresso diz 1\.250,00/);
      expect(r.boletos[0].comparacao.vencimento).toBe('confere');
      expect(r.conclusao).toMatch(/o banco cobra o da linha \(R\$ 1\.205,00\); o impresso \(R\$ 1\.250,00\) é o que não bate/);
    },
    T,
  );

  it.skipIf(!TEM_PDFTOTEXT)(
    'boleto certo: tudo confere',
    async () => {
      const r = await executar('conferir_boleto', { caminho: 'boleto-ok.pdf' }, dir);
      expect(r.boletos[0].comparacao).toEqual({ valor: 'confere', vencimento: 'confere' });
    },
    T,
  );

  it('linha com dígito errado (extrator embutido também serve)', async () => {
    writeFileSync(join(dir, 'boleto-dv.pdf'), BOLETO(LINHA.replace('01234.567897', '01234.567891'), 'R$ 1.205,00'));
    const antes = process.env.DOCUMENTOS_PDFTOTEXT;
    process.env.DOCUMENTOS_PDFTOTEXT = '';
    try {
      const r = await executar('conferir_boleto', { caminho: 'boleto-dv.pdf' }, dir);
      expect(r.extrator).toBe('embutido');
      expect(r.boletos[0].digitos_ok).toBe(false);
      expect(r.conclusao).toMatch(/campo 2 tem 1, o certo seria 7/);
    } finally {
      if (antes === undefined) delete process.env.DOCUMENTOS_PDFTOTEXT;
      else process.env.DOCUMENTOS_PDFTOTEXT = antes;
    }
  });
});

describe('documentos: caminhos', () => {
  it('recusa "..", absoluto fora da pasta e link para fora; aceita absoluto dentro', async () => {
    await expect(executar('ler_documento', { caminho: '../x.csv' }, dir)).rejects.toThrow(/dentro da pasta do projeto/);
    await expect(executar('ler_documento', { caminho: 'sub/../../x.csv' }, dir)).rejects.toThrow(/dentro da pasta do projeto/);
    await expect(executar('ler_documento', { caminho: join(fora, 'segredo.csv') }, dir)).rejects.toThrow(/dentro da pasta do projeto/);
    await expect(executar('ler_documento', { caminho: 'link.csv' }, dir)).rejects.toThrow(/link que aponta para fora/);
    await expect(executar('salvar_correcao', { caminho: 'link.csv', correcoes: [{ local: 'A1', novo_valor: 'x' }] }, dir)).rejects.toThrow(/link/);
    const r = await executar('ler_documento', { caminho: join(dir, 'gastos.csv') }, dir);
    expect(r.arquivo).toBe('gastos.csv');
  });
});

describe('documentos: salvar_correcao (nunca sobrescreve)', () => {
  it('xlsx: grava -corrigido, refaz as contas dependentes, tira o calcChain e pede recálculo; o original fica igual', async () => {
    const antes = sha(join(dir, 'contas.xlsx'));
    const r = await executar('salvar_correcao', { caminho: 'contas.xlsx', correcoes: [{ local: 'Plan1!C4', novo_valor: '=B4*0.1' }, { local: 'Resumo!C4', novo_valor: 850 }, { local: 'Resumo!D3', novo_valor: '450' }, { local: 'Plan1!F9', novo_valor: 'nota' }] }, dir);
    expect(r).toMatchObject({ gravado: true, arquivo_corrigido: 'contas-corrigido.xlsx', original_intacto: true, erros: [] });
    expect(sha(join(dir, 'contas.xlsx'))).toBe(antes);
    // o SUM errado: troca pela fórmula de novo; o valor guardado é refeito, e Resumo!B6 (=Plan1!B6) acompanha
    const r2 = await executar('salvar_correcao', { caminho: 'contas-corrigido.xlsx', correcoes: [{ local: 'Plan1!B6', novo_valor: '=SUM(B2:B5)' }] }, dir);
    expect(r2.arquivo_corrigido).toBe('contas-corrigido-corrigido.xlsx');
    expect(r2.recalculadas).toContainEqual({ celula: 'Plan1!B6', formula: '=SUM(B2:B5)', valor: 1350.5 });
    expect(r2.recalculadas).toContainEqual({ celula: 'Resumo!B6', formula: '=Plan1!B6', valor: 1350.5 });
    const c = await executar('conferir_planilha', { caminho: 'contas-corrigido-corrigido.xlsx' }, dir);
    expect(c.divergencias).toEqual([]);
    const lido = await executar('ler_documento', { caminho: 'contas-corrigido-corrigido.xlsx', planilha: 'Plan1' }, dir);
    expect(lido.planilhas[0].celulas).toContainEqual({ celula: 'Plan1!F9', valor: 'nota' });
    expect(lido.planilhas[0].celulas).toContainEqual({ celula: 'Plan1!C5', valor: 12, formula: '=B5*0.1' });
    const zip = openZip(readFileSync(join(dir, 'contas-corrigido-corrigido.xlsx')));
    expect(zip.has('xl/calcChain.xml')).toBe(false);
    expect(zip.text('[Content_Types].xml')).not.toContain('calcChain');
    expect(zip.text('xl/_rels/workbook.xml.rels')).not.toContain('calcChain');
    expect(zip.text('xl/workbook.xml')).toContain('<calcPr fullCalcOnLoad="1" calcId="191029"/>');
    expect(zip.text('xl/sharedStrings.xml')).toBe(openZip(readFileSync(join(dir, 'contas.xlsx'))).text('xl/sharedStrings.xml'));
    // de novo no mesmo original: -corrigido-2
    const r3 = await executar('salvar_correcao', { caminho: 'contas.xlsx', correcoes: [{ local: 'B6', novo_valor: 1350.5 }] }, dir);
    expect(r3.arquivo_corrigido).toBe('contas-corrigido-2.xlsx');
    expect(sha(join(dir, 'contas-corrigido.xlsx'))).not.toBe(sha(join(dir, 'contas-corrigido-2.xlsx')));
    expect(sha(join(dir, 'contas.xlsx'))).toBe(antes);
  }, T);

  it('xlsx: valor no lugar da fórmula mestre compartilhada mantém as outras fórmulas', async () => {
    const r = await executar('salvar_correcao', { caminho: 'contas.xlsx', correcoes: [{ local: 'Plan1!C2', novo_valor: 100 }] }, dir);
    const lido = await executar('ler_documento', { caminho: r.arquivo_corrigido, planilha: 'Plan1' }, dir);
    expect(lido.planilhas[0].celulas).toContainEqual({ celula: 'Plan1!C2', valor: 100 });
    expect(lido.planilhas[0].celulas).toContainEqual({ celula: 'Plan1!C3', valor: 15.05, formula: '=B3*0.1' });
    expect(lido.planilhas[0].celulas).toContainEqual({ celula: 'Plan1!C5', valor: 12, formula: '=B5*0.1' });
  }, T);

  it('csv: troca a célula no formato do arquivo; o resto fica byte a byte', async () => {
    const r = await executar('salvar_correcao', { caminho: 'gastos.csv', correcoes: [{ local: 'B5', novo_valor: 1315.5 }] }, dir);
    expect(r.arquivo_corrigido).toBe('gastos-corrigido.csv');
    expect(readFileSync(join(dir, 'gastos-corrigido.csv'), 'utf8')).toBe(CSV.replace('1.305,50', '1.315,50'));
    expect(readFileSync(join(dir, 'gastos.csv'), 'utf8')).toBe(CSV);
  });

  it('docx: troca um trecho que atravessa vários pedaços de texto e o texto de uma célula de tabela', async () => {
    const antes = sha(join(dir, 'contrato.docx'));
    const r = await executar('salvar_correcao', { caminho: 'contrato.docx', correcoes: [{ local: '§3', texto_original: '1.300,00', novo_valor: '1.350,50' }, { local: 'T1:L2:C2', novo_valor: 'R$ 675,25' }, { local: '§3', novo_valor: 'x' }, { local: '§99', novo_valor: 'x' }] }, dir);
    expect(r.aplicadas).toHaveLength(2);
    expect(r.erros.map((e: { local: string }) => e.local)).toEqual(['§3', '§99']);
    const lido = await executar('ler_documento', { caminho: r.arquivo_corrigido }, dir);
    expect(lido.paragrafos).toContainEqual({ local: '§3', texto: 'Valor total: R$ 1.350,50 a pagar até 10/03/2026.' });
    expect(lido.tabelas[0].linhas[1]).toEqual(['1', 'R$ 675,25']);
    expect(sha(join(dir, 'contrato.docx'))).toBe(antes);
  });

  it('pdf: não edita, explica e sugere um relatório; nada é gravado', async () => {
    const r = await executar('salvar_correcao', { caminho: 'boleto.pdf', correcoes: [{ local: 'p.1', novo_valor: 'x' }] }, dir);
    expect(r.suportado).toBe(false);
    expect(r.mensagem).toMatch(/não edita PDF.*boleto-correcoes\.md/);
    expect(existsSync(join(dir, 'boleto-corrigido.pdf'))).toBe(false);
  });

  it('nada aplicável: não grava arquivo', async () => {
    const r = await executar('salvar_correcao', { caminho: 'gastos.csv', correcoes: [{ local: 'Z99', novo_valor: 1 }] }, dir);
    expect(r.gravado).toBe(false);
    expect(existsSync(join(dir, 'gastos-corrigido-2.csv'))).toBe(false);
  });
});

describe('documentos: no escritório', () => {
  it('as chamadas do MCP viram atividade "document" com texto em português (como plugin e como servidor avulso)', () => {
    const d = (tool: string, caminho: string, srv = 'plugin_documentos_documentos') => describeTool(`mcp__${srv}__${tool}`, { caminho });
    expect(d('ler_documento', 'financeiro/contas.xlsx')).toMatchObject({ kind: 'document', text: 'Lendo a planilha contas.xlsx', detail: 'financeiro/contas.xlsx' });
    expect(d('ler_documento', 'boleto.pdf').text).toBe('Lendo o PDF boleto.pdf');
    expect(d('ler_documento', 'contrato.docx').text).toBe('Lendo o documento contrato.docx');
    expect(d('conferir_planilha', 'gastos.csv', 'documentos')).toMatchObject({ kind: 'document', text: 'Conferindo a planilha gastos.csv' });
    expect(d('conferir_boleto', 'boleto.pdf').text).toBe('Conferindo o boleto boleto.pdf');
    expect(d('salvar_correcao', 'contas.xlsx').text).toBe('Salvando a correção de contas.xlsx');
  });
});

describe('documentos: servidor MCP (stdio)', () => {
  it('as quatro ferramentas, com nomes e descrições em português', () => {
    expect(FERRAMENTAS.map((f) => f.name)).toEqual(['ler_documento', 'conferir_planilha', 'conferir_boleto', 'salvar_correcao']);
    for (const f of FERRAMENTAS) expect(f.inputSchema.required).toContain('caminho');
  });

  it('o .mcp.json do plugin sobe o server.mjs com node', () => {
    const cfg = JSON.parse(readFileSync(join(PLUGIN, '.mcp.json'), 'utf8'));
    expect(cfg.mcpServers.documentos).toEqual({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'] });
  });

  it(
    'initialize, tools/list e tools/call de verdade, uma mensagem JSON por linha, com cwd = pasta do projeto',
    async () => {
      const child = spawn(process.execPath, [join(PLUGIN, 'server.mjs')], { cwd: dir, env: { PATH: process.env.PATH ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
      const respostas: Array<Record<string, unknown>> = [];
      let buf = '';
      const esperar = (n: number) =>
        new Promise<void>((ok, falha) => {
          const t = setTimeout(() => falha(new Error(`sem resposta: ${buf}`)), 15_000);
          const ver = () => {
            if (respostas.length >= n) {
              clearTimeout(t);
              ok();
            }
          };
          child.stdout.on('data', (d: Buffer) => {
            buf += d.toString('utf8');
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
              respostas.push(JSON.parse(buf.slice(0, i)));
              buf = buf.slice(i + 1);
            }
            ver();
          });
          ver();
        });
      const pronto = esperar(5);
      const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + '\n');
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'teste', version: '0' } } });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'conferir_planilha', arguments: { caminho: 'gastos.csv' } } });
      send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ler_documento', arguments: { caminho: '../fora.csv' } } });
      send({ jsonrpc: '2.0', id: 5, method: 'nao/existe' });
      await pronto;
      child.stdin.end();
      const por = Object.fromEntries(respostas.map((r) => [r.id as number, r]));
      expect(respostas.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
      expect(por[1].result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'documentos', version: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version } });
      expect((por[2].result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toContain('conferir_boleto');
      const call = por[3].result as { content: Array<{ type: string; text: string }>; isError: boolean };
      expect(call.isError).toBe(false);
      expect(JSON.parse(call.content[0].text).divergencias[0]).toMatchObject({ celula: 'gastos.csv!B5', valor_esperado: 1315.5 });
      const negado = por[4].result as { content: Array<{ text: string }>; isError: boolean };
      expect(negado.isError).toBe(true);
      expect(negado.content[0].text).toMatch(/^Erro: só arquivos dentro da pasta do projeto/);
      expect(por[5].error).toMatchObject({ code: -32601 });
      await new Promise<void>((ok) => (child.exitCode !== null ? ok() : child.on('exit', () => ok())));
      expect(child.exitCode).toBe(0);
    },
    T,
  );
});
