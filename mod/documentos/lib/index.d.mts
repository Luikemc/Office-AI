// Tipos (soltos) do index.mjs, para os testes em TypeScript. O código do plugin é JS puro: roda direto no node.
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Ferramenta {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}
export const FERRAMENTAS: Ferramenta[];
export class ErroFerramenta extends Error {}
export class ErroCaminho extends Error {}
export class NaoConferida extends Error {}
export function executar(nome: string, args: Record<string, unknown>, raiz: string): Promise<any>;
export function resolverArquivo(raiz: string, caminho: string, maxBytes?: number): { real: string; relativo: string; root: string; tamanho: number };
export function gravarCorrigido(original: string, dados: Buffer | string, extNova?: string): string;

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  csize: number;
  usize: number;
  raw: Buffer;
}
export function crc32(buf: Uint8Array): number;
export function readZip(buf: Buffer): ZipEntry[];
export function openZip(buf: Buffer): { entries: ZipEntry[]; has(name: string): boolean; text(name: string): string | undefined };
export function writeZip(entries: ZipEntry[], replace?: Map<string, Buffer | string | null>): Buffer;
export function buildZip(files: Record<string, string | Buffer>): Buffer;

export function parseFormula(f: string): unknown;
export function avaliar(ast: unknown, sheet: string, get: (sheet: string, row: number, col: number) => unknown): number;
export function deslocar(f: string, dr: number, dc: number): string;

export function mod10(digits: string): number;
export function mod11Bancario(digits: string): number;
export function mod11Arrecadacao(digits: string): number;
export function datasDoFator(fator: number): string[];
export function vencimentoDoFator(fator: number, referenciaIso?: string): string | undefined;
export function linhaDasBarrasBancarias(barras: string): string;
export function formatarLinhaBancaria(linha: string): string;
export function verificarCodigo(digitos: string): any;

export function lerPdf(file: string, buf: Buffer, opts?: { pdftotext?: string }): Promise<{ paginas: string[]; extrator: string; aviso?: string }>;
export function extrairSimples(buf: Buffer): string[];

export function parseNumero(s: unknown, prefereBR?: boolean): number | undefined;
export function cpfValido(s: string): boolean;
export function cnpjValido(s: string): boolean;
export function detectar(text: string, onde?: Record<string, unknown>, limite?: number): any;
