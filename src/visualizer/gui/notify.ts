/**
 * User-facing feedback: short toast messages and a "busy" overlay for long, blocking work.
 *
 * Everything here is a no-op outside a browser, so toolpath and slicer code can call it
 * freely and still be unit-tested under Node.
 */

export type NotifyKind = 'info' | 'success' | 'warning' | 'error';

/** How long a toast stays up, per kind. Errors linger so they can actually be read. */
const TOAST_DURATION_MS: Record<NotifyKind, number> = {
  info: 4000,
  success: 4000,
  warning: 7000,
  error: 10000,
};

const hasDom = typeof document !== 'undefined';

/** If no frame has been painted after this long (background tab), start the busy work anyway. */
const BUSY_START_FALLBACK_MS = 250;

function getToastContainer(): HTMLElement {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    // Polite live region so screen readers announce messages without stealing focus.
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }
  return container;
}

/**
 * Shows a short message to the user. Click a toast to dismiss it early.
 *
 * @param message The text to show.
 * @param kind Controls the colour and how long the toast stays up.
 */
export function notify(message: string, kind: NotifyKind = 'info'): void {
  if (!hasDom) {
    return;
  }

  const toast = document.createElement('div');
  toast.className = `toast-message toast-${kind}`;
  toast.textContent = message;

  const dismiss = () => toast.remove();
  toast.addEventListener('click', dismiss);
  setTimeout(dismiss, TOAST_DURATION_MS[kind]);

  getToastContainer().appendChild(toast);
}

/**
 * The labels of the work running behind the busy overlay, oldest first. More than one piece can
 * run at a time: a toolpath refresh that was waiting starts while a slice waits for PrusaSlicer.
 */
const busyWork: string[] = [];

/**
 * Whether work is running behind the busy overlay right now. The overlay keeps the pointer off
 * the page; whatever else can change the plate (a keyboard shortcut) has to ask.
 *
 * @returns True while the overlay is shown.
 */
export function isBusy(): boolean {
  return busyWork.length > 0;
}

/**
 * Notes that a piece of work started or ended, and shows the overlay for as long as any is
 * running, with the label of the one that started last.
 *
 * @param label What the user is waiting for.
 * @param running True when the work starts, false when it ends.
 */
function setBusy(label: string, running: boolean): void {
  if (running) {
    busyWork.push(label);
  } else {
    const index = busyWork.lastIndexOf(label);
    if (index >= 0) busyWork.splice(index, 1);
  }
  const shown = busyWork.length ? busyWork[busyWork.length - 1] : null;
  let overlay = document.getElementById('busyOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'busyOverlay';
    overlay.setAttribute('role', 'alert');
    overlay.setAttribute('aria-busy', 'true');
    document.body.appendChild(overlay);
  }
  overlay.textContent = shown ?? '';
  overlay.style.display = shown === null ? 'none' : 'flex';
}

/**
 * Runs blocking work behind a "busy" overlay.
 *
 * Slicing and toolpath generation run synchronously on the main thread, so the overlay
 * has to be painted *before* the work starts — hence the two animation frames. Errors are
 * reported as a toast and re-thrown so callers can still react to them.
 *
 * `work` may also return a promise (e.g. when it waits for PrusaSlicer); the overlay then stays
 * up until the promise settles, and a rejection is reported the same way as a thrown error.
 *
 * @param label What the user is waiting for, e.g. "Slicing…".
 * @param work The blocking function to run.
 * @returns Whatever `work` returns (or resolves to).
 */
export function withBusy<T>(label: string, work: () => T | Promise<T>): Promise<T> {
  if (!hasDom) {
    return Promise.resolve().then(work);
  }

  return new Promise<T>((resolve, reject) => {
    setBusy(label, true);

    let started = false;
    const fail = (error: unknown) => {
      notify(error instanceof Error ? error.message : String(error), 'error');
      reject(error);
    };
    const run = () => {
      if (started) {
        return;
      }
      started = true;
      let result: T | Promise<T>;
      try {
        result = work();
      } catch (error) {
        setBusy(label, false);
        fail(error);
        return;
      }
      Promise.resolve(result).then(
        value => { setBusy(label, false); resolve(value); },
        error => { setBusy(label, false); fail(error); },
      );
    };

    requestAnimationFrame(() => requestAnimationFrame(run));
    // Animation frames stop while the tab is in the background; don't let the work wait for them.
    setTimeout(run, BUSY_START_FALLBACK_MS);
  });
}
