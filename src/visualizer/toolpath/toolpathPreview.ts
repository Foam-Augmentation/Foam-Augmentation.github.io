// ---------------------------------------------------------------------------------------------
// The 3D preview of a toolpath: its moves as line segments, coloured by what they print (or by
// tool, speed, V*, H* or Edot), and grouped into steps that follow the print, so a slider can
// show it being built up layer by layer.
//
// A step is a run of moves on one layer of one object (or one helper: the purge line, a block of
// the purge tower). Steps are numbered in print order, so step n shows the print as it stands
// once its n-th layer is finished. That works for non-planar layers too (an augmentation's
// layers follow the surface), where a height slider would cut through them.
//
// No DOM here, so it can be unit-tested under Node.
// ---------------------------------------------------------------------------------------------
import * as THREE from 'three';
import { FEATURE, type PathPoint, type PathRole } from './pathTypes';

/** What the preview's colours show. */
export type PreviewColorMode = 'feature' | 'tool' | 'speed' | 'vStar' | 'hStar' | 'edot';

/** The colour modes in the order they are offered, with their names. */
export const PREVIEW_COLOR_MODES: readonly { mode: PreviewColorMode, label: string }[] = [
    { mode: 'feature', label: 'Feature' },
    { mode: 'tool', label: 'Tool' },
    { mode: 'speed', label: 'Speed' },
    { mode: 'vStar', label: 'V*' },
    { mode: 'hStar', label: 'H*' },
    { mode: 'edot', label: 'Edot' },
];

/**
 * The feature groups the preview tells apart, with their colours. Each colour belongs to one
 * group whatever is on the plate, so a feature looks the same in every preview.
 *
 * The seven hues are the dark-mode categorical palette in its fixed order. The foam trio comes
 * first (it validates for colour-blind readers even when every pair can sit side by side); the
 * four regular groups follow (they pass with a colour-blind warning, which is why the legend can
 * hide and show each group). The shell and the helpers are neutral greys, not hues.
 */
export const FEATURE_GROUPS = [
    { id: 'foam', label: 'Foam', color: 0x3987e5 },
    { id: 'initialFoam', label: 'Initial foam', color: 0xd95926 },
    { id: 'sensingFoam', label: 'Sensing foam', color: 0x199e70 },
    { id: 'walls', label: 'Walls', color: 0xc98500 },
    { id: 'infill', label: 'Infill', color: 0xd55181 },
    { id: 'solid', label: 'Solid infill', color: 0x008300 },
    { id: 'support', label: 'Support', color: 0x9085e9 },
    { id: 'shell', label: 'Shell', color: 0xe6e3dc },
    { id: 'helpers', label: 'Purge, brim and boundary', color: 0x9b958a },
] as const;
export type FeatureGroupId = typeof FEATURE_GROUPS[number]['id'];

/** Which group each feature name belongs to. Names not listed (e.g. PrusaSlicer's "Custom") are helpers. */
const GROUP_OF_FEATURE: Record<string, FeatureGroupId> = {
    [FEATURE.foam]: 'foam',
    [FEATURE.initialFoam]: 'initialFoam',
    [FEATURE.sensingFoam]: 'sensingFoam',
    [FEATURE.shell]: 'shell',
    [FEATURE.ironing]: 'shell',
    [FEATURE.externalPerimeter]: 'walls',
    [FEATURE.perimeter]: 'walls',
    'Overhang perimeter': 'walls',
    [FEATURE.internalInfill]: 'infill',
    [FEATURE.solidInfill]: 'solid',
    'Top solid infill': 'solid',
    'Bridge infill': 'solid',
    'Gap fill': 'solid',
    // PrusaSlicer's ironing of top surfaces (the app's own shell ironing is FEATURE.ironing).
    'Ironing': 'solid',
    'Support material': 'support',
    'Support material interface': 'support',
};

/** The group a move belongs to. */
export function featureGroupOf(point: PathPoint): FeatureGroupId {
    if (point.role !== undefined) return 'helpers';
    if (point.feature !== undefined) return GROUP_OF_FEATURE[point.feature] ?? 'helpers';
    // Untagged moves: what the emitter would print them as.
    if (point.ironing) return 'shell';
    if (point.regularSegment) return 'walls';
    return 'foam';
}

/** Colour of a value on the numeric scales, low to high: one blue ramp, dark to light on the dark scene. */
export const SCALE_STOPS = [0x184f95, 0x256abf, 0x3987e5, 0x6da7ec, 0x9ec5f4, 0xcde2fb] as const;
/** Colour of moves a numeric scale does not apply to (V* of a regular extrusion, say). */
export const NOT_APPLICABLE_COLOR = 0x4b505a;

/** One step of the slider: a layer of an object, or a helper, in print order. */
export interface PreviewStep {
    objectId?: number;
    layer?: number;
    role?: PathRole;
    /** The lowest and highest point the step extrudes at (mm). */
    zMin: number;
    zMax: number;
}

/** Everything the preview needs to recolour and cut the drawing without rebuilding it. */
export interface ToolpathPreview {
    steps: PreviewStep[];
    /** Extruding moves, two vertices each, in print order. */
    extrusion: THREE.LineSegments;
    /** Travel moves, two vertices each, in print order. */
    travel: THREE.LineSegments;
    /** For each step, how many extruding / travel moves come before the end of it. */
    extrusionEnd: Uint32Array;
    travelEnd: Uint32Array;
    /** Where every extruding move's two vertices are; the drawing collapses hidden moves. */
    positions: Float32Array;
    /** Per extruding move: its feature group (index into FEATURE_GROUPS) and its tool. */
    group: Uint8Array;
    tool: Uint8Array;
    /** Per extruding move: its head speed (mm/min), V*, H* and Edot. NaN where it has none. */
    speed: Float32Array;
    vStar: Float32Array;
    hStar: Float32Array;
    edot: Float32Array;
    /** The colour of each tool, by tool number. */
    toolColors: number[];
}

/** What {@link buildToolpathPreview} needs besides the toolpath. */
export interface PreviewOptions {
    /** The colour of each tool, by tool number. */
    toolColors: number[];
    /** The colour of travel moves. */
    travelColor: number;
    /** The head speed (mm/min) of the move to a point, made with the given tool. */
    speedOf?: (point: PathPoint, extruder: number) => number | undefined;
}

/** The key that tells steps apart: the helper, or the object and layer. */
function stepKey(point: PathPoint): string {
    return point.role !== undefined ? `role:${point.role}` : `${point.objectId ?? '-'}:${point.layer ?? '-'}`;
}

/**
 * Builds the preview of a toolpath. It is coloured by feature until {@link colorPreview} says otherwise.
 *
 * @param {PathPoint[]} toolpath The points, in print order. Each point's flags describe the move to it.
 * @param {PreviewOptions} options Colours, and how fast each move is.
 * @returns {ToolpathPreview} The preview. Add `extrusion` and `travel` to the scene to show it.
 */
export function buildToolpathPreview(toolpath: PathPoint[], options: PreviewOptions): ToolpathPreview {
    // 1. Number the steps. Each extrusion starts a new step when its key differs from the last
    //    one; a travel belongs to the step it leads into, so steps never go backwards.
    const stepOf = new Int32Array(toolpath.length);
    const steps: PreviewStep[] = [];
    let lastKey: string | null = null;
    for (let i = 1; i < toolpath.length; i++) {
        const point = toolpath[i];
        if (point.travel) {
            stepOf[i] = -1;
            continue;
        }
        const key = stepKey(point);
        if (key !== lastKey) {
            steps.push({ objectId: point.objectId, layer: point.layer, role: point.role, zMin: Infinity, zMax: -Infinity });
            lastKey = key;
        }
        const step = steps[steps.length - 1];
        stepOf[i] = steps.length - 1;
        step.zMin = Math.min(step.zMin, point.point.z, toolpath[i - 1].point.z);
        step.zMax = Math.max(step.zMax, point.point.z, toolpath[i - 1].point.z);
    }
    let following = Math.max(0, steps.length - 1);
    for (let i = toolpath.length - 1; i >= 1; i--) {
        if (stepOf[i] === -1) stepOf[i] = following;
        else following = stepOf[i];
    }

    // 2. One segment per move, from the point before to the point.
    const extrusionPositions: number[] = [];
    const travelPositions: number[] = [];
    const group: number[] = [];
    const tool: number[] = [];
    const speed: number[] = [];
    const vStar: number[] = [];
    const hStar: number[] = [];
    const edot: number[] = [];
    const extrusionEnd = new Uint32Array(steps.length);
    const travelEnd = new Uint32Array(steps.length);
    let extruder = toolpath[0]?.extruder ?? 0;
    const groupIndex = new Map<string, number>(FEATURE_GROUPS.map((g, index) => [g.id, index]));

    for (let i = 1; i < toolpath.length; i++) {
        const from = toolpath[i - 1].point;
        const point = toolpath[i];
        if (point.extruder !== undefined) extruder = point.extruder;
        const step = stepOf[i];
        if (point.travel) {
            travelPositions.push(from.x, from.y, from.z, point.point.x, point.point.y, point.point.z);
            if (steps.length) travelEnd[step] = travelPositions.length / 6;
            continue;
        }
        extrusionPositions.push(from.x, from.y, from.z, point.point.x, point.point.y, point.point.z);
        group.push(groupIndex.get(featureGroupOf(point))!);
        tool.push(extruder);
        speed.push(options.speedOf?.(point, extruder) ?? NaN);
        const isFoam = !point.regularSegment && !point.ironing && point.role === undefined;
        vStar.push(isFoam ? point.vStar ?? NaN : NaN);
        hStar.push(isFoam ? point.hStar ?? NaN : NaN);
        edot.push(isFoam ? point.edot ?? NaN : NaN);
        extrusionEnd[step] = extrusionPositions.length / 6;
    }
    // Steps without moves of one kind end where the step before them ended.
    for (let s = 1; s < steps.length; s++) {
        extrusionEnd[s] = Math.max(extrusionEnd[s], extrusionEnd[s - 1]);
        travelEnd[s] = Math.max(travelEnd[s], travelEnd[s - 1]);
    }

    const lines = (positions: number[], material: THREE.LineBasicMaterial) => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        return new THREE.LineSegments(geometry, material);
    };
    // Colours per vertex. A hidden feature group is collapsed to zero-length moves instead of being
    // made transparent: three.js does not apply the alpha test to lines, and see-through lines
    // would still hide what is behind them.
    const extrusion = lines(extrusionPositions, new THREE.LineBasicMaterial({ vertexColors: true }));
    extrusion.geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(extrusionPositions.length), 3));
    const travel = lines(travelPositions, new THREE.LineBasicMaterial({ color: options.travelColor }));

    const preview: ToolpathPreview = {
        steps,
        extrusion,
        travel,
        extrusionEnd,
        travelEnd,
        positions: Float32Array.from(extrusionPositions),
        group: Uint8Array.from(group),
        tool: Uint8Array.from(tool),
        speed: Float32Array.from(speed),
        vStar: Float32Array.from(vStar),
        hStar: Float32Array.from(hStar),
        edot: Float32Array.from(edot),
        toolColors: options.toolColors,
    };
    colorPreview(preview, 'feature');
    return preview;
}

/** A legend entry for a colour that stands for something. */
export interface LegendItem {
    /** What the colour stands for: a feature group id, or `tool<n>`. */
    id: string;
    label: string;
    color: number;
    /** How many moves have it. */
    count: number;
}

/** What the colours mean, for the legend. */
export type PreviewLegend =
    | { kind: 'categories', items: LegendItem[] }
    | {
        kind: 'scale', label: string, unit: string,
        /** The lowest and highest value. Not finite when no move has a value. */
        min: number, max: number,
        stops: readonly number[],
        /** The colour of moves without a value, and how many there are. */
        notApplicable: number, notApplicableCount: number,
    };

/** The colour at `t` (0..1) along the numeric scale. */
export function scaleColor(t: number, target: THREE.Color = new THREE.Color()): THREE.Color {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
    const position = clamped * (SCALE_STOPS.length - 1);
    const index = Math.min(SCALE_STOPS.length - 2, Math.floor(position));
    const low = new THREE.Color(SCALE_STOPS[index]);
    const high = new THREE.Color(SCALE_STOPS[index + 1]);
    return target.copy(low).lerp(high, position - index);
}

/** The label and unit of each numeric mode. */
const SCALES: Record<Exclude<PreviewColorMode, 'feature' | 'tool'>, { label: string, unit: string, values: (p: ToolpathPreview) => Float32Array }> = {
    speed: { label: 'Speed', unit: 'mm/min', values: p => p.speed },
    vStar: { label: 'V*', unit: '', values: p => p.vStar },
    hStar: { label: 'H*', unit: '', values: p => p.hStar },
    edot: { label: 'Edot', unit: 'mm/min', values: p => p.edot },
};

/**
 * Colours the preview's extruding moves, and says what the colours mean.
 *
 * @param {ToolpathPreview} preview The preview.
 * @param {PreviewColorMode} mode What to colour by.
 * @param {ReadonlySet<string>} [hidden] Legend ids (feature groups, or `tool<n>`) to leave out of the drawing.
 * @returns {PreviewLegend} The legend for the colours.
 */
export function colorPreview(preview: ToolpathPreview, mode: PreviewColorMode, hidden: ReadonlySet<string> = new Set()): PreviewLegend {
    const colors = preview.extrusion.geometry.getAttribute('color') as THREE.BufferAttribute;
    const array = colors.array as Float32Array;
    const positionAttribute = preview.extrusion.geometry.getAttribute('position') as THREE.BufferAttribute;
    const positions = positionAttribute.array as Float32Array;
    const count = preview.group.length;
    const color = new THREE.Color();
    const write = (segment: number, shown: boolean) => {
        const offset = segment * 6;
        for (let v = 0; v < 2; v++) {
            array[offset + v * 3] = color.r;
            array[offset + v * 3 + 1] = color.g;
            array[offset + v * 3 + 2] = color.b;
        }
        // A hidden move ends where it starts, so nothing is drawn.
        const end = shown ? offset + 3 : offset;
        positions[offset] = preview.positions[offset];
        positions[offset + 1] = preview.positions[offset + 1];
        positions[offset + 2] = preview.positions[offset + 2];
        positions[offset + 3] = preview.positions[end];
        positions[offset + 4] = preview.positions[end + 1];
        positions[offset + 5] = preview.positions[end + 2];
    };

    let legend: PreviewLegend;
    if (mode === 'feature' || mode === 'tool') {
        const counts = new Map<string, number>();
        for (let s = 0; s < count; s++) {
            const id = mode === 'feature' ? FEATURE_GROUPS[preview.group[s]].id : `tool${preview.tool[s]}`;
            counts.set(id, (counts.get(id) ?? 0) + 1);
            color.setHex(mode === 'feature'
                ? FEATURE_GROUPS[preview.group[s]].color
                : preview.toolColors[preview.tool[s]] ?? preview.toolColors[0] ?? 0xffffff);
            write(s, !hidden.has(id));
        }
        const items: LegendItem[] = mode === 'feature'
            ? FEATURE_GROUPS.filter(g => counts.has(g.id)).map(g => ({ id: g.id, label: g.label, color: g.color, count: counts.get(g.id)! }))
            : [...counts.keys()].sort().map(id => {
                const n = Number(id.slice('tool'.length));
                return { id, label: `T${n}`, color: preview.toolColors[n] ?? preview.toolColors[0] ?? 0xffffff, count: counts.get(id)! };
            });
        legend = { kind: 'categories', items };
    } else {
        const scale = SCALES[mode];
        const values = scale.values(preview);
        let min = Infinity;
        let max = -Infinity;
        for (let s = 0; s < count; s++) {
            const value = values[s];
            if (Number.isFinite(value)) {
                if (value < min) min = value;
                if (value > max) max = value;
            }
        }
        const span = max - min;
        let notApplicableCount = 0;
        for (let s = 0; s < count; s++) {
            const value = values[s];
            if (Number.isFinite(value)) {
                scaleColor(span > 0 ? (value - min) / span : 1, color);
            } else {
                color.setHex(NOT_APPLICABLE_COLOR);
                notApplicableCount++;
            }
            write(s, true);
        }
        legend = {
            kind: 'scale', label: scale.label, unit: scale.unit, min, max, stops: SCALE_STOPS,
            notApplicable: NOT_APPLICABLE_COLOR, notApplicableCount,
        };
    }
    colors.needsUpdate = true;
    positionAttribute.needsUpdate = true;
    return legend;
}

/**
 * Shows the print as it stands at the end of one step: every step up to it, or that step alone.
 *
 * @param {ToolpathPreview} preview The preview.
 * @param {number} last The step to show up to (0-based); clamped to the steps there are.
 * @param {boolean} [only] Show that step alone.
 */
export function showPreviewSteps(preview: ToolpathPreview, last: number, only = false): void {
    if (!preview.steps.length) return;
    const step = Math.min(preview.steps.length - 1, Math.max(0, Math.round(last)));
    const range = (ends: Uint32Array) => {
        const end = ends[step];
        const start = only && step > 0 ? ends[step - 1] : 0;
        return { start: start * 2, count: (end - start) * 2 };
    };
    const extrusion = range(preview.extrusionEnd);
    const travel = range(preview.travelEnd);
    preview.extrusion.geometry.setDrawRange(extrusion.start, extrusion.count);
    preview.travel.geometry.setDrawRange(travel.start, travel.count);
}
