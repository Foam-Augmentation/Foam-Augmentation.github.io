// src/visualizer/interactions/pointerToNdc.ts

/**
 * Converts a pointer position to normalized device coordinates (x and y from -1 to 1, y up)
 * relative to the element it is over.
 *
 * Uses the element's on-screen rectangle rather than the window size, so the result stays
 * correct after the window is resized or if the canvas does not fill the window.
 *
 * @param event - Anything with `clientX` / `clientY`, e.g. a PointerEvent.
 * @param element - The element the coordinates are relative to (the renderer's canvas).
 * @returns The position in normalized device coordinates.
 */
export function pointerToNdc(
    event: { clientX: number; clientY: number },
    element: { getBoundingClientRect(): { left: number; top: number; width: number; height: number } }
): { x: number; y: number } {
    const rect = element.getBoundingClientRect();
    // Guard against a zero-sized canvas (e.g. a minimised window) producing NaN.
    const width = rect.width || 1;
    const height = rect.height || 1;
    return {
        x: ((event.clientX - rect.left) / width) * 2 - 1,
        y: -(((event.clientY - rect.top) / height) * 2 - 1),
    };
}
