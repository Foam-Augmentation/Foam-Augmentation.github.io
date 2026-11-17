import { describe, expect, it } from 'vitest';
import { isTyping, takesEscape } from './keyTarget';

/** A stand-in for an element: `closest` finds the control it is (or is inside), if any. */
function element(control?: { tagName: string, type?: string }): EventTarget {
    return { closest: () => control ?? null } as unknown as EventTarget;
}

describe('isTyping', () => {
    it('is true on any control of the page and false elsewhere', () => {
        expect(isTyping(element({ tagName: 'INPUT', type: 'text' }))).toBe(true);
        expect(isTyping(element({ tagName: 'INPUT', type: 'checkbox' }))).toBe(true);
        expect(isTyping(element({ tagName: 'SELECT' }))).toBe(true);
        expect(isTyping(element())).toBe(false);
        expect(isTyping(null)).toBe(false);
    });
});

describe('takesEscape', () => {
    it('leaves Esc to a field that is typed into and to a dropdown', () => {
        expect(takesEscape(element({ tagName: 'INPUT', type: 'text' }))).toBe(true);
        expect(takesEscape(element({ tagName: 'INPUT', type: 'number' }))).toBe(true);
        expect(takesEscape(element({ tagName: 'TEXTAREA' }))).toBe(true);
        expect(takesEscape(element({ tagName: 'SELECT' }))).toBe(true);
    });

    it('does not let a checkbox or slider that kept the focus swallow Esc', () => {
        expect(takesEscape(element({ tagName: 'INPUT', type: 'checkbox' }))).toBe(false);
        expect(takesEscape(element({ tagName: 'INPUT', type: 'range' }))).toBe(false);
        expect(takesEscape(element())).toBe(false);
        expect(takesEscape(null)).toBe(false);
    });
});
