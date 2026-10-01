// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { trackState } from '../src/lib/mwan';

// mwan3track pinga i tracking IP in ordine e si ferma appena `reliability` ne
// hanno risposto: gli altri escono come "skipped". Mostrarli come
// irraggiungibili faceva sembrare guasto il secondo IP, qualunque fosse.
describe('trackState', () => {
  it('keeps the states mwan3track reports', () => {
    expect(trackState('up')).toBe('up');
    expect(trackState('down')).toBe('down');
    expect(trackState('skipped')).toBe('skipped');
  });

  it('does not turn anything else into "down"', () => {
    expect(trackState('unknown')).toBe('unknown');
    expect(trackState('')).toBe('unknown');
    expect(trackState('whatever')).toBe('unknown');
  });
});
