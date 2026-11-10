/**
 * Saves the provided G-code data to a file by triggering a download.
 *
 * @param {string} gcode - The G-code data to save.
 * @param {string} filename - The desired filename, including the extension.
 */
export function saveGcodeToFile(gcode: string, filename: string): void {
    // Create a Blob object containing the G-code data.
    const blob = new Blob([gcode], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);

    // Create a hidden link element and set its href to the Blob URL.
    const link = document.createElement('a');
    link.style.display = 'none';
    link.href = url;
    link.download = filename; // Set the file name for download.

    // Append the link to the document, trigger a click, then remove the link.
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // Clean up the Blob URL, but only once the browser has had time to start the download:
    // revoking it straight away can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
