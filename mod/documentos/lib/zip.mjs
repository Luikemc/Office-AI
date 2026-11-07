// Leitor e gravador de zip mínimos (xlsx e docx são zip + XML). Só node:*.
// Leitura: diretório central (sem zip64), entradas guardadas (0) ou deflate (8).
// Gravação: as entradas não mexidas vão com os bytes comprimidos originais (mesmo método, mesmo CRC); as
// trocadas vão em deflate com CRC novo.
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** Limite do conteúdo descomprimido de uma entrada (zip-bomb). */
const MAX_ENTRY = 200 * 1024 * 1024;

let crcTable;
export function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Lê o diretório central. Cada entrada: {name, method, flags, time, date, crc, csize, usize, extAttr, raw}
 * (raw = bytes comprimidos, como estão no arquivo).
 */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('não é um arquivo zip (xlsx/docx) válido');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('zip64 não suportado');
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL) throw new Error('diretório central do zip corrompido');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12);
    const date = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const extAttr = buf.readUInt32LE(p + 38);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(offset) !== LOCAL) throw new Error(`cabeçalho local do zip corrompido (${name})`);
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    entries.push({ name, method, flags, time, date, crc, csize, usize, extAttr, raw: buf.subarray(start, start + csize) });
  }
  return entries;
}

/** Conteúdo descomprimido de uma entrada. */
export function entryData(e) {
  if (e.usize > MAX_ENTRY) throw new Error(`parte grande demais no zip: ${e.name}`);
  if (e.method === 0) return Buffer.from(e.raw);
  if (e.method === 8) return inflateRawSync(e.raw, { maxOutputLength: MAX_ENTRY });
  throw new Error(`compressão ${e.method} não suportada (${e.name})`);
}

/** Mapa nome → entrada, com leitura de texto. */
export function openZip(buf) {
  const entries = readZip(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));
  return {
    entries,
    has: (n) => byName.has(n),
    text: (n) => {
      const e = byName.get(n);
      return e ? entryData(e).toString('utf8') : undefined;
    },
  };
}

/**
 * Grava um zip novo: `entries` na ordem original; `replace` = Map nome → Buffer|string (conteúdo novo) ou
 * null (tira a entrada). Os demais vão byte a byte.
 */
export function writeZip(entries, replace = new Map()) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    if (replace.has(e.name) && replace.get(e.name) === null) continue;
    let { method, crc, csize, usize, raw } = e;
    let flags = e.flags & ~0x8; // tamanhos vão no cabeçalho local: sem descritor de dados
    if (replace.has(e.name)) {
      const data = Buffer.isBuffer(replace.get(e.name)) ? replace.get(e.name) : Buffer.from(replace.get(e.name), 'utf8');
      raw = deflateRawSync(data);
      method = 8;
      crc = crc32(data);
      csize = raw.length;
      usize = data.length;
    }
    const name = Buffer.from(e.name, flags & 0x800 ? 'utf8' : 'latin1');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(e.time, 10);
    local.writeUInt16LE(e.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(csize, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(CENTRAL, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt16LE(e.time, 12);
    c.writeUInt16LE(e.date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(csize, 20);
    c.writeUInt32LE(usize, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(e.extAttr >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    parts.push(local, name, raw);
    offset += 30 + name.length + raw.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  const n = central.length / 2;
  end.writeUInt16LE(n, 8);
  end.writeUInt16LE(n, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

/** Para testes e geração: zip a partir de {nome: conteúdo}. */
export function buildZip(files) {
  const entries = Object.keys(files).map((name) => ({ name, method: 0, flags: 0x800, time: 0, date: 33, crc: 0, csize: 0, usize: 0, extAttr: 0, raw: Buffer.alloc(0) }));
  return writeZip(entries, new Map(Object.entries(files)));
}
