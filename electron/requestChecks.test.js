import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import checks from './requestChecks.js';

const { isPageUrl, validateIni, validateRequest } = checks;

/** The smallest thing that passes for a binary STL: an 80-byte header and a triangle count. */
const stl = () => new Uint8Array(84);

describe('validateIni', () => {
    it('accepts key = value lines, empty values and empty lines', () => {
        expect(() => validateIni('layer_height = 0.2\nstart_gcode = \n\nfill_density = 20%\n', 1000, 'settings')).not.toThrow();
    });

    it('refuses anything that is not a key = value line', () => {
        expect(() => validateIni('[print:evil]\n', 1000, 'settings')).toThrow(/not "key = value"/);
        expect(() => validateIni('layer_height=0.2', 1000, 'settings')).toThrow(/not "key = value"/);
        expect(() => validateIni('a = 1\r\nb = 2', 1000, 'settings')).toThrow(/not "key = value"/);
    });

    it('refuses text that is too long or not text', () => {
        expect(() => validateIni('a = 1', 3, 'settings')).toThrow(/no valid settings/);
        expect(() => validateIni(undefined, 1000, 'settings')).toThrow(/no valid settings/);
    });

    it('refuses a post-processing script, which PrusaSlicer would run', () => {
        expect(() => validateIni('layer_height = 0.2\npost_process = calc.exe\n', 1000, 'settings')).toThrow(/would run another program/);
        // An empty one is how the app, and Prusa's own profiles, say "none".
        expect(() => validateIni('post_process = \n', 1000, 'settings')).not.toThrow();
        expect(() => validateIni('post_process =   \n', 1000, 'settings')).not.toThrow();
    });
});

describe('validateRequest', () => {
    it('accepts parts with settings, with or without profile settings', () => {
        expect(() => validateRequest({ parts: [{ name: 'a', stl: stl() }], ini: 'a = 1\n' })).not.toThrow();
        expect(() => validateRequest({ parts: [{ name: 'a', stl: stl() }], ini: 'a = 1\n', profileIni: 'b = 2\n' })).not.toThrow();
    });

    it('checks the profile settings like the settings', () => {
        const request = { parts: [{ name: 'a', stl: stl() }], ini: 'a = 1\n', profileIni: 'post_process = evil\n' };
        expect(() => validateRequest(request)).toThrow(/would run another program/);
    });

    it('refuses a request without parts, or with something that is not an STL', () => {
        expect(() => validateRequest(null)).toThrow(/empty/);
        expect(() => validateRequest({ parts: [], ini: 'a = 1\n' })).toThrow(/no parts/);
        expect(() => validateRequest({ parts: [{ name: 'a', stl: new Uint8Array(10) }], ini: 'a = 1\n' })).toThrow(/not a valid STL/);
        expect(() => validateRequest({ parts: [{ name: 'a', stl: 'solid' }], ini: 'a = 1\n' })).toThrow(/not a valid STL/);
    });
});

describe('isPageUrl', () => {
    const page = path.resolve('dist', 'index.html');
    const url = pathToFileURL(page).href;

    it('accepts the page itself, with or without a query or fragment', () => {
        expect(isPageUrl(url, page)).toBe(true);
        expect(isPageUrl(`${url}?x=1#top`, page)).toBe(true);
    });

    it('refuses another local file, a web page and nonsense', () => {
        expect(isPageUrl(pathToFileURL(path.resolve('dist', 'other.html')).href, page)).toBe(false);
        expect(isPageUrl('https://example.com/dist/index.html', page)).toBe(false);
        expect(isPageUrl('file://server/share/dist/index.html', page)).toBe(false);
        expect(isPageUrl('not a url', page)).toBe(false);
    });
});
