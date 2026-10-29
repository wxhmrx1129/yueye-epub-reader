type BeforeCloseHandler = () => Promise<unknown>;

const beforeCloseHandlers = new Set<BeforeCloseHandler>();
let initialized = false;
let preparingClose: Promise<void> | undefined;

/** Register work that must finish before the desktop window is destroyed. */
export function registerBeforeClose(handler: BeforeCloseHandler): () => void {
  beforeCloseHandlers.add(handler);
  return () => { beforeCloseHandlers.delete(handler); };
}

/** Browser builds have no bridge and keep their existing lifecycle. */
export function initializeDesktopLifecycle(): void {
  if (initialized || !window.yueyeDesktop) return;
  initialized = true;
  window.yueyeDesktop.onPrepareClose(() => {
    if (preparingClose) return preparingClose;
    const wasInert = document.body.inert;
    document.body.inert = true;
    preparingClose = (async () => {
      const completed = new Set<BeforeCloseHandler>();
      const errors: unknown[] = [];
      // Opening a book can mount a Reader while another handler is awaiting I/O.
      // Include those new handlers before reporting that it is safe to close.
      while (true) {
        const pending = [...beforeCloseHandlers].filter(handler => !completed.has(handler));
        if (!pending.length) break;
        pending.forEach(handler => completed.add(handler));
        const results = await Promise.allSettled(pending.map(async handler => handler()));
        for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
      }
      if (errors.length) throw new AggregateError(errors, '关闭前保存未完成，请返回应用检查后重试。');
    })().finally(() => {
      document.body.inert = wasInert;
      preparingClose = undefined;
    });
    return preparingClose;
  });
}
