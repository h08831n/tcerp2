import { calcBackoffDelay } from './queue.handlers';

describe('calcBackoffDelay', () => {
  it('starts at 60 seconds for the first failure', () => {
    expect(calcBackoffDelay(1)).toBe(60);
  });

  it('grows exponentially ×4', () => {
    expect(calcBackoffDelay(2)).toBe(240);
    expect(calcBackoffDelay(3)).toBe(960);
    expect(calcBackoffDelay(4)).toBe(3840);
    expect(calcBackoffDelay(5)).toBe(15360);
  });

  it('caps at 6 hours (21600 s)', () => {
    expect(calcBackoffDelay(6)).toBe(21600);
    expect(calcBackoffDelay(7)).toBe(21600);
    expect(calcBackoffDelay(50)).toBe(21600);
  });

  it('treats non-positive attempts as the first failure', () => {
    expect(calcBackoffDelay(0)).toBe(60);
    expect(calcBackoffDelay(-3)).toBe(60);
  });
});
