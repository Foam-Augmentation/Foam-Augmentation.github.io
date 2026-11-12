import { describe, expect, it } from 'vitest';
import { addProgressLines, estimateGcode, TOOL_CHANGE_SECONDS } from './printEstimate';

const seconds = (gcode: string) => estimateGcode(gcode).estimate.seconds;

/** Time (s) of one straight move from standing still to standing still. */
function trapezoid(length: number, speed: number, accel: number, startSpeed: number): number {
    const ramp = (speed * speed - startSpeed * startSpeed) / (2 * accel);
    return 2 * (speed - startSpeed) / accel + (length - 2 * ramp) / speed;
}

describe('estimateGcode: motion', () => {
    it('times a straight travel with acceleration, starting and stopping at the jerk speed', () => {
        // 100 mm at 100 mm/s, travel acceleration 5000 mm/s², X jerk 8 mm/s.
        expect(seconds('G90\nG0 X100 F6000\n')).toBeCloseTo(trapezoid(100, 100, 5000, 8), 6);
    });

    it('does not slow down between moves in a straight line', () => {
        const pieces = Array.from({ length: 100 }, (_, i) => `G0 X${i + 1} F6000`).join('\n');
        expect(seconds(pieces)).toBeCloseTo(seconds('G0 X100 F6000'), 6);
    });

    it('slows down for a corner', () => {
        const corner = seconds('G0 X50 F6000\nG0 X50 Y50');
        expect(corner).toBeGreaterThan(seconds('G0 X100 F6000') + 0.01);
    });

    it('follows the limits the file sets', () => {
        // M203 caps X at 50 mm/s: 100 mm takes about 2 s.
        expect(seconds('M203 X50\nG0 X100 F6000')).toBeCloseTo(trapezoid(100, 50, 5000, 8), 6);
        // M204 T sets the travel acceleration.
        expect(seconds('M204 T500\nG0 X100 F6000')).toBeCloseTo(trapezoid(100, 100, 500, 8), 6);
        // M205 X sets the jerk, so the move starts faster.
        expect(seconds('M205 X20\nG0 X100 F6000')).toBeCloseTo(trapezoid(100, 100, 5000, 20), 6);
    });

    it('uses the print acceleration for extruding moves', () => {
        expect(seconds('M83\nM204 P1000 T5000\nG1 X100 E5 F6000')).toBeGreaterThan(seconds('M204 P1000 T5000\nG0 X100 F6000'));
    });

    it('understands relative positioning', () => {
        expect(seconds('G91\nG0 X50 F6000\nG0 X50\nG90')).toBeCloseTo(seconds('G0 X100 F6000'), 6);
    });

    it('adds dwells and tool changes, but no time for heating or pauses', () => {
        expect(seconds('G4 P500')).toBeCloseTo(0.5, 9);
        expect(seconds('G4 S2')).toBeCloseTo(2, 9);
        expect(seconds('M109 S230\nM190 S60\nM600\nM0')).toBe(0);
        const tools = estimateGcode('T0 S1 L0 D0\nT1 S1 L0 D0\nT1 S1 L0 D0\nT0 S1 L0 D0');
        expect(tools.estimate.toolChanges).toBe(2);
        expect(tools.estimate.seconds).toBeCloseTo(2 * TOOL_CHANGE_SECONDS, 9);
    });
});

describe('estimateGcode: filament and stops', () => {
    it('adds up relative extrusion per tool, net of retractions', () => {
        const { estimate } = estimateGcode([
            'M83',
            'G1 X10 E2 F1200',
            'G1 E-0.8 F2100',
            'G1 E0.8',
            'T1 S1 L0 D0',
            'G1 X20 E3',
        ].join('\n'));
        expect(estimate.filament[0]).toBeCloseTo(2, 9);
        expect(estimate.filament[1]).toBeCloseTo(3, 9);
    });

    it('reads absolute extrusion, with G92 resets', () => {
        const { estimate } = estimateGcode('M82\nG1 X10 E2 F1200\nG1 X20 E5\nG92 E0\nG1 X30 E1');
        expect(estimate.filament[0]).toBeCloseTo(6, 9);
    });

    it('follows the material named at a filament change on a single tool head', () => {
        const { estimate } = estimateGcode([
            'M83',
            'G1 X10 E2 F1200',
            "; Change filament to extruder 1's material",
            'M600 ; pause and prompt the user to swap filament',
            'G1 X20 E4',
        ].join('\n'));
        expect(estimate.filament).toEqual([2, 4]);
        expect(estimate.stops).toBe(1);
    });

    it('records when each stop for the user comes', () => {
        const timed = estimateGcode('G0 X100 F6000\nM601\nG0 X0\nM600\nG0 X100');
        const oneMove = seconds('G0 X100 F6000');
        expect(timed.stopTimes).toHaveLength(2);
        expect(timed.stopTimes[0]).toBeCloseTo(oneMove, 6);
        expect(timed.stopTimes[1]).toBeCloseTo(2 * oneMove, 6);
    });
});

describe('addProgressLines', () => {
    // 30 one-minute moves: 600 mm each at F600 (10 mm/s).
    const minuteMoves = Array.from({ length: 30 }, (_, i) => `G1 X${(i % 2 === 0 ? 600 : 0)} F600`).join('\n');

    it('starts with 0 % and the whole time, and only ever counts up', () => {
        const { gcode, estimate } = addProgressLines(minuteMoves);
        const lines = gcode.split('\n');
        expect(lines[0]).toBe(`M73 P0 R${Math.round(estimate.seconds / 60)}`);
        const progress = lines.filter(l => l.startsWith('M73 P')).map(l => Number(/P(\d+)/.exec(l)![1]));
        expect(progress[progress.length - 1]).toBe(100);
        progress.forEach((value, i) => { if (i) expect(value).toBeGreaterThanOrEqual(progress[i - 1]); });
        // About one line per percent or minute, not one per move.
        expect(progress.length).toBeLessThanOrEqual(31);
    });

    it('keeps every line of the file, in order', () => {
        const { gcode } = addProgressLines(minuteMoves);
        expect(gcode.split('\n').filter(l => !l.startsWith('M73')).join('\n')).toBe(minuteMoves);
    });

    it('counts down to the next stop for the user', () => {
        const withPause = `${minuteMoves}\nM601\n${minuteMoves}`;
        const lines = addProgressLines(withPause).gcode.split('\n');
        const pause = lines.indexOf('M601');
        const countdown = lines.slice(0, pause).filter(l => l.startsWith('M73 C')).map(l => Number(l.slice('M73 C'.length)));
        expect(countdown[0]).toBe(30);
        countdown.forEach((value, i) => { if (i) expect(value).toBeLessThan(countdown[i - 1]); });
        // Nothing to count down to after the last stop.
        expect(lines.slice(pause).some(l => l.startsWith('M73 C'))).toBe(false);
    });

    it('says 100 % straight away for a file that takes no time', () => {
        expect(addProgressLines('M104 S0').gcode.split('\n')[0]).toBe('M73 P100 R0');
    });
});
