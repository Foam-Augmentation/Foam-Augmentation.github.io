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

function setBusy(label: string | null): void {
  let overlay = document.getElementById('busyOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'busyOverlay';
    overlay.setAttribute('role', 'alert');
    overlay.setAttribute('aria-busy', 'true');
    document.body.appendChild(overlay);
  }
  overlay.textContent = label ?? '';
  overlay.style.display = label === null ? 'none' : 'flex';
}

/**
 * Runs blocking work behind a "busy" overlay.
 *
 * Slicing and toolpath generation run synchronously on the main thread, so the overlay
 * has to be painted *before* the work starts — hence the two animation frames. Errors are
 * reported as a toast and re-thrown so callers can still react to them.
 *
 * @param label What the user is waiting for, e.g. "Slicing…".
 * @param work The blocking function to run.
 * @returns Whatever `work` returns.
 */
export function withBusy<T>(label: string, work: () => T): Promise<T> {
  if (!hasDom) {
    return Promise.resolve().then(work);
  }

  return new Promise<T>((resolve, reject) => {
    setBusy(label);

    let started = false;
    const run = () => {
      if (started) {
        return;
      }
      started = true;
      try {
        resolve(work());
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), 'error');
        reject(error);
      } finally {
        setBusy(null);
      }
    };

    requestAnimationFrame(() => requestAnimationFrame(run));
    // Animation frames stop while the tab is in the background; don't let the work wait for them.
    setTimeout(run, BUSY_START_FALLBACK_MS);
  });
}
