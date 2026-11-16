/**
 * Deterministic clock + storage for driving the live engine outside a browser.
 * The engine only uses requestAnimationFrame, performance.now and localStorage,
 * so replacing those three is enough to run it at controlled speed.
 */
const store = new Map<string, string>();

export function installHarness() {
  const g = globalThis as any;
  let clockNow = 0;
  let nextHandle = 1;
  let callbacks = new Map<number, (t: number) => void>();
  const realNow = performance.now.bind(performance);

  const raf = (cb: (t: number) => void) => {
    const id = nextHandle++;
    callbacks.set(id, cb);
    return id;
  };
  const caf = (id: number) => callbacks.delete(id);

  g.requestAnimationFrame = raf;
  g.cancelAnimationFrame = caf;
  performance.now = () => clockNow;
  g.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };

  return {
    async advance(seconds: number, step = 1 / 60) {
      const end = clockNow + seconds * 1000;
      if (seconds === 0) return;
      while (clockNow < end) {
        clockNow += step * 1000;
        const pending = [...callbacks.values()];
        callbacks.clear();
        for (const cb of pending) cb(clockNow);
        // Let the engine's async slices and promise chains progress.
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    },
    frames(count: number, step = 1 / 60) {
      return this.advance(count * step, step);
    },
    get now() {
      return clockNow;
    },
    resetStorage() {
      store.clear();
    },
  };
}
