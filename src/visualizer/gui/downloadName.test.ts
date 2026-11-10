import { describe, expect, it } from 'vitest';
import { defaultDownloadName } from './downloadName';

describe('defaultDownloadName', () => {
  const when = new Date(2026, 10, 9, 14, 5, 7); // 9 Nov 2026, 14:05:07 local time

  it('stamps the name with the local date and time', () => {
    expect(defaultDownloadName('augprint-preset', 'txt', when)).toBe('augprint-preset_20261109-140507.txt');
  });

  it('accepts an extension with a leading dot', () => {
    expect(defaultDownloadName('toolpath', '.gcode', when)).toBe('toolpath_20261109-140507.gcode');
  });

  it('turns a model filename into a safe base name', () => {
    expect(defaultDownloadName('My Bottle (v2).STL', 'gcode', when)).toBe('My-Bottle-v2_20261109-140507.gcode');
  });

  it('falls back to a generic name when the base is empty', () => {
    expect(defaultDownloadName('  ', 'txt', when)).toBe('download_20261109-140507.txt');
  });

  it('gives different names for saves at different times', () => {
    const later = new Date(when.getTime() + 1000);
    expect(defaultDownloadName('a', 'txt', when)).not.toBe(defaultDownloadName('a', 'txt', later));
  });
});
