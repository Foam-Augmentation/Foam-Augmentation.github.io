// ---------------------------------------------------------------------------------------------
// How long a G-code file takes to print and how much filament it feeds, worked out from the file
// itself, and the M73 lines that let the printer show its progress and the time left.
//
// The motion model is the usual one for Marlin-style firmware (Prusa's included): every move
// speeds up and slows down at the acceleration the file sets (M201/M204), never goes faster than
// the feed rate or the axis limits (M203), and passes from one move into the next at a speed the
// classic jerk limits (M205) allow. Speeds are planned over each run of moves between commands
// that stop the printer (waits, pauses, tool changes, homing).
//
// Not counted: heating (M109/M190), homing and bed probing (G28/G29), and the time the printer
// waits for the user at a pause (M0/M1/M600/M601). Each tool change adds a fixed allowance.
//
// No DOM here, so it can be unit-tested under Node.
// ---------------------------------------------------------------------------------------------

/** Seconds allowed for each change of tool (T<n>): parking one tool and picking up another. */
export const TOOL_CHANGE_SECONDS = 20;

/** Axis order of the per-axis limits: X, Y, Z, E. */
type Axes = [number, number, number, number];

/** The motion limits the file sets. Until it sets them, the Prusa XL's own (PrusaSlicer's XL profile). */
interface Limits {
    /** Max feed rate per axis (mm/s), M203. */
    maxFeed: Axes;
    /** Max acceleration per axis (mm/s²), M201. */
    maxAccel: Axes;
    /** Acceleration of extruding moves (mm/s²), M204 P. */
    printAccel: number;
    /** Acceleration of moves that only retract or unretract (mm/s²), M204 R. */
    retractAccel: number;
    /** Acceleration of travel moves (mm/s²), M204 T. */
    travelAccel: number;
    /** Classic jerk per axis (mm/s), M205: the speed change allowed without slowing down. */
    jerk: Axes;
}

function defaultLimits(): Limits {
    return {
        maxFeed: [400, 400, 12, 100],
        maxAccel: [7000, 7000, 200, 2500],
        printAccel: 4000,
        retractAccel: 1200,
        travelAccel: 5000,
        jerk: [8, 8, 2, 10],
    };
}

/** What the estimate found. */
export interface PrintEstimate {
    /** Seconds the moves, dwells and tool changes take. See the notes at the top of the file. */
    seconds: number;
    /** Filament (mm) each tool feeds, net of retractions, by tool number. */
    filament: number[];
    /** How many times the print stops for the user (M0/M1/M600/M601). */
    stops: number;
    /** How many times the tool changes. */
    toolChanges: number;
}

/** An estimate together with when each line finishes, for placing M73 lines. */
export interface TimedGcode {
    estimate: PrintEstimate;
    /** Seconds from the start of the file to the end of each line. */
    lineEnd: Float64Array;
    /** Seconds from the start of the file to each stop for the user, in order. */
    stopTimes: number[];
}

/** One move, ready to be planned. */
interface Block {
    line: number;
    length: number;
    /** Cruise speed (mm/s): the feed rate, cut to the axis limits. */
    speed: number;
    accel: number;
    /** Direction, per axis, as a fraction of the length. */
    unit: Axes;
    /** The fastest it can start from standing still (mm/s), per the jerk limits. */
    safeSpeed: number;
}

/** Reads the words of a G-code command (`X12.5` -> X: 12.5). The command itself is skipped. */
function readWords(parts: string[]): Map<string, number> {
    const words = new Map<string, number>();
    for (let i = 1; i < parts.length; i++) {
        const word = parts[i];
        const value = Number(word.slice(1));
        if (word.length > 1 && Number.isFinite(value)) {
            words.set(word[0].toUpperCase(), value);
        }
    }
    return words;
}

/**
 * Time (s) to cover `length` starting at `entry` and ending at `exit`, cruising at most at
 * `speed`, speeding up and slowing down at `accel`.
 */
function trapezoidTime(length: number, entry: number, exit: number, speed: number, accel: number): number {
    if (length <= 0) return 0;
    if (!(accel > 0)) return length / speed;
    const accelDistance = (speed * speed - entry * entry) / (2 * accel);
    const decelDistance = (speed * speed - exit * exit) / (2 * accel);
    if (accelDistance + decelDistance <= length) {
        return (speed - entry) / accel + (speed - exit) / accel + (length - accelDistance - decelDistance) / speed;
    }
    // Never reaches cruise speed: speeds up to a peak, then slows down.
    const peak = Math.sqrt(Math.max(0, (2 * accel * length + entry * entry + exit * exit) / 2));
    return Math.max(0, (peak - entry) / accel) + Math.max(0, (peak - exit) / accel);
}

/**
 * Plans a run of moves that starts and ends standing still, and adds each move's time to the
 * time of its line.
 */
function planRun(blocks: Block[], jerk: Axes, lineTime: Float64Array): void {
    const n = blocks.length;
    if (!n) return;
    // junction[i] is the speed between block i - 1 and block i.
    const junction = new Float64Array(n + 1);
    junction[0] = blocks[0].safeSpeed;
    junction[n] = blocks[n - 1].safeSpeed;
    for (let i = 1; i < n; i++) {
        const previous = blocks[i - 1];
        const current = blocks[i];
        let limit = Math.min(previous.speed, current.speed);
        for (let axis = 0; axis < 4; axis++) {
            const change = Math.abs(current.unit[axis] - previous.unit[axis]);
            if (change > 1e-9) {
                limit = Math.min(limit, jerk[axis] / change);
            }
        }
        junction[i] = limit;
    }
    // A move can only end as fast as the next one can slow down from, and only start as fast as
    // the previous one could speed up to.
    for (let i = n - 1; i >= 0; i--) {
        const b = blocks[i];
        junction[i] = Math.min(junction[i], Math.sqrt(junction[i + 1] * junction[i + 1] + 2 * b.accel * b.length));
    }
    for (let i = 0; i < n; i++) {
        const b = blocks[i];
        junction[i + 1] = Math.min(junction[i + 1], Math.sqrt(junction[i] * junction[i] + 2 * b.accel * b.length));
        lineTime[b.line] += trapezoidTime(b.length, junction[i], junction[i + 1], b.speed, b.accel);
    }
}

/**
 * Works out how long a G-code file takes, how much filament each tool feeds, and when each line
 * finishes.
 *
 * @param {string} gcode The file.
 * @returns {TimedGcode} The estimate and the timing of every line.
 */
export function estimateGcode(gcode: string): TimedGcode {
    const lines = gcode.split('\n');
    const lineTime = new Float64Array(lines.length);
    const limits = defaultLimits();
    const filament: number[] = [];
    let stops = 0;
    let toolChanges = 0;
    // Stops are recorded by line; their times are known once every line has its time.
    const stopLines: number[] = [];

    const position = [0, 0, 0, 0];
    let feed = 1500 / 60; // mm/s until the file sets one
    let relativeXYZ = false;
    let relativeE = false;
    let tool: number | null = null;
    let filamentTool = 0;
    let run: Block[] = [];
    const endRun = () => {
        planRun(run, limits.jerk, lineTime);
        run = [];
    };

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const commentAt = raw.indexOf(';');
        const code = (commentAt === -1 ? raw : raw.slice(0, commentAt)).trim();
        if (!code) {
            // On a single tool head, the emitter names the material that is loaded next.
            const change = /^; Change filament to extruder (\d+)/.exec(raw.trim());
            if (change) filamentTool = Number(change[1]);
            continue;
        }
        const parts = code.split(/\s+/);
        const command = parts[0].toUpperCase();

        if (command === 'G0' || command === 'G1') {
            const words = readWords(parts);
            if (words.has('F')) feed = words.get('F')! / 60;
            const target = [0, 1, 2].map(axis => {
                const value = words.get('XYZ'[axis]);
                if (value === undefined) return position[axis];
                return relativeXYZ ? position[axis] + value : value;
            });
            const eWord = words.get('E');
            const de = eWord === undefined ? 0 : relativeE ? eWord : eWord - position[3];
            const delta: Axes = [target[0] - position[0], target[1] - position[1], target[2] - position[2], de];
            position[0] = target[0];
            position[1] = target[1];
            position[2] = target[2];
            position[3] += de;
            if (de !== 0) filament[filamentTool] = (filament[filamentTool] ?? 0) + de;

            const xyzLength = Math.hypot(delta[0], delta[1], delta[2]);
            const length = xyzLength > 1e-9 ? xyzLength : Math.abs(de);
            if (length <= 1e-9 || !(feed > 0)) continue;

            const unit = delta.map(d => d / length) as Axes;
            let speed = feed;
            let accel = xyzLength > 1e-9 ? (de > 0 ? limits.printAccel : limits.travelAccel) : limits.retractAccel;
            let safeSpeed = Infinity;
            for (let axis = 0; axis < 4; axis++) {
                const share = Math.abs(unit[axis]);
                if (share <= 1e-12) continue;
                speed = Math.min(speed, limits.maxFeed[axis] / share);
                accel = Math.min(accel, limits.maxAccel[axis] / share);
                safeSpeed = Math.min(safeSpeed, limits.jerk[axis] / share);
            }
            run.push({ line: i, length, speed, accel, unit, safeSpeed: Math.min(speed, safeSpeed) });
            continue;
        }

        // Anything below changes the limits, or stops the printer between moves.
        const words = readWords(parts);
        switch (command) {
            case 'G90': relativeXYZ = false; break;
            case 'G91': relativeXYZ = true; break;
            case 'M82': relativeE = false; break;
            case 'M83': relativeE = true; break;
            case 'G92':
                [0, 1, 2, 3].forEach(axis => {
                    const value = words.get('XYZE'[axis]);
                    if (value !== undefined) position[axis] = value;
                });
                break;
            case 'M201':
            case 'M203':
            case 'M205': {
                const target = command === 'M201' ? limits.maxAccel : command === 'M203' ? limits.maxFeed : limits.jerk;
                [0, 1, 2, 3].forEach(axis => {
                    const value = words.get('XYZE'[axis]);
                    if (value !== undefined && value > 0) target[axis] = value;
                });
                break;
            }
            case 'M204':
                if (words.get('S')! > 0) limits.printAccel = limits.travelAccel = words.get('S')!;
                if (words.get('P')! > 0) limits.printAccel = words.get('P')!;
                if (words.get('R')! > 0) limits.retractAccel = words.get('R')!;
                if (words.get('T')! > 0) limits.travelAccel = words.get('T')!;
                break;
            case 'G4':
                endRun();
                lineTime[i] += (words.get('S') ?? 0) + (words.get('P') ?? 0) / 1000;
                break;
            case 'G28':
                endRun();
                // Homing puts the axes it homes at (practically) 0.
                if (!['X', 'Y', 'Z'].some(axis => words.has(axis))) {
                    position[0] = position[1] = position[2] = 0;
                } else {
                    ['X', 'Y', 'Z'].forEach((axis, index) => { if (words.has(axis)) position[index] = 0; });
                }
                break;
            case 'G29':
            case 'M109':
            case 'M190':
                endRun();
                break;
            case 'M0':
            case 'M1':
            case 'M600':
            case 'M601':
                endRun();
                stops++;
                stopLines.push(i);
                break;
            default:
                if (/^T\d+$/.test(command)) {
                    endRun();
                    const next = Number(command.slice(1));
                    if (tool !== null && next !== tool) {
                        toolChanges++;
                        lineTime[i] += TOOL_CHANGE_SECONDS;
                    }
                    tool = next;
                    filamentTool = next;
                }
        }
    }
    endRun();

    const lineEnd = new Float64Array(lines.length);
    let elapsed = 0;
    for (let i = 0; i < lines.length; i++) {
        elapsed += lineTime[i];
        lineEnd[i] = elapsed;
    }
    return {
        estimate: {
            seconds: elapsed,
            filament: Array.from({ length: filament.length }, (_, index) => filament[index] ?? 0),
            stops,
            toolChanges,
        },
        lineEnd,
        stopTimes: stopLines.map(line => lineEnd[line]),
    };
}

/** Whole minutes, as the printer shows them. */
function minutes(seconds: number): number {
    return Math.max(0, Math.round(seconds / 60));
}

/** Whether a line is a move (G0/G1), the lines progress is reported at. */
function isMove(line: string): boolean {
    return /^G[01](\s|$)/.test(line);
}

/**
 * Adds the progress lines a Prusa printer shows its progress from: `M73 P<percent> R<minutes left>`
 * at the top and whenever either value changes, and `M73 C<minutes>` with the time to the next
 * stop for the user, while there is one ahead.
 *
 * @param {string} gcode The file. Lines already in it are kept as they are.
 * @returns {{ gcode: string, estimate: PrintEstimate }} The file with the progress lines, and the estimate.
 */
export function addProgressLines(gcode: string): { gcode: string, estimate: PrintEstimate } {
    const { estimate, lineEnd, stopTimes } = estimateGcode(gcode);
    const total = estimate.seconds;
    const lines = gcode.split('\n');
    const out: string[] = [];

    let lastMain = '';
    let lastStop = '';
    let nextStop = 0;
    const report = (elapsed: number) => {
        const percent = total > 0 ? Math.min(100, Math.floor((100 * elapsed) / total)) : 100;
        const main = `M73 P${percent} R${minutes(total - elapsed)}`;
        if (main !== lastMain) {
            out.push(main);
            lastMain = main;
        }
        while (nextStop < stopTimes.length && stopTimes[nextStop] < elapsed) nextStop++;
        if (nextStop < stopTimes.length) {
            const stop = `M73 C${minutes(stopTimes[nextStop] - elapsed)}`;
            if (stop !== lastStop) {
                out.push(stop);
                lastStop = stop;
            }
        }
    };

    report(0);
    for (let i = 0; i < lines.length; i++) {
        out.push(lines[i]);
        if (isMove(lines[i].trim())) report(lineEnd[i]);
    }
    return { gcode: out.join('\n'), estimate };
}
