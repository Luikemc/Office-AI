// Ponto único para os testes (server/test/documentos.test.ts) e para quem quiser usar as funções sem o MCP.
export { executar, FERRAMENTAS, ErroFerramenta } from './ferramentas.mjs';
export { ErroCaminho, resolverArquivo, gravarCorrigido } from './caminho.mjs';
export { buildZip, crc32, openZip, readZip, writeZip } from './zip.mjs';
export { avaliar, deslocar, parseFormula, NaoConferida } from './formula.mjs';
export { datasDoFator, formatarLinhaBancaria, linhaDasBarrasBancarias, mod10, mod11Arrecadacao, mod11Bancario, vencimentoDoFator, verificarCodigo } from './boleto.mjs';
export { extrairSimples, lerPdf } from './pdf.mjs';
export { cnpjValido, cpfValido, detectar, parseNumero } from './valores.mjs';
