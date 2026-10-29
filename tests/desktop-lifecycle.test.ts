import { beforeEach, describe, expect, it, vi } from 'vitest';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(finish => { resolve = finish; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetModules();
  delete window.yueyeDesktop;
  document.body.inert = false;
});

async function setup() {
  let prepareClose!: () => Promise<void>;
  const onPrepareClose = vi.fn((callback: () => Promise<void>) => {
    prepareClose = callback;
    return () => {};
  });
  window.yueyeDesktop = { onPrepareClose };
  const lifecycle = await import('../src/services/desktop');
  lifecycle.initializeDesktopLifecycle();
  return { ...lifecycle, onPrepareClose, prepareClose: () => prepareClose() };
}

describe('desktop close lifecycle', () => {
  it('leaves a normal browser unchanged and installs just one desktop callback', async () => {
    const lifecycle = await import('../src/services/desktop');
    lifecycle.initializeDesktopLifecycle();
    expect(document.body.inert).toBe(false);
    const onPrepareClose = vi.fn(() => () => {});
    window.yueyeDesktop = { onPrepareClose };
    lifecycle.initializeDesktopLifecycle();
    lifecycle.initializeDesktopLifecycle();
    expect(onPrepareClose).toHaveBeenCalledTimes(1);
  });

  it('waits for every save and prevents interactions during preparation', async () => {
    const lifecycle = await setup();
    const first = deferred(), second = deferred();
    lifecycle.registerBeforeClose(() => first.promise);
    lifecycle.registerBeforeClose(() => second.promise);
    let done = false;
    const preparing = lifecycle.prepareClose().then(() => { done = true; });
    expect(document.body.inert).toBe(true);
    first.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    second.resolve();
    await preparing;
    expect(done).toBe(true);
    expect(document.body.inert).toBe(false);
  });

  it('includes a reader registered while an import or open is finishing', async () => {
    const lifecycle = await setup();
    const opening = deferred(), readerSave = deferred();
    const saveReader = vi.fn(() => readerSave.promise);
    lifecycle.registerBeforeClose(() => opening.promise);
    let done = false;
    const preparing = lifecycle.prepareClose().then(() => { done = true; });
    lifecycle.registerBeforeClose(saveReader);
    opening.resolve();
    await vi.waitFor(() => expect(saveReader).toHaveBeenCalledOnce());
    expect(done).toBe(false);
    readerSave.resolve();
    await preparing;
  });

  it('waits for pending writes even after another handler fails, then permits retry', async () => {
    const lifecycle = await setup();
    const pendingWrite = deferred();
    let failed = false;
    const unregister = lifecycle.registerBeforeClose(async () => { throw new Error('disk full'); });
    lifecycle.registerBeforeClose(() => pendingWrite.promise);
    const preparing = lifecycle.prepareClose().catch(error => {
      failed = true;
      expect(error).toBeInstanceOf(AggregateError);
    });
    await Promise.resolve();
    expect(failed).toBe(false);
    pendingWrite.resolve();
    await preparing;
    expect(failed).toBe(true);
    expect(document.body.inert).toBe(false);
    unregister();
    await expect(lifecycle.prepareClose()).resolves.toBeUndefined();
  });

  it('shares an in-flight close and skips unregistered handlers', async () => {
    const lifecycle = await setup();
    const pendingWrite = deferred();
    const save = vi.fn(() => pendingWrite.promise);
    const removed = vi.fn(async () => {});
    lifecycle.registerBeforeClose(save);
    lifecycle.registerBeforeClose(removed)();
    const first = lifecycle.prepareClose(), second = lifecycle.prepareClose();
    expect(first).toBe(second);
    expect(save).toHaveBeenCalledOnce();
    expect(removed).not.toHaveBeenCalled();
    pendingWrite.resolve();
    await first;
  });
});
