/**
 * Saves the provided G-code data to a file by triggering a download.
 *
 * @param {string} gcode - The G-code data to save.
 * @param {string} filename - The desired filename (without extension).
 */
export function saveGcodeToFile(gcode: string, filename: string): void {
    // Create a Blob object containing the G-code data.
    const blob = new Blob([gcode], { type: 'text/plain' });
  
    // Create a hidden link element and set its href to the Blob URL.
    const link = document.createElement('a');
    link.style.display = 'none';
    link.href = URL.createObjectURL(blob);
    link.download = filename + '.gcode'; // Set the file name for download.
  
    // Append the link to the document, trigger a click, then remove the link.
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  
    // Clean up the Blob URL.
    URL.revokeObjectURL(link.href);
  }
  