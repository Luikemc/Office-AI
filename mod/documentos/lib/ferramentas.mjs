// As ferramentas do MCP de documentos: contrato (nome, descrição, esquema) e execução.
import { readFileSync } from 'node:fs';
import { extname, relative } from 'node:path';
import { gravarCorrigido, resolverArquivo } from './caminho.mjs';
import { lerPdf } from './pdf.mjs';
import { acharPlanilha, dimensao, enderecoCompleto, lerCsv, lerXlsx } from './planilha.mjs';
import { lerDocx } from './docx.mjs';
import { conferirPlanilhas } from './conferir.mjs';
import { corrigirCsv, corrigirDocxArquivo, corrigirXlsx } from './corrigir.mjs';
import { datasDoFator, verificarCodigo, vencimentoDoFator } from './boleto.mjs';
import { detectar, formatBRL, linhaEm, parseNumero, trechoEm } from './valores.mjs';
import { endereco } from './formula.mjs';

export const MAX_ARQUIVO = 50 * 1024 * 1024;
const MAX_TEXTO = 60_000;
const MAX_CELULAS = 2_000;
const MAX_LINHAS_CSV = 500;
const MAX_PARAGRAFOS = 1_500;

const SEM_TEXTO = 'Este PDF não tem texto extraível (parece digitalizado ou feito de imagens). Esta versão não faz OCR: não dá para ler os valores dele. Peça ao usuário um PDF com texto, a planilha original ou uma foto para ler com outra ferramenta.';

export class ErroFerramenta extends Error {}

function tipoDe(file) {
  const ext = extname(file).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.xlsx' || ext === '.xlsm') return 'xlsx';
  if (ext === '.csv' || ext === '.tsv') return 'csv';
  if (ext === '.docx') return 'docx';
  if (ext === '.xls') throw new ErroFerramenta('.xls (Excel 97–2003) não é suportado: salve como .xlsx e tente de novo');
  if (ext === '.doc') throw new ErroFerramenta('.doc (Word 97–2003) não é suportado: salve como .docx e tente de novo');
  throw new ErroFerramenta(`formato não suportado (${ext || 'sem extensão'}): aceito .pdf, .xlsx, .csv e .docx`);
}

const LOCAL_CAMINHO = { type: 'string', description: 'Caminho do arquivo, relativo à pasta do projeto (ou absoluto dentro dela).' };

export const FERRAMENTAS = [
  {
    name: 'ler_documento',
    title: 'Ler documento',
    description:
      'Lê um documento da pasta do projeto e devolve o conteúdo com a origem de cada coisa. PDF com texto: o texto de cada página (p.1, p.2…) e os valores em R$, datas, CPF/CNPJ (com DV conferido) e linhas digitáveis achados, cada um com página, linha e trecho. XLSX: por planilha, as células com endereço (Plan1!B7), valor (o guardado, para fórmulas) e fórmula. CSV: linhas e colunas (B7 = linha 7, coluna 2). DOCX: parágrafos (§1, §2…) e tabelas (T1:L2:C3). PDF digitalizado (só imagem) não é lido: não há OCR. Cite sempre o local ao responder.',
    inputSchema: {
      type: 'object',
      properties: {
        caminho: LOCAL_CAMINHO,
        planilha: { type: 'string', description: 'XLSX: só esta planilha (nome da aba).' },
        pagina: { type: 'integer', minimum: 1, description: 'PDF: só esta página.' },
      },
      required: ['caminho'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'conferir_planilha',
    title: 'Conferir planilha',
    description:
      'Confere as contas de uma planilha (.xlsx ou .csv) em código, sem depender do modelo: refaz as fórmulas SUM e + - * / sobre células e intervalos e compara com o valor guardado; acha linhas e colunas de "Total"/"Soma"/"Subtotal" cujo valor não bate com a soma dos itens (mesmo sem fórmula, ou com fórmula que deixa itens de fora). Cada divergência vem com {celula, valor_encontrado, valor_esperado, diferenca, trecho}. Fórmulas com outras funções aparecem como "não conferida".',
    inputSchema: {
      type: 'object',
      properties: { caminho: LOCAL_CAMINHO, planilha: { type: 'string', description: 'Só esta planilha (nome da aba); padrão: todas.' } },
      required: ['caminho'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'conferir_boleto',
    title: 'Conferir boleto',
    description:
      'Confere um boleto em PDF com texto: acha a linha digitável (ou o código de barras), confere os dígitos verificadores (FEBRABAN, módulo 10 e 11; bancário e de arrecadação/concessionária), tira dela o valor e o vencimento (fator de vencimento, inclusive o novo ciclo depois de 22/02/2025) e compara com o valor e a data impressos no boleto, citando página e trecho.',
    inputSchema: { type: 'object', properties: { caminho: LOCAL_CAMINHO }, required: ['caminho'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'salvar_correcao',
    title: 'Salvar correção',
    description:
      'Grava as correções num arquivo NOVO ao lado do original, <nome>-corrigido.<ext> (ou -corrigido-2, -3… se já existir); o original nunca é alterado. XLSX: local = célula (Plan1!B7 ou B7 para a primeira aba), novo_valor = número, texto, data dd/mm/aaaa ou fórmula começando com "="; as contas que dependem dela são refeitas e o arquivo pede recálculo ao abrir. CSV: local = célula (B7). DOCX: local = §12 (parágrafo) ou T1:L2:C3 (tabela, linha, coluna); com texto_original troca só aquele trecho, sem ele troca o texto todo do local. PDF não é editado: escreva um relatório .md/.txt com as correções.',
    inputSchema: {
      type: 'object',
      properties: {
        caminho: LOCAL_CAMINHO,
        correcoes: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              local: { type: 'string', description: 'Plan1!B7 / B7 (planilha, csv) ou §12 / T1:L2:C3 (docx).' },
              novo_valor: { type: ['string', 'number', 'boolean'], description: 'O valor certo.' },
              texto_original: { type: 'string', description: 'Opcional (docx, csv): o trecho a trocar dentro do local.' },
            },
            required: ['local', 'novo_valor'],
            additionalProperties: false,
          },
        },
      },
      required: ['caminho', 'correcoes'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

// ------------------------------------------------------------------------------------------------

function abrir(raiz, caminho) {
  const f = resolverArquivo(raiz, caminho, MAX_ARQUIVO);
  return { ...f, buf: readFileSync(f.real), tipo: tipoDe(f.real) };
}

function juntarAchados(lista) {
  const out = { valores: [], datas: [], documentos: [], linhas_digitaveis: [] };
  for (const a of lista) for (const k of Object.keys(out)) out[k].push(...a[k]);
  for (const k of Object.keys(out)) if (out[k].length > 300) out[k] = out[k].slice(0, 300);
  return out;
}

async function lerPdfArquivo(f, pagina) {
  const r = await lerPdf(f.real, f.buf);
  const total = r.paginas.length;
  const semTexto = r.paginas.every((p) => !p.trim());
  return { ...r, total, semTexto, escolhidas: pagina ? [pagina] : r.paginas.map((_, i) => i + 1) };
}

async function lerDocumento(raiz, args) {
  const f = abrir(raiz, args.caminho);
  const base = { arquivo: f.relativo, tipo: f.tipo, tamanho_bytes: f.tamanho };
  if (f.tipo === 'pdf') {
    const r = await lerPdfArquivo(f, args.pagina);
    if (args.pagina && args.pagina > r.total) throw new ErroFerramenta(`o PDF tem ${r.total} página(s)`);
    if (r.semTexto) return { ...base, paginas: r.total, extrator: r.extrator, sem_texto: true, aviso: r.aviso ? `${SEM_TEXTO} (${r.aviso})` : SEM_TEXTO };
    const texto = [];
    const notas = [];
    let usados = 0;
    const achados = [];
    for (const n of r.escolhidas) {
      const t = r.paginas[n - 1] ?? '';
      achados.push(detectar(t, { pagina: `p.${n}` }));
      if (usados >= MAX_TEXTO) {
        notas.push(`p.${n}`);
        continue;
      }
      const corte = t.length > MAX_TEXTO - usados ? t.slice(0, MAX_TEXTO - usados) : t;
      usados += corte.length;
      texto.push({ pagina: `p.${n}`, texto: corte, ...(corte.length < t.length ? { truncado: true } : {}) });
    }
    return {
      ...base,
      paginas: r.total,
      extrator: r.extrator,
      ...(r.aviso ? { aviso: r.aviso } : {}),
      achados: juntarAchados(achados),
      texto_por_pagina: texto,
      ...(notas.length ? { nota: `texto truncado no limite de ${MAX_TEXTO} caracteres; páginas sem texto aqui: ${notas.join(', ')} (peça cada uma com "pagina"). Os achados cobrem todas.` } : {}),
    };
  }
  if (f.tipo === 'xlsx') {
    const wb = lerXlsx(f.buf);
    const alvo = args.planilha ? [acharPlanilha(wb, args.planilha)].filter(Boolean) : wb.planilhas;
    if (!alvo.length) throw new ErroFerramenta(`planilha "${args.planilha}" não existe (há: ${wb.planilhas.map((p) => p.nome).join(', ')})`);
    let usados = 0;
    let omitidas = 0;
    const planilhas = alvo.map((p) => {
      const cells = [...p.cells.values()].filter((c) => c.valor !== null || c.formula).sort((a, b) => a.row - b.row || a.col - b.col);
      const lista = [];
      for (const c of cells) {
        if (usados >= MAX_CELULAS) {
          omitidas++;
          continue;
        }
        usados++;
        const item = { celula: enderecoCompleto(p.nome, c.row, c.col), valor: c.valor };
        if (c.formula) item.formula = `=${c.formula}`;
        if (c.data) item.data = c.data;
        if (c.tipo === 'e') item.erro = true;
        lista.push(item);
      }
      return { nome: p.nome, dimensao: dimensao(p.cells), total_celulas: cells.length, celulas: lista };
    });
    return {
      ...base,
      planilhas_no_arquivo: wb.planilhas.map((p) => p.nome),
      planilhas,
      ...(omitidas ? { nota: `mostrando ${MAX_CELULAS} células; ${omitidas} ficaram de fora (use "planilha" para ler uma aba por vez). conferir_planilha confere todas.` } : {}),
      observacao: 'para fórmulas, "valor" é o resultado guardado no arquivo; conferir_planilha refaz a conta',
    };
  }
  if (f.tipo === 'csv') {
    const csv = lerCsv(f.buf, f.relativo);
    const linhas = csv.linhas.slice(0, MAX_LINHAS_CSV).map((l, i) => ({ linha: i + 1, valores: l.campos.map((c) => c.valor) }));
    const colunas = csv.linhas.reduce((m, l) => Math.max(m, l.campos.length), 0);
    const achados = detectar(csv.texto, {});
    return {
      ...base,
      separador: csv.separador === '\t' ? 'tab' : csv.separador,
      codificacao: csv.codificacao,
      total_linhas: csv.linhas.length,
      total_colunas: colunas,
      enderecos: `célula = coluna + linha (A1 é a primeira); ${colunas ? `a última coluna é ${endereco(colunas, 1).replace(/\d+$/, '')}` : ''}`,
      linhas,
      achados: { valores: achados.valores.slice(0, 100), datas: achados.datas.slice(0, 100), documentos: achados.documentos },
      ...(csv.linhas.length > MAX_LINHAS_CSV ? { nota: `mostrando ${MAX_LINHAS_CSV} de ${csv.linhas.length} linhas; conferir_planilha confere todas` } : {}),
    };
  }
  // docx
  const d = lerDocx(f.buf);
  const paragrafos = d.paragrafos.filter((p) => p.texto.trim()).slice(0, MAX_PARAGRAFOS);
  const achados = [];
  for (const p of d.paragrafos) achados.push(detectar(p.texto, { local: p.local }));
  d.tabelas.forEach((t) => t.linhas.forEach((l, li) => l.forEach((c, ci) => achados.push(detectar(c.texto, { local: `T${t.indice}:L${li + 1}:C${ci + 1}` })))));
  for (const a of achados) for (const k of Object.keys(a)) for (const x of a[k]) delete x.linha;
  return {
    ...base,
    total_paragrafos: d.paragrafos.length,
    paragrafos: paragrafos.map((p) => ({ local: p.local, texto: p.texto, ...(p.estilo ? { estilo: p.estilo } : {}) })),
    tabelas: d.tabelas.map((t) => ({ tabela: `T${t.indice}`, linhas: t.linhas.map((l) => l.map((c) => c.texto)) })),
    achados: juntarAchados(achados),
    observacao: 'parágrafos vazios foram omitidos (a numeração §n conta todos); célula de tabela = T<tabela>:L<linha>:C<coluna>; cabeçalho, rodapé e notas não são lidos',
    ...(d.paragrafos.filter((p) => p.texto.trim()).length > MAX_PARAGRAFOS ? { nota: `mostrando ${MAX_PARAGRAFOS} parágrafos com texto` } : {}),
  };
}

function conferirPlanilha(raiz, args) {
  const f = abrir(raiz, args.caminho);
  if (f.tipo !== 'xlsx' && f.tipo !== 'csv') throw new ErroFerramenta('conferir_planilha aceita .xlsx e .csv (para PDF de boleto use conferir_boleto; para outros, ler_documento)');
  const wb = f.tipo === 'xlsx' ? lerXlsx(f.buf) : lerCsv(f.buf, f.relativo);
  let nomes;
  if (args.planilha) {
    const p = acharPlanilha(wb, args.planilha);
    if (!p) throw new ErroFerramenta(`planilha "${args.planilha}" não existe (há: ${wb.planilhas.map((x) => x.nome).join(', ')})`);
    nomes = [p.nome];
  }
  const r = conferirPlanilhas(wb, nomes);
  const conclusao = r.divergencias.length
    ? `${r.divergencias.length} conta(s) não batem: ` +
      r.divergencias
        .slice(0, 10)
        .map((d) => `${d.celula} está ${fmtNum(d.valor_encontrado)}, o certo seria ${fmtNum(d.valor_esperado)}${d.diferenca !== null ? ` (diferença ${fmtNum(d.diferenca)})` : ''}`)
        .join('; ')
    : `Nenhuma divergência: ${r.resumo.formulas_conferidas} fórmula(s) e ${r.resumo.totais_conferidos} total(is) conferidos${r.resumo.formulas_nao_conferidas ? `; ${r.resumo.formulas_nao_conferidas} fórmula(s) com funções que não confiro` : ''}.`;
  return { arquivo: f.relativo, tipo: f.tipo, conclusao, ...r };
}

const fmtNum = (v) => (typeof v === 'number' ? formatBRL(v) : String(v));

const RE_ROTULO_VALOR = /valor\s+(?:do\s+)?documento|valor\s+cobrado|valor\s+a\s+pagar|total\s+a\s+pagar|valor\s+do\s+boleto|valor\s+total|\(=\)\s*valor/gi;
const RE_ROTULO_VENC = /vencimento/gi;
const RE_DINHEIRO_SIMPLES = /(R\$\s*)?(?<![\d.,])\d{1,3}(?:\.\d{3})*,\d{2}(?![\d,])/g;

function acharImpresso(paginas, reRotulo, reValor, linhaDigitavel) {
  for (let i = 0; i < paginas.length; i++) {
    const t = paginas[i];
    for (const m of t.matchAll(reRotulo)) {
      const depois = t.slice(m.index + m[0].length, m.index + m[0].length + 400);
      reValor.lastIndex = 0;
      for (const v of depois.matchAll(reValor)) {
        const idx = m.index + m[0].length + v.index;
        // valor dentro da própria linha digitável não conta
        if (linhaDigitavel && trechoEm(t, idx, v[0].length).replace(/\D/g, '').includes(linhaDigitavel.slice(0, 20))) continue;
        return { texto: v[0].trim(), pagina: `p.${i + 1}`, linha: linhaEm(t, idx), rotulo: m[0], trecho: trechoEm(t, idx, v[0].length), index: idx };
      }
    }
  }
  return undefined;
}

async function conferirBoleto(raiz, args) {
  const f = abrir(raiz, args.caminho);
  if (f.tipo !== 'pdf') throw new ErroFerramenta('conferir_boleto lê boletos em PDF com texto');
  const r = await lerPdfArquivo(f);
  if (r.semTexto) return { arquivo: f.relativo, sem_texto: true, aviso: SEM_TEXTO };
  const codigos = [];
  r.paginas.forEach((t, i) => {
    for (const l of detectar(t, { pagina: `p.${i + 1}` }).linhas_digitaveis) codigos.push(l);
  });
  if (!codigos.length) {
    return {
      arquivo: f.relativo,
      boletos: [],
      conclusao: 'Não achei linha digitável (47 ou 48 dígitos) nem código de barras (44 dígitos) no texto. O código pode estar só como imagem das barras; confira o texto com ler_documento.',
    };
  }
  const valorImpresso = acharImpresso(r.paginas, RE_ROTULO_VALOR, RE_DINHEIRO_SIMPLES, codigos[0].digitos);
  const vencImpresso = acharImpresso(r.paginas, RE_ROTULO_VENC, /(?<!\d)(\d{2})\/(\d{2})\/(\d{4})(?!\d)/g);
  const vencIso = vencImpresso ? vencImpresso.texto.split('/').reverse().join('-') : undefined;
  const valorImpressoNum = valorImpresso ? parseNumero(valorImpresso.texto.replace(/^R\$\s*/, '')) : undefined;
  // Um mesmo boleto costuma trazer a linha digitável duas vezes (recibo e ficha): conferimos cada uma.
  const boletos = codigos.map((c) => {
    const v = verificarCodigo(c.digitos);
    const b = { pagina: c.pagina, linha_no_texto: c.linha, trecho: c.trecho, ...v };
    if (v.tipo === 'bancario') {
      b.vencimento_na_linha = v.fator_vencimento ? vencimentoDoFator(v.fator_vencimento, vencIso) : undefined;
      if (v.fator_vencimento && datasDoFator(v.fator_vencimento).length > 1)
        b.nota_fator = `o fator ${v.fator_vencimento} vale para ${datasDoFator(v.fator_vencimento).join(' e ')} (o ciclo recomeçou em 22/02/2025); usei a mais próxima ${vencIso ? 'da data impressa' : 'de hoje'}`;
      if (!v.fator_vencimento) b.vencimento_na_linha = 'sem vencimento (fator 0000)';
    }
    const comp = {};
    if (valorImpressoNum !== undefined) {
      if (v.valor_na_linha === undefined) comp.valor = 'a linha não traz valor (zerado): vale o valor digitado no pagamento';
      else comp.valor = Math.abs(v.valor_na_linha - valorImpressoNum) < 0.005 ? 'confere' : `NÃO CONFERE: a linha diz ${formatBRL(v.valor_na_linha)}, o impresso diz ${formatBRL(valorImpressoNum)} (diferença ${formatBRL(valorImpressoNum - v.valor_na_linha)})`;
    }
    if (vencIso && typeof b.vencimento_na_linha === 'string' && /^\d{4}-/.test(b.vencimento_na_linha)) comp.vencimento = b.vencimento_na_linha === vencIso ? 'confere' : `NÃO CONFERE: a linha diz ${b.vencimento_na_linha.split('-').reverse().join('/')}, o impresso diz ${vencImpresso.texto}`;
    b.comparacao = comp;
    return b;
  });
  const principal = boletos[0];
  const frases = [];
  if (principal.digitos_ok) frases.push(`A ${principal.origem} (${principal.pagina}) é válida: os dígitos verificadores conferem.`);
  else frases.push(`A ${principal.origem ?? 'sequência'} (${principal.pagina}) tem dígito verificador errado: ${principal.erros_dv.map((e) => `${e.campo} tem ${e.dv_encontrado}, o certo seria ${e.dv_esperado} (${e.regra})`).join('; ')}. Provável erro de digitação: não pague por essa linha sem conferir.`);
  if (principal.valor_na_linha !== undefined) frases.push(`Valor na linha: R$ ${formatBRL(principal.valor_na_linha)}.`);
  if (valorImpresso) frases.push(`Valor impresso: ${valorImpresso.texto} (${valorImpresso.pagina}, “${valorImpresso.trecho}”).`);
  if (principal.comparacao.valor?.startsWith('NÃO'))
    frases.push(
      principal.digitos_ok
        ? `O valor impresso está diferente do que a linha cobra: o banco cobra o da linha (R$ ${formatBRL(principal.valor_na_linha)}); o impresso (${valorImpresso.texto}) é o que não bate.`
        : 'O valor impresso também não bate com a linha.',
    );
  if (principal.comparacao.vencimento) frases.push(`Vencimento: ${principal.comparacao.vencimento === 'confere' ? `confere (${vencImpresso.texto})` : principal.comparacao.vencimento}.`);
  const outras = boletos.slice(1).filter((b) => b.codigo_de_barras !== principal.codigo_de_barras);
  if (outras.length) frases.push(`Há ${outras.length} outra(s) linha(s)/código(s) diferente(s) no documento: veja "boletos".`);
  return {
    arquivo: f.relativo,
    extrator: r.extrator,
    conclusao: frases.join(' '),
    valor_impresso: valorImpresso ? { texto: valorImpresso.texto, valor: valorImpressoNum, pagina: valorImpresso.pagina, linha: valorImpresso.linha, rotulo: valorImpresso.rotulo, trecho: valorImpresso.trecho } : undefined,
    vencimento_impresso: vencImpresso ? { texto: vencImpresso.texto, iso: vencIso, pagina: vencImpresso.pagina, linha: vencImpresso.linha, trecho: vencImpresso.trecho } : undefined,
    boletos,
  };
}

function salvarCorrecao(raiz, args) {
  const f = abrir(raiz, args.caminho);
  if (f.tipo === 'pdf') {
    return {
      arquivo: f.relativo,
      suportado: false,
      mensagem: 'Esta versão não edita PDF. O original continua intacto. Sugestão: escreva um relatório ao lado dele (por exemplo, ' + f.relativo.replace(/\.pdf$/i, '-correcoes.md') + ') listando cada valor errado, o certo e onde está (página e trecho).',
    };
  }
  if (!Array.isArray(args.correcoes) || !args.correcoes.length) throw new ErroFerramenta('informe ao menos uma correção');
  const r = f.tipo === 'xlsx' ? corrigirXlsx(f.buf, args.correcoes) : f.tipo === 'csv' ? corrigirCsv(f.buf, f.relativo, args.correcoes) : corrigirDocxArquivo(f.buf, args.correcoes);
  if (!r.aplicadas.length || !r.dados) return { arquivo: f.relativo, gravado: false, mensagem: 'Nenhuma correção pôde ser aplicada; nada foi gravado.', erros: r.erros };
  const alvo = gravarCorrigido(f.real, r.dados);
  const { dados: _dados, ...resto } = r;
  return {
    arquivo_original: f.relativo,
    arquivo_corrigido: relative(f.root, alvo),
    gravado: true,
    original_intacto: true,
    ...resto,
    ...(f.tipo === 'xlsx' ? { observacao: 'o arquivo pede ao Excel/LibreOffice que recalcule tudo ao abrir' } : {}),
  };
}

/** Roda uma ferramenta: {resultado} ou lança ErroFerramenta / ErroCaminho. */
export async function executar(nome, args, raiz) {
  const a = args && typeof args === 'object' ? args : {};
  switch (nome) {
    case 'ler_documento':
      return lerDocumento(raiz, a);
    case 'conferir_planilha':
      return conferirPlanilha(raiz, a);
    case 'conferir_boleto':
      return conferirBoleto(raiz, a);
    case 'salvar_correcao':
      return salvarCorrecao(raiz, a);
    default:
      throw new ErroFerramenta(`ferramenta desconhecida: ${nome}`);
  }
}
