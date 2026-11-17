// Checks on what the page sends to the main process (see main.js). The page is our own, but it is
// still the less trusted side: it shows file names and preset text that come from outside. These
// are plain functions with no Electron in them, so they can be tested under Node.

const path = require('node:path');
const { fileURLToPath } = require('node:url');

/** The largest STL (bytes) the page may send for one part. */
const MAX_STL_BYTES = 512 * 1024 * 1024;
/** The most parts one request may contain. */
const MAX_PARTS = 256;

/**
 * PrusaSlicer settings that make it run another program. The app never sets them, and a request
 * that does is refused: slicing must not be a way to start a program of the request's choosing.
 */
const FORBIDDEN_KEYS = new Set(['post_process']);

/**
 * Checks settings text from the page: `key = value` lines and nothing else, none of them one
 * that runs a program.
 *
 * @param {unknown} ini The settings text.
 * @param {number} maxLength The most characters it may have.
 * @param {string} what What to call it in an error message.
 * @throws {Error} If the text is not acceptable.
 */
function validateIni(ini, maxLength, what) {
    if (typeof ini !== 'string' || ini.length > maxLength) {
        throw new Error(`The slicing request has no valid ${what}.`);
    }
    for (const line of ini.split('\n')) {
        if (line === '') continue;
        const match = /^([a-z0-9_]+) = ([^\r\n]*)$/.exec(line);
        if (!match) {
            throw new Error(`The slicing request has a ${what} line that is not "key = value": ${line.slice(0, 80)}`);
        }
        if (FORBIDDEN_KEYS.has(match[1]) && match[2].trim() !== '') {
            throw new Error(`The slicing request sets "${match[1]}" in its ${what}, which would run another program. It was refused.`);
        }
    }
}

/**
 * Checks a slicing request from the page.
 *
 * @param {unknown} request The request.
 * @throws {Error} If it is not a request PrusaSlicer may be run on.
 */
function validateRequest(request) {
    if (!request || typeof request !== 'object') {
        throw new Error('The slicing request is empty.');
    }
    const { parts, ini, profileIni } = request;
    validateIni(ini, 1024 * 1024, 'settings');
    if (profileIni !== undefined) {
        validateIni(profileIni, 4 * 1024 * 1024, 'profile settings');
    }
    if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PARTS) {
        throw new Error('The slicing request has no parts.');
    }
    for (const part of parts) {
        if (!(part && part.stl instanceof Uint8Array) || part.stl.byteLength < 84 || part.stl.byteLength > MAX_STL_BYTES) {
            throw new Error('A part in the slicing request is not a valid STL file.');
        }
    }
}

/**
 * Whether a URL is the app's own page: the given file, whatever query or fragment follows it.
 * Compared as file paths, so two spellings of the same file (the case of a Windows drive letter,
 * an escaped character) do not make the app refuse its own page.
 *
 * @param {string} url The URL.
 * @param {string} pageFile The path of the app's page.
 * @returns {boolean} True if the URL shows that file.
 */
function isPageUrl(url, pageFile) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'file:' || parsed.host !== '') return false;
        const file = path.normalize(fileURLToPath(parsed));
        const page = path.normalize(pageFile);
        return process.platform === 'win32' ? file.toLowerCase() === page.toLowerCase() : file === page;
    } catch {
        return false;
    }
}

module.exports = { isPageUrl, validateIni, validateRequest, FORBIDDEN_KEYS, MAX_PARTS, MAX_STL_BYTES };
