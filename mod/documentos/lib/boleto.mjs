// Boleto: dígitos verificadores (FEBRABAN), valor e vencimento que a própria linha digitável carrega.
//
// Bancário (47 dígitos na linha, 44 no código de barras):
//   código de barras = banco(3) moeda(1) DV(1) fator(4) valor(10) campo livre(25)
//   linha = campo1 [banco moeda livre1-5 | DV mod10] campo2 [livre6-15 | DV] campo3 [livre16-25 | DV] DV geral, fator+valor
// Arrecadação/concessionária (48 na linha, 44 no código): começa com 8; 4 blocos de 11 dígitos + DV (mod 10 se o 3º
//   dígito for 6 ou 7, mod 11 se for 8 ou 9); valor nas posições 5–15 quando o 3º dígito é 6 ou 8.
//
// Fator de vencimento: dias desde 07/10/1997. Chegou a 9999 em 21/02/2025 e voltou a 1000 em 22/02/2025 (cada fator
// vale para duas datas, uma de cada ciclo): escolhemos a mais próxima da data impressa ou, sem ela, de hoje.

export function mod10(digits) {
  let sum = 0;
  let w = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    let p = Number(digits[i]) * w;
    if (p > 9) p = Math.floor(p / 10) + (p % 10);
    sum += p;
    w = w === 2 ? 1 : 2;
  }
  return (10 - (sum % 10)) % 10;
}

function mod11Soma(digits) {
  let sum = 0;
  let w = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += Number(digits[i]) * w;
    w = w === 9 ? 2 : w + 1;
  }
  return sum;
}

/** DV geral do código de barras bancário: 0, 10 e 11 viram 1. */
export function mod11Bancario(digits) {
  const dv = 11 - (mod11Soma(digits) % 11);
  return dv === 0 || dv === 10 || dv === 11 ? 1 : dv;
}

/** Mod 11 de arrecadação: resto 0 ou 1 → 0; resto 10 → 1. */
export function mod11Arrecadacao(digits) {
  const r = mod11Soma(digits) % 11;
  return r === 0 || r === 1 ? 0 : 11 - r;
}

const DIA = 86_400_000;
const BASE_1 = Date.UTC(1997, 9, 7);
const BASE_2 = Date.UTC(2025, 1, 22); // fator 1000 do segundo ciclo

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** As datas possíveis de um fator (uma por ciclo), da mais antiga para a mais nova. */
export function datasDoFator(fator) {
  if (!fator) return [];
  const out = [iso(BASE_1 + fator * DIA)];
  if (fator >= 1000) out.push(iso(BASE_2 + (fator - 1000) * DIA));
  return out;
}

/** Escolhe a data do fator mais perto da referência (ISO) — a impressa ou hoje. */
export function vencimentoDoFator(fator, referenciaIso) {
  const opcoes = datasDoFator(fator);
  if (!opcoes.length) return undefined;
  const ref = referenciaIso ? Date.parse(referenciaIso) : Date.now();
  return opcoes.reduce((a, b) => (Math.abs(Date.parse(b) - ref) < Math.abs(Date.parse(a) - ref) ? b : a));
}

/** Monta o código de barras (44) a partir da linha bancária (47). */
export function barrasDaLinhaBancaria(l) {
  return l.slice(0, 4) + l.slice(32, 33) + l.slice(33, 47) + l.slice(4, 9) + l.slice(10, 20) + l.slice(21, 31);
}

/** Linha bancária (47) a partir do código de barras (44), com os DVs dos campos calculados. */
export function linhaDasBarrasBancarias(b) {
  const c1 = b.slice(0, 4) + b.slice(19, 24);
  const c2 = b.slice(24, 34);
  const c3 = b.slice(34, 44);
  return c1 + mod10(c1) + c2 + mod10(c2) + c3 + mod10(c3) + b[4] + b.slice(5, 19);
}

/** Formata a linha bancária como impressa: 00190.00009 01234.567890 ... */
export function formatarLinhaBancaria(l) {
  return `${l.slice(0, 5)}.${l.slice(5, 10)} ${l.slice(10, 15)}.${l.slice(15, 21)} ${l.slice(21, 26)}.${l.slice(26, 32)} ${l[32]} ${l.slice(33)}`;
}

function verificarBancario(digitos, origem) {
  const erros = [];
  let barras;
  let linha;
  if (digitos.length === 47) {
    linha = digitos;
    const campos = [
      { nome: 'campo 1', dados: digitos.slice(0, 9), dv: digitos[9] },
      { nome: 'campo 2', dados: digitos.slice(10, 20), dv: digitos[20] },
      { nome: 'campo 3', dados: digitos.slice(21, 31), dv: digitos[31] },
    ];
    for (const c of campos) {
      const esperado = String(mod10(c.dados));
      if (esperado !== c.dv) erros.push({ campo: c.nome, dv_encontrado: c.dv, dv_esperado: esperado, regra: 'módulo 10' });
    }
    barras = barrasDaLinhaBancaria(digitos);
  } else {
    barras = digitos;
    linha = linhaDasBarrasBancarias(digitos);
  }
  const semDv = barras.slice(0, 4) + barras.slice(5);
  const dvGeral = String(mod11Bancario(semDv));
  if (dvGeral !== barras[4]) erros.push({ campo: 'DV geral (5º dígito do código de barras)', dv_encontrado: barras[4], dv_esperado: dvGeral, regra: 'módulo 11' });
  const fator = Number(barras.slice(5, 9));
  const valor = Number(barras.slice(9, 19)) / 100;
  return {
    tipo: 'bancario',
    origem,
    banco: barras.slice(0, 3),
    moeda: barras[3] === '9' ? 'real' : barras[3],
    linha_digitavel: formatarLinhaBancaria(linha),
    codigo_de_barras: barras,
    digitos_ok: erros.length === 0,
    erros_dv: erros,
    fator_vencimento: fator,
    datas_possiveis_do_fator: datasDoFator(fator),
    valor_na_linha: valor || undefined,
  };
}

function verificarArrecadacao(digitos, origem) {
  const erros = [];
  const ref = digitos[2];
  const mod = ref === '6' || ref === '7' ? mod10 : ref === '8' || ref === '9' ? mod11Arrecadacao : undefined;
  if (!mod) return { tipo: 'arrecadacao', origem, digitos_ok: false, erros_dv: [{ campo: '3º dígito', dv_encontrado: ref, dv_esperado: '6, 7, 8 ou 9', regra: 'identificador de valor' }] };
  let barras;
  if (digitos.length === 48) {
    barras = '';
    for (let i = 0; i < 4; i++) {
      const bloco = digitos.slice(i * 12, i * 12 + 11);
      const dv = digitos[i * 12 + 11];
      const esperado = String(mod(bloco));
      if (esperado !== dv) erros.push({ campo: `bloco ${i + 1}`, dv_encontrado: dv, dv_esperado: esperado, regra: mod === mod10 ? 'módulo 10' : 'módulo 11' });
      barras += bloco;
    }
  } else barras = digitos;
  const geral = String(mod(barras.slice(0, 3) + barras.slice(4)));
  if (geral !== barras[3]) erros.push({ campo: 'DV geral (4º dígito do código de barras)', dv_encontrado: barras[3], dv_esperado: geral, regra: mod === mod10 ? 'módulo 10' : 'módulo 11' });
  const efetivo = ref === '6' || ref === '8';
  return {
    tipo: 'arrecadacao',
    origem,
    codigo_de_barras: barras,
    digitos_ok: erros.length === 0,
    erros_dv: erros,
    valor_na_linha: efetivo ? Number(barras.slice(4, 15)) / 100 || undefined : undefined,
    observacao: efetivo ? undefined : 'o 3º dígito diz que o valor é de referência (não em reais): não dá para comparar',
  };
}

/** Confere uma sequência de dígitos (44, 47 ou 48). */
export function verificarCodigo(digitos) {
  const d = String(digitos).replace(/\D/g, '');
  if (d.length === 47) return verificarBancario(d, 'linha digitável');
  if (d.length === 48 && d[0] === '8') return verificarArrecadacao(d, 'linha digitável');
  if (d.length === 44) return d[0] === '8' ? verificarArrecadacao(d, 'código de barras') : verificarBancario(d, 'código de barras');
  return { tipo: 'desconhecido', digitos_ok: false, erros_dv: [{ campo: 'tamanho', dv_encontrado: String(d.length), dv_esperado: '44, 47 ou 48 dígitos', regra: 'formato' }] };
}
