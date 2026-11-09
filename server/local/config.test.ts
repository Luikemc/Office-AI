import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, InvalidLocalConfig, localUrl, LocalConfigStore, mergeLocalConfig } from './config';
import { applyChunk, toolArgs, type ChatResult } from './ollama';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'local-config-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('configuração da IA local', () => {
  it('aceita só endereços deste computador', () => {
    expect(localUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
    expect(localUrl('http://localhost:11434/')).toBe('http://localhost:11434');
    expect(localUrl('http://[::1]:11434')).toBe('http://[::1]:11434');
    expect(localUrl('http://192.168.0.10:11434')).toBeUndefined();
    expect(localUrl('http://ollama.example.com')).toBeUndefined();
    expect(localUrl('http://user:x@127.0.0.1:11434')).toBeUndefined();
    expect(localUrl('file:///etc/passwd')).toBeUndefined();
    expect(localUrl('http://127.0.0.1:11434/api')).toBeUndefined();
  });

  it('valida cada campo', () => {
    expect(mergeLocalConfig(DEFAULT_CONFIG, { modelo: 'qwen3:4b', contexto: 16384, pensar: true })).toEqual({ ...DEFAULT_CONFIG, modelo: 'qwen3:4b', contexto: 16384, pensar: true });
    expect(() => mergeLocalConfig(DEFAULT_CONFIG, { contexto: 100 })).toThrow(InvalidLocalConfig);
    expect(() => mergeLocalConfig(DEFAULT_CONFIG, { modelo: 'a b' })).toThrow(InvalidLocalConfig);
    expect(() => mergeLocalConfig(DEFAULT_CONFIG, { pensar: 'sim' })).toThrow(InvalidLocalConfig);
    expect(() => mergeLocalConfig(DEFAULT_CONFIG, { url: 'http://10.0.0.1:11434' })).toThrow(InvalidLocalConfig);
    expect(() => mergeLocalConfig(DEFAULT_CONFIG, [])).toThrow(InvalidLocalConfig);
  });

  it('grava e relê; arquivo inválido = padrão', () => {
    const path = join(dir, 'ia-local.json');
    const s = new LocalConfigStore(path);
    expect(s.get()).toEqual(DEFAULT_CONFIG);
    s.update({ modelo: 'llama3.2:3b' });
    expect(JSON.parse(readFileSync(path, 'utf8')).modelo).toBe('llama3.2:3b');
    expect(new LocalConfigStore(path).get().modelo).toBe('llama3.2:3b');
    writeFileSync(path, '{"contexto": 1}');
    expect(new LocalConfigStore(path).get()).toEqual(DEFAULT_CONFIG);
  });
});

describe('streaming do Ollama', () => {
  it('junta os pedaços, as ferramentas e os números do fim', () => {
    const out: ChatResult = { content: '', thinking: '', toolCalls: [], promptTokens: 0, outputTokens: 0 };
    applyChunk(out, { message: { role: 'assistant', content: 'Ol' } });
    applyChunk(out, { message: { role: 'assistant', content: 'á', thinking: 'hmm' } });
    applyChunk(out, { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'ler_arquivo', arguments: '{"caminho":"a.txt"}' } }] } });
    applyChunk(out, { done: true, prompt_eval_count: 120, eval_count: 7, done_reason: 'stop' });
    expect(out).toEqual({ content: 'Olá', thinking: 'hmm', toolCalls: [{ function: { name: 'ler_arquivo', arguments: { caminho: 'a.txt' } } }], promptTokens: 120, outputTokens: 7, doneReason: 'stop' });
  });

  it('erro no meio do streaming lança', () => {
    const out: ChatResult = { content: '', thinking: '', toolCalls: [], promptTokens: 0, outputTokens: 0 };
    expect(() => applyChunk(out, { error: 'model requires more system memory' })).toThrow(/memory/);
  });

  it('argumentos estranhos viram objeto vazio', () => {
    expect(toolArgs('não é json')).toEqual({});
    expect(toolArgs([1])).toEqual({});
    expect(toolArgs({ a: 1 })).toEqual({ a: 1 });
  });
});
