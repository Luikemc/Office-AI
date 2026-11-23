import { describe, expect, it } from 'vitest';
import { chromeEnv, freeDisplay } from './display';

describe('tela virtual', () => {
  it('escolhe o primeiro display livre', () => {
    expect(freeDisplay((n) => n < 42, 40, 45)).toBe(42);
    expect(freeDisplay(() => true, 40, 42)).toBeUndefined();
  });

  it('aponta o Chrome para o display virtual e tira o Wayland', () => {
    const env = chromeEnv(':47', { PATH: '/bin', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' });
    expect(env.DISPLAY).toBe(':47');
    expect(env.PATH).toBe('/bin');
    expect(env.WAYLAND_DISPLAY).toBeUndefined();
  });
});
