// Conferências determinísticas de planilha: refaz as fórmulas simples e soma de novo as linhas/colunas de total.
import { avaliar, endereco, NaoConferida, parseFormula, referencias } from './formula.mjs';
import { chave, enderecoCompleto } from './planilha.mjs';
import { formatBRL, parseNumero, round } from './valores.mjs';

const RE_TOTAL = /^\s*(sub-?\s?total|total|soma|somat[óo]rio|valor\s+total|total\s+geral)\b/i;
/** Colunas que não entram numa soma de linha (identificadores, não quantias). */
const RE_COLUNA_NAO_SOMA = /^\s*(ano|m[eê]s|dia|c[oó]d|id\b|n[º°o.]|n[uú]mero|item|cpf|cnpj|cep|telefone|data|matr[ií]cula|%|percent|al[ií]quota|taxa)/i;

const tolFormula = (v) => 1e-6 * Math.max(1, Math.abs(v));
const tolDigitado = (v) => 0.005 + 1e-9 * Math.abs(v);

function fmt(v) {
  if (typeof v !== 'number') return JSON.stringify(v);
  return Number.isInteger(v * 100) || Math.abs(v) >= 0.01 ? formatBRL(v).replace(/,00$/, '') : String(v);
}

/** Texto de verdade (não um número guardado como texto). */
const ehRotulo = (x) => x && typeof x.valor === 'string' && x.valor.trim() !== '' && parseNumero(x.valor) === undefined;

function rotulos(cells, row, col) {
  let linha;
  for (let c = 1; c < col; c++) {
    const x = cells.get(chave(row, c));
    if (ehRotulo(x)) {
      linha = x.valor.trim();
      break;
    }
  }
  let coluna;
  for (let r = row - 1; r >= 1; r--) {
    const x = cells.get(chave(r, col));
    if (ehRotulo(x)) {
      coluna = x.valor.trim();
      break;
    }
  }
  return { linha, coluna };
}

function trecho(sheet, cell, extra) {
  const { linha, coluna } = rotulos(sheet.cells, cell.row, cell.col);
  const partes = [];
  if (linha) partes.push(`linha ${cell.row} "${linha.slice(0, 40)}"`);
  if (coluna) partes.push(`coluna "${coluna.slice(0, 40)}"`);
  partes.push(`${endereco(cell.col, cell.row)} = ${fmt(cell.valor)}${cell.formula ? ` (=${cell.formula})` : ''}`);
  if (extra) partes.push(extra);
  return partes.join(' · ');
}

const ehTotal = (x) => x && typeof x.valor === 'string' && RE_TOTAL.test(x.valor);

/** Intervalos compactos ("B2:B6") de uma lista de células da mesma coluna ou linha. */
function intervalo(lista) {
  if (!lista.length) return '';
  const ord = [...lista].sort((a, b) => a.row - b.row || a.col - b.col);
  const grupos = [];
  for (const c of ord) {
    const g = grupos[grupos.length - 1];
    if (g && ((g.fim.col === c.col && g.fim.row + 1 === c.row) || (g.fim.row === c.row && g.fim.col + 1 === c.col))) g.fim = c;
    else grupos.push({ ini: c, fim: c });
  }
  return grupos.map((g) => (g.ini === g.fim ? endereco(g.ini.col, g.ini.row) : `${endereco(g.ini.col, g.ini.row)}:${endereco(g.fim.col, g.fim.row)}`)).join(',');
}

/**
 * Confere as planilhas. `wb.planilhas` = [{nome, cells}]. Devolve {divergencias, nao_conferidas, resumo}.
 */
export function conferirPlanilhas(wb, nomes) {
  const porNome = new Map(wb.planilhas.map((p) => [p.nome, p]));
  const get = (sheet, row, col) => {
    const p = porNome.get(sheet) ?? [...porNome.values()].find((x) => x.nome.toLowerCase() === String(sheet).toLowerCase());
    if (!p) throw new NaoConferida(`planilha "${sheet}" não existe`);
    const c = p.cells.get(chave(row, col));
    return c ? c.valor : null;
  };
  const divergencias = [];
  const naoConferidas = [];
  const conferidas = [];
  let formulas = 0;
  let totais = 0;
  const alvo = nomes ? wb.planilhas.filter((p) => nomes.includes(p.nome)) : wb.planilhas;
  for (const sheet of alvo) {
    // 1. Fórmulas: refaz a conta com os valores guardados das células que ela lê.
    for (const cell of sheet.cells.values()) {
      if (!cell.formula) continue;
      formulas++;
      const celula = enderecoCompleto(sheet.nome, cell.row, cell.col);
      let esperado;
      try {
        esperado = avaliar(parseFormula(cell.formula), sheet.nome, get);
      } catch (e) {
        if (!(e instanceof NaoConferida)) throw e;
        naoConferidas.push({ celula, formula: `=${cell.formula}`, motivo: `não conferida: ${e.message}` });
        continue;
      }
      if (typeof cell.valor !== 'number') {
        divergencias.push({
          tipo: 'formula_sem_valor',
          celula,
          formula: `=${cell.formula}`,
          valor_encontrado: cell.valor,
          valor_esperado: round(esperado),
          diferenca: null,
          trecho: trecho(sheet, cell),
          explicacao: 'a fórmula não tem valor calculado guardado (ou guardou texto); o valor que ela dá é o esperado',
        });
        continue;
      }
      const dif = cell.valor - esperado;
      if (Math.abs(dif) > tolFormula(esperado)) {
        divergencias.push({
          tipo: 'formula',
          celula,
          formula: `=${cell.formula}`,
          valor_encontrado: cell.valor,
          valor_esperado: round(esperado),
          diferenca: round(dif),
          trecho: trecho(sheet, cell),
          explicacao: `o valor guardado na célula (${fmt(cell.valor)}) não é o resultado da própria fórmula (${fmt(round(esperado))})`,
        });
      } else conferidas.push(celula);
    }
    // 2. Linhas de total: cada número à direita do rótulo "Total" contra a soma da coluna acima.
    const cells = sheet.cells;
    const rotulosTotal = [...cells.values()].filter(ehTotal);
    const todas = [...cells.values()];
    const maxRow = todas.reduce((m, x) => Math.max(m, x.row), 0);
    const linhasTotal = new Set(rotulosTotal.filter((r) => todas.some((x) => x.row === r.row && x.col > r.col && typeof x.valor === 'number')).map((c) => c.row));
    for (const rot of rotulosTotal) {
      for (const cell of cells.values()) {
        if (cell.row !== rot.row || cell.col <= rot.col || typeof cell.valor !== 'number') continue;
        const bloco = [];
        const todos = [];
        const subtotais = [];
        let noBloco = true;
        for (let r = cell.row - 1; r >= 1; r--) {
          const x = cells.get(chave(r, cell.col));
          if (linhasTotal.has(r)) {
            noBloco = false;
            if (x && typeof x.valor === 'number') subtotais.push(x);
            continue;
          }
          if (!x || x.valor === null || x.valor === '') continue;
          if (typeof x.valor !== 'number') break; // cabeçalho
          if (noBloco) bloco.push(x);
          todos.push(x);
        }
        if (bloco.length < 2 && subtotais.length < 2) continue;
        totais++;
        const soma = (l) => round(l.reduce((s, x) => s + x.valor, 0), 9);
        const candidatos = [soma(bloco), soma(todos)];
        if (subtotais.length) candidatos.push(round(soma(subtotais) + soma(bloco), 9), soma(subtotais));
        const celula = enderecoCompleto(sheet.nome, cell.row, cell.col);
        if (candidatos.some((v) => Math.abs(cell.valor - v) <= tolDigitado(v))) {
          if (!conferidas.includes(celula)) conferidas.push(celula);
          continue;
        }
        if (divergencias.some((d) => d.celula === celula && d.tipo === 'formula')) continue; // já apontada pela fórmula
        const esperado = candidatos[0];
        const itens = intervalo(bloco);
        let explicacao = `"${rot.valor.trim()}" deveria ser a soma de ${itens} = ${fmt(esperado)}, mas está ${fmt(cell.valor)}`;
        if (cell.formula) {
          const lidas = referencias(safeParse(cell.formula), sheet.nome).filter((r) => r.sheet === sheet.nome && r.col === cell.col);
          const faltam = bloco.filter((b) => !lidas.some((l) => l.row === b.row));
          if (faltam.length) explicacao += `; a fórmula =${cell.formula} deixa de fora ${intervalo(faltam)}`;
        }
        const d = {
          tipo: 'total',
          celula,
          valor_encontrado: cell.valor,
          valor_esperado: esperado,
          diferenca: round(cell.valor - esperado),
          itens,
          trecho: trecho(sheet, cell),
          explicacao,
        };
        if (cell.formula) d.formula = `=${cell.formula}`;
        if (candidatos[1] !== candidatos[0]) d.outras_somas_possiveis = candidatos.slice(1);
        divergencias.push(d);
      }
    }
    // 3. Colunas de total: cabeçalho "Total" e, em cada linha abaixo, a soma (ou o produto de dois) dos números à esquerda.
    for (const cab of rotulosTotal) {
      const colunas = [];
      for (let c = 1; c < cab.col; c++) {
        const h = cells.get(chave(cab.row, c));
        if (h && typeof h.valor === 'string' && h.valor.trim() && !RE_COLUNA_NAO_SOMA.test(h.valor) && !ehTotal(h)) colunas.push(c);
      }
      if (colunas.length < 2) continue;
      for (let r = cab.row + 1; r <= maxRow; r++) {
        const cell = cells.get(chave(r, cab.col));
        if (!cell || typeof cell.valor !== 'number') continue;
        if (linhasTotal.has(r)) continue; // a linha de total já foi conferida pela coluna
        const itens = colunas.map((c) => cells.get(chave(r, c))).filter((x) => x && typeof x.valor === 'number');
        if (itens.length < 2) continue;
        totais++;
        const soma = round(itens.reduce((s, x) => s + x.valor, 0), 9);
        const produto = itens.length === 2 ? round(itens[0].valor * itens[1].valor, 9) : undefined;
        const celula = enderecoCompleto(sheet.nome, r, cab.col);
        if (Math.abs(cell.valor - soma) <= tolDigitado(soma) || (produto !== undefined && Math.abs(cell.valor - produto) <= tolDigitado(produto))) {
          if (!conferidas.includes(celula)) conferidas.push(celula);
          continue;
        }
        if (divergencias.some((d) => d.celula === celula)) continue;
        divergencias.push({
          tipo: 'total_da_linha',
          confianca: 'media',
          celula,
          valor_encontrado: cell.valor,
          valor_esperado: soma,
          diferenca: round(cell.valor - soma),
          itens: intervalo(itens),
          ...(produto !== undefined ? { produto_dos_itens: produto } : {}),
          ...(cell.formula ? { formula: `=${cell.formula}` } : {}),
          trecho: trecho(sheet, cell),
          explicacao: `a coluna "${cab.valor.trim()}" não bate com a soma${produto !== undefined ? ' nem com o produto' : ''} de ${intervalo(itens)} nesta linha (confira se o total é mesmo uma soma)`,
        });
      }
    }
  }
  return {
    planilhas: alvo.map((p) => p.nome),
    resumo: {
      formulas_conferidas: formulas - naoConferidas.length,
      formulas_nao_conferidas: naoConferidas.length,
      totais_conferidos: totais,
      divergencias: divergencias.length,
      celulas_ok: conferidas.length,
    },
    divergencias,
    nao_conferidas: naoConferidas,
    celulas_ok: conferidas.slice(0, 200),
  };
}

function safeParse(f) {
  try {
    return parseFormula(f);
  } catch {
    return undefined;
  }
}
