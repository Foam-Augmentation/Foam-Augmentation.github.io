import * as THREE from 'three';
import type { ToolpathConfig } from "../visualizer/types/modelTypes";
import type { PathPoint } from "../visualizer/toolpath/pathTypes";
import { PURGE_LINE_LIFT } from "../visualizer/toolpath/toolpathConstants";

export interface Extruder {
  /** Nozzle diameter (in mm) */
  nozzleDiameter: number;
  /** Nozzle length (in mm) */
  nozzleLength: number;
  /** Die swelling factor */
  dieSwelling: number;
  /** Print head speed during free movement */
  printHead_speed_when_free_move: number;
  /** Extruder temperature (in °C) */
  print_temp_extruder: number;
  /** Standby temperature while parked (in °C). Hot enough to reheat fast, cool enough not to ooze. */
  idle_temp_extruder: number;
  color: number;
}

/**
 * Creates an extruder with the default parameters.
 * Used when adding a new extruder from the visualizer.
 *
 * @returns {Extruder} A new extruder with default settings.
 */
export function createDefaultExtruder(): Extruder {
  return {
    nozzleDiameter: 0.4,
    nozzleLength: 4.5,
    dieSwelling: 1.0,
    printHead_speed_when_free_move: 1000,
    print_temp_extruder: 230,
    idle_temp_extruder: 70,
    color: 0x5fd38d
  };
}

export interface VTPSettings {
  V_Star: number;
  vStarEnd: number;
  Edot: number;
  deltaZ: number; // deltaZ (thickness of a single foam layer)
  deltaLEnd: number;
  ZOffset: number; // zOffset (distance between the nozzle and the layer under to allow VTP)
  H_star: number; // H_star (height of the foam layer)
  hStarEnd: number;
  useFermatSpirals: boolean;
  deltaL: number,
}

/** XY bounding box of the first layer, used for M555 and for locating the nozzle cleanup area. */
export interface FirstLayerBounds { min: THREE.Vector2; max: THREE.Vector2 }

/**
 * Everything the G-code emitter has to remember between points. It is passed in and out
 * explicitly, rather than living on the Printer, so that several toolpaths emitted one after the
 * other carry on from where the previous one really left off.
 */
export interface EmitterState {
  /** The extruder that is currently picked (or, on a single-head machine, whose material is loaded). Null if none. */
  extruder: number | null;
  /**
   * For each tool, whether the "initial foam layers" material is what is loaded in it right now.
   * A tool with no entry has not printed anything that cares yet. Single-head machines only use key 0.
   */
  initialMaterialLoaded: Map<number, boolean>;
}

/** Temperature (°C) everything is held at during a test sweep, i.e. cold. */
const TEST_SWEEP_TEMPERATURE = 20;
/** Fraction of the regular flow used for an ironing pass. */
const IRONING_FLOW = 0.2;
/** Head speed (mm/min) of an ironing pass. */
const IRONING_SPEED = 1500;

/**
 * Printer class is used to generate G-code for a 3D printer,
 * including generating base (boundary) G-code and foam toolpath G-code.
 */
export default class Printer {
  public material_bed_temperature: number;
  public extruders: Extruder[];
  /** Machine X size (mm). Defaults to Prusa XL. */
  public machine_depth: number;
  /** Machine Y size (mm). Defaults to Prusa XL. */
  public machine_depth_y: number;
  /** Machine height (maximum z axis length). Defaults to Prusa XL. */
  public machine_height: number;

  public diameter_filament: number;
  public globalVTPSettings: VTPSettings;
  public senseVTPSettings: VTPSettings

  public generateBoundary: boolean;
  public purgeLine: boolean;
  public checkCollisions: boolean;

  public printHeadDims: { min: THREE.Vector2, max: THREE.Vector2 };

  public bedLeveling: boolean;
  public testSweep: boolean;

  /**
   * Whether the machine has independent toolheads that can be parked and picked (e.g. Prusa XL).
   * When false, the single toolhead swaps materials with an M600 filament change instead
   * (printed in MK3S mode on an MK4).
   */
  public multipleToolheads: boolean;
  /**
   * Index of the extruder the start G-code picked / the last emitted toolpath ended on.
   * Only used to seed {@link createEmitterState}; emission itself runs on an explicit EmitterState.
   */
  public activeExtruder: number;
  /** Filament retracted before parking a tool and pushed back after picking one (in mm) */
  public toolchangeRetract: number;

  public purgeTower: boolean;
  /** Outer radius of the purge tower (in mm) */
  public purgeTowerRadius: number;
  /** Distance kept between the bed edges and the purge line / purge tower (in mm) */
  public bedMargin: number;

  /** Nozzle temperature (°C) for bed probing and nozzle cleaning, cool enough not to ooze. */
  public mblTemp: number;
  /** Z lift (mm) the firmware makes on every toolchange (M217 Z). */
  public toolchangeZHop: number;
  /** Head speed (mm/min) for toolchange moves. */
  public toolchangeTravelSpeed: number;
  /**
   * Layer height (mm) the foam shell is sliced and printed at. Its extrusion is worked out from
   * this height, so thinner shell layers get proportionally less plastic.
   */
  public shellLayerHeight: number;
  /** Index = G-code tool, value = physical toolhead. Undefined = no remapping. */
  public toolMapping?: number[];

  /**
   * Creates a new Printer instance and initializes default parameters and end G-code.
   */
  constructor() {
    this.material_bed_temperature = 60; // bed temperature
    this.extruders = [
      {// TPU extruder
        nozzleDiameter: 0.4,
        nozzleLength: 4.5,
        dieSwelling: 1.0,
        printHead_speed_when_free_move: 1000,
        print_temp_extruder: 230,
        idle_temp_extruder: 70,
        color: 0x5fd38d
      },
      {//conductive TPU extruder
        nozzleDiameter: 0.4,
        nozzleLength: 4.5,
        dieSwelling: 1.0,
        printHead_speed_when_free_move: 1000,
        print_temp_extruder: 240,
        idle_temp_extruder: 70,
        color: 0xf2a65a
      }
    ];
    this.purgeTower = true;
    this.purgeTowerRadius = 10;
    this.bedMargin = 5;
    this.machine_depth = 360; // Prusa XL bed X
    this.machine_depth_y = 360; // Prusa XL bed Y
    this.machine_height = 360; // Prusa XL max Z
    this.diameter_filament = 1.75;
    this.globalVTPSettings = {
      V_Star: 0.15,
      Edot: 50,
      deltaZ: 1.7,
      ZOffset: 3.38,
      H_star: 6.0,
      useFermatSpirals: false,
      deltaL:1.7,
      deltaLEnd: 1.7,
      hStarEnd: 6.0,
      vStarEnd: 0.15
    };
    this.senseVTPSettings = {
      V_Star: 0.15,
      Edot: 50,
      deltaZ: 1.7,
      ZOffset: 3.38,
      H_star: 6.0,
      useFermatSpirals: false,
      deltaL:1.7,
      deltaLEnd: 1.7,
      hStarEnd: 6.0,
      vStarEnd: 0.15
    };
    this.generateBoundary = false;
    this.purgeLine = true;
    this.checkCollisions = false;
    this.printHeadDims = { min: new THREE.Vector2(-40, -15), max: new THREE.Vector2(35, 70) }
    this.bedLeveling = true;
    this.testSweep = false;
    this.multipleToolheads = true;
    this.activeExtruder = 0;
    this.toolchangeRetract = 3.0;
    this.mblTemp = 170;
    this.toolchangeZHop = 2;
    this.toolchangeTravelSpeed = 24000;
    this.shellLayerHeight = 0.1;
  }


  /**
   * Updates the printers parameters.
   *
   * @param {ToolpathConfig} toolpathConfig The toolpath config to update the parameters to.
   */
  public updateParameters(
    toolpathConfig: ToolpathConfig
  ): void {
    this.globalVTPSettings.deltaZ = toolpathConfig.deltaZ;
    this.globalVTPSettings.V_Star = toolpathConfig.vStar;
    this.globalVTPSettings.H_star = toolpathConfig.hStar;
    this.globalVTPSettings.deltaL = toolpathConfig.deltaL;
    this.globalVTPSettings.deltaLEnd = toolpathConfig.deltaLEnd;
    this.globalVTPSettings.ZOffset = this.globalVTPSettings.H_star * this.threadDiameter(0);
    this.globalVTPSettings.hStarEnd = toolpathConfig.hStarEnd;
    this.globalVTPSettings.vStarEnd = toolpathConfig.vStarEnd;
    this.globalVTPSettings.Edot = toolpathConfig.edot;

    this.senseVTPSettings.deltaZ = toolpathConfig.senseDeltaZ;
    this.senseVTPSettings.V_Star = toolpathConfig.senseVStar;
    this.senseVTPSettings.H_star = toolpathConfig.senseHStar;
    this.senseVTPSettings.deltaL = toolpathConfig.senseDeltaL;
    this.senseVTPSettings.deltaLEnd = toolpathConfig.senseDeltaLEnd;
    this.senseVTPSettings.ZOffset = this.senseVTPSettings.H_star * this.threadDiameter(1);
    this.senseVTPSettings.hStarEnd = toolpathConfig.senseHStarEnd;
    this.senseVTPSettings.vStarEnd = toolpathConfig.SenseVStarEnd;
    this.senseVTPSettings.Edot = toolpathConfig.senseEdot;
  }

  /**
   * The diameter of the thread coming out of an extruder: nozzle diameter times die swell.
   * This is the d in H = H* d. Falls back to extruder 0 if the index doesn't exist
   * (e.g. sensing settings on a single-extruder setup).
   *
   * @param {number} extruder The extruder index.
   * @returns {number} The thread diameter in mm.
   */
  public threadDiameter(extruder: number): number {
    const e = this.extruders[extruder] ?? this.extruders[0];
    return e.nozzleDiameter * e.dieSwelling;
  }

  /**
   * The default layer height of regular (non-VTP) extrusions: half the nozzle diameter. The purge
   * tower uses this, so it follows the nozzle instead of assuming a 0.4 mm one. The foam shell has
   * its own height, {@link shellLayerHeight}. Falls back to extruder 0 if the index doesn't exist.
   *
   * @param {number} extruder The extruder index.
   * @returns {number} The layer height in mm.
   */
  public regularLayerHeight(extruder: number = 0): number {
    const e = this.extruders[extruder] ?? this.extruders[0];
    return e.nozzleDiameter / 2;
  }

  /**
   * Where the purge tower stands: in the far corner of the bed (maximum x and y), one bed margin
   * in from both edges. On the default 360 x 360 Prusa XL bed that is (345, 345).
   *
   * @returns {THREE.Vector2} The center of the purge tower.
   */
  public purgeTowerCenter(): THREE.Vector2 {
    const inset = this.bedMargin + this.purgeTowerRadius;
    return new THREE.Vector2(this.machine_depth - inset, this.machine_depth_y - inset);
  }

  /**
   * The temperature an extruder prints at. During a test sweep nothing is extruded, so every
   * tool stays cold.
   *
   * @param {number} extruder The extruder index.
   * @returns {number} The temperature in °C.
   */
  public printTemperature(extruder: number): number {
    return this.testSweep ? TEST_SWEEP_TEMPERATURE : this.requireExtruder(extruder).print_temp_extruder;
  }

  /**
   * Returns a copy of the VTP settings for an extruder (0 = regular foam, otherwise sensing).
   * Callers get their own object, so later updateParameters calls don't change it.
   *
   * @param {number} extruder The extruder index.
   * @returns {VTPSettings} A copy of that extruder's VTP settings.
   */
  public getVTPSettings(extruder: number): VTPSettings {
    return { ...(extruder == 0 ? this.globalVTPSettings : this.senseVTPSettings) };
  }

  /**
   * Looks an extruder up by index, failing loudly instead of emitting G-code for a tool that
   * does not exist.
   *
   * @param {number} extruder The extruder index.
   * @returns {Extruder} The extruder's settings.
   */
  private requireExtruder(extruder: number): Extruder {
    const e = this.extruders[extruder];
    if (!e) {
      throw new Error(`The toolpath uses extruder ${extruder}, but the printer only has ${this.extruders.length} extruder(s).`);
    }
    return e;
  }

  /**
   * Builds the ending G-code that shuts the printer down after a print.
   * On a multi-toolhead machine every tool is switched off individually, whether or not this
   * print used it: a tool the print never picked may still be hot from the start G-code or from
   * an earlier print, and an extra M104 S0 costs nothing. The last picked tool is then parked.
   * On a single-head machine the one nozzle is switched off.
   *
   * @returns {string} The ending G-code string.
   */
  public build_end_gcode(): string {
    const lines: string[] = ["", "G4 S5; Dwell for 5 Second(s)"];

    if (this.multipleToolheads) {
      this.extruders.forEach((_, n) => {
        lines.push(`M104 T${n} S0 ; turn off tool ${n}`);
      });
    } else {
      lines.push("M104 S0 ; turn off temperature");
    }

    lines.push(
      "M140 S0 ; turn off heatbed",
      "M107 ; turn off fan",
      "G91 ; set relative positioning",
      "G1 E-1.0 F1800 ; retract filament slightly",
      "G0 Z10 F5000 ; move print head up 10mm",
      "G90 ; set absolute positioning"
    );

    if (this.multipleToolheads) {
      lines.push("P0 S1 ; park the last picked tool");
    }

    lines.push(
      "G28 X Y ; home x and y",
      "M900 K0 ; reset LA",
      "M84 ; disable motors",
      "M73 P100 R0 ; progress to 100%"
    );

    return lines.join("\n");
  }

  /** M863: map G-code tools (L) to the physical toolheads (P), like the XL's Tools Mapping screen. */
  private build_tool_mapping(): string {
    if (!this.multipleToolheads || !this.toolMapping) return "";
    return [
      "M863 R",
      ...this.toolMapping.map((physical, logical) => `M863 M P${physical} L${logical}`),
      "M863 E1"
    ].join("\n");
  }

  /**
   * XY bounds of everything printed on the first layer: the parts touching the bed (boundary, purge
   * line, purge tower) and the lowest VTP layer of the model.
   *
   * @param {{x: number, y: number, z: number}[]} pts Extruding points only.
   * @returns {FirstLayerBounds | undefined} Clamped to the bed, or undefined if there are no points.
   */
  private firstLayerBounds(pts: { x: number; y: number; z: number }[]): FirstLayerBounds | undefined {
    if (!pts.length) return undefined;
    let z0 = Infinity;
    for (const p of pts) if (p.z < z0) z0 = p.z;
    const bedTop = z0 + 0.5;
    let z1 = Infinity;
    for (const p of pts) if (p.z > bedTop && p.z < z1) z1 = p.z;
    const limit = z1 + this.globalVTPSettings.deltaZ;

    const min = new THREE.Vector2(Infinity, Infinity);
    const max = new THREE.Vector2(-Infinity, -Infinity);
    for (const p of pts) {
      if (p.z > bedTop && p.z > limit) continue;
      min.set(Math.min(min.x, p.x), Math.min(min.y, p.y));
      max.set(Math.max(max.x, p.x), Math.max(max.y, p.y));
    }
    min.set(Math.max(min.x, 0), Math.max(min.y, 0));
    max.set(Math.min(max.x, this.machine_depth), Math.min(max.y, this.machine_depth_y));
    return { min, max };
  }

  /**
   * First-layer XY bounds of a toolpath, from its extruding points.
   *
   * @param {PathPoint[]} toolpath The toolpath.
   * @returns {FirstLayerBounds | undefined} The bounds, or undefined if nothing is extruded.
   */
  public boundsFromToolpath(toolpath: PathPoint[]): FirstLayerBounds | undefined {
    return this.firstLayerBounds(
      toolpath.filter(p => !p.travel).map(p => ({ x: p.point.x, y: p.point.y, z: p.point.z }))
    );
  }

  /**
   * First-layer XY bounds of already generated G-code, from its extruding G0/G1 moves.
   *
   * @param {string} gcode The G-code body.
   * @returns {FirstLayerBounds | undefined} The bounds, or undefined if nothing is extruded.
   */
  public boundsFromGcode(gcode: string): FirstLayerBounds | undefined {
    const pts: { x: number; y: number; z: number }[] = [];
    let x = 0, y = 0, z = 0;
    for (const raw of gcode.split("\n")) {
      const line = raw.split(";")[0];
      if (!/^G[01]\s/.test(line)) continue;
      const mx = /X(-?[\d.]+)/.exec(line), my = /Y(-?[\d.]+)/.exec(line);
      const mz = /Z(-?[\d.]+)/.exec(line), me = /E(-?[\d.]+)/.exec(line);
      if (mx) x = +mx[1];
      if (my) y = +my[1];
      if (mz) z = +mz[1];
      if (me && +me[1] > 0 && (mx || my)) pts.push({ x, y, z });
    }
    return this.firstLayerBounds(pts);
  }

  /**
   * Builds the starting G-code to initialize printer settings.
   *
   * @param {number} firstExtruder - The index of the extruder the print starts with.
   * @param {number[]} usedExtruders - The indices of every extruder this print will use.
   * @param {FirstLayerBounds} [bounds] - XY bounds of the first layer (for M555 and nozzle cleanup).
   * @returns {string} The starting G-code string.
   */
  public build_start_gcode(firstExtruder: number, usedExtruders: number[], bounds?: FirstLayerBounds): string {
    const first = this.requireExtruder(firstExtruder);
    usedExtruders.forEach(n => this.requireExtruder(n));
    const bedTemp = this.testSweep ? TEST_SWEEP_TEMPERATURE : this.material_bed_temperature;
    const mbl = this.testSweep ? TEST_SWEEP_TEMPERATURE : this.mblTemp;
    const bedX = this.machine_depth;
    // Without bounds (nothing printed yet), probe and clean around the middle of the bed.
    const b: FirstLayerBounds = bounds ?? {
      min: new THREE.Vector2(bedX / 2 - 15, this.machine_depth_y / 2 - 15),
      max: new THREE.Vector2(bedX / 2 + 15, this.machine_depth_y / 2 + 15)
    };
    const f = (v: number) => +v.toFixed(4);

    const used = usedExtruders.indexOf(firstExtruder) !== -1
      ? usedExtruders
      : [firstExtruder, ...usedExtruders];

    const mesh = (probe: string) => this.bedLeveling ? [
      "M84 E",
      "G29 P1",
      probe,
      "G29 P3.2",
      "G29 P3.13",
      "G29 A"
    ] : [];

    let nozzleCheck: string;
    let limits: string;
    let m555: string;
    let setup: string;

    if (this.multipleToolheads) {
      limits = [
        "M201 X7000 Y7000 Z200 E2500",
        "M203 X400 Y400 Z12 E100",
        "M204 P4000 R1200 T5000",
        "M205 X8.00 Y8.00 Z2.00 E10.00"
      ].join("\n");
      nozzleCheck = used
        .map(n => `M862.1 T${n} P${this.extruders[n].nozzleDiameter} ; nozzle diameter check`)
        .join("\n");
      m555 = `M555 X${f(b.min.x)} Y${f(b.min.y)} W${f(b.max.x - b.min.x)} H${f(b.max.y - b.min.y)}`;

      const noRoom = b.min.y - 7 < -2;
      const baseX = Math.min(bedX, b.min.x + 32) - 32;
      const cleanX = (b.min.x + b.max.x) / 2 < bedX / 2 ? (noRoom ? 70 : baseX) : (noRoom ? 260 : baseX);
      const cleanY = Math.max(b.min.y - 7, -7);
      const probeW = used.some(n => n >= 2) ? 300 : used.indexOf(1) !== -1 ? 130 : 50;
      const t = firstExtruder;

      const lines: string[] = ["; turn off the toolheads this print never picks"];
      this.extruders.forEach((_, n) => { if (used.indexOf(n) === -1) lines.push(`M104 T${n} S0`); });
      lines.push(
        `M217 Z${this.toolchangeZHop}`,
        `M140 S${bedTemp}`,
        `M104 T${t} S${mbl}`,
        "G28 XY",
        `G1 F${this.toolchangeTravelSpeed}`,
        ...used.filter(n => n !== t).map(n => `T${n} S1 L0 D0`),
        `T${t} S1 L0 D0`,
        `M109 T${t} S${mbl}`,
        "M84 E",
        "G28 Z",
        "G0 Z5",
        `M104 T${t} S${first.idle_temp_extruder}`,
        `M190 S${bedTemp}`,
        "G29 G",
        `M109 T${t} S${mbl}`,
        `G1 X${f(Math.min(cleanX, b.min.x) + 32)} Y${f(cleanY)} Z5 F24000`,
        "M302 S155",
        "G1 E-2 F2400",
        "M84 E",
        `G29 P9 X${f(cleanX)} Y${f(cleanY)} W32 H7`,
        "G0 Z5 F480",
        "M107",
        ...mesh(`G29 P1 X30 Y0 W${probeW} H20 C`),
        "G1 Z10 F720",
        `G1 F${this.toolchangeTravelSpeed}`,
        "P0 S1 L1 D0",
        ...used.filter(n => n !== t).map(n => `M104 T${n} S${this.extruders[n].idle_temp_extruder}`),
        `M104 T${t} S${this.printTemperature(t)}`,
        `M109 T${t} S${this.printTemperature(t)}`,
        `T${t} S1 L0 D0 ; pick the first tool`
      );
      setup = lines.join("\n");
    } else {
      limits = [
        "M201 X4000 Y4000 Z200 E2500",
        "M203 X300 Y300 Z40 E100",
        "M204 P4000 R2500 T4000",
        "M205 X8.00 Y8.00 Z2.00 E10.00"
      ].join("\n");
      nozzleCheck = `M862.1 P${first.nozzleDiameter} ; nozzle diameter check`;

      const mx = Math.min(bedX, b.min.x + 32) - 32;
      const my = Math.max(0, b.min.y) - 4;
      const mw = Math.min(bedX, Math.max(b.min.x + 32, b.max.x)) - mx;
      m555 = `M555 X${f(mx)} Y${f(my)} W${f(mw)} H${f(b.max.y - my)}`;

      setup = [
        `M140 S${bedTemp}`,
        `M104 T0 S${mbl}`,
        `M109 T0 R${mbl}`,
        "M84 E",
        "G28",
        `G1 X${f(mx + 32)} Y${f(my)} Z5 F4800`,
        "M302 S155",
        "G1 E-2 F2400",
        "M84 E",
        `G29 P9 X${f(mx)} Y${f(my)} W32 H4`,
        "G0 Z40 F10000",
        `M190 S${bedTemp}`,
        "M107",
        ...mesh("G29 P1 X0 Y0 W50 H20 C"),
        `M104 S${this.printTemperature(firstExtruder)}`,
        `M109 S${this.printTemperature(firstExtruder)}`
      ].join("\n");
    }

    // Remembered so that an emitter state created afterwards starts on the tool picked here.
    this.activeExtruder = firstExtruder;
    return `; Parameters:
; V* = ${this.globalVTPSettings.V_Star}
; H* = ${this.globalVTPSettings.H_star}
; Edot (mm/min) = ${this.globalVTPSettings.Edot}
; deltaZ (mm) = ${this.globalVTPSettings.deltaZ}

; Calculated Parameters:
; ZOffset (mm) = ${this.globalVTPSettings.ZOffset.toFixed(6)}
; printHeadSpeed (mm/min) = ${(this.globalVTPSettings.Edot * this.globalVTPSettings.V_Star * (Math.pow(this.diameter_filament, 2) / Math.pow(first.nozzleDiameter * first.dieSwelling, 2))).toFixed(6)}


${limits}
M205 S0 T0 ; sets the minimum extruding and travel feed rate, mm/sec
M107 ; turns off fan
${nozzleCheck}
M862.3 P "${this.multipleToolheads ? "XL" : "MK3S"}" ; printer model check
${this.build_tool_mapping()}

G21 ; set units to millimeters
G90 ; use absolute coordinates
${m555}
${setup}

M83  ; extruder relative mode
M900 K0.05 ; Filament gcode LA 1.5
M900 K30 ; Filament gcode LA 1.0

G0 Z0.200 F2400.000

M204 P1000 T1000

`;
  }

  /**
   * Generates the G-code to switch to a different extruder profile.
   * On a machine with multiple toolheads this parks one head and picks another; on a single-head
   * machine it falls back to an M600 filament change, since the material has to be swapped by hand.
   *
   * @param {number} to The index of the extruder to switch to.
   * @param {number | null} from The index of the currently active extruder, or null if none.
   * @param {string} [materialNote] Extra wording for the filament change prompt on a single-head machine.
   * @returns {string} The G-code performing the switch.
   */
  public switchExtruder(to: number, from: number | null, materialNote?: string): string {
    return this.multipleToolheads
      ? this.changeTool(to, from)
      : this.changeFilament(to, materialNote);
  }

  /**
   * Generates the G-code to swap materials on a single toolhead, pausing for the user to
   * physically change the filament and then bringing the nozzle to the new material's temperature.
   *
   * @param {number} to The index of the extruder profile whose material is being loaded.
   * @param {string} [materialNote] Which of that profile's materials to load, if it matters.
   * @returns {string} The filament change G-code.
   */
  public changeFilament(to: number, materialNote?: string): string {
    const temp = this.printTemperature(to);

    this.activeExtruder = to;

    return [
      `\n; Change filament to extruder ${to}'s material${materialNote ? ` (${materialNote})` : ""}`,
      "M600 ; pause and prompt the user to swap filament",
      `M104 S${temp} ; set extruder temp`,
      `M109 S${temp} ; wait for extruder temp`,
      "G92 E0\n"
    ].join("\n");
  }

  /**
   * Generates the G-code that pauses for the user to swap between the "initial foam layers"
   * material and the main material in the tool that is currently active. Only the filament
   * changes: the tool, its nozzle geometry and its temperature all stay as they are.
   *
   * @param {boolean} toInitial True to load the initial-layer material, false to load the main one.
   * @param {number} extruder The index of the active extruder, for the comment.
   * @returns {string} The filament swap G-code.
   */
  public swapInitialMaterial(toInitial: boolean, extruder: number): string {
    return [
      `\n; Swap filament in extruder ${extruder}: load the ${toInitial ? "initial-layer" : "main"} material`,
      "M600 ; pause and prompt the user to swap filament",
      "G92 E0\n"
    ].join("\n");
  }

  /**
   * Generates the G-code to swap the active toolhead (same order as PrusaSlicer's toolchange block).
   * Preheats the incoming tool, retracts and idles the outgoing tool, parks it, waits for the
   * incoming tool's temperature, picks it and primes. The z-hop is performed by the firmware (M217 Z
   * from the start G-code). Updates {@link activeExtruder} so later moves use the new nozzle geometry.
   *
   * @param {number} to The index of the extruder to pick.
   * @param {number | null} from The index of the currently picked extruder, or null if none is picked.
   * @returns {string} The toolchange G-code.
   */
  public changeTool(to: number, from: number | null): string {
    const lines: string[] = [`\n; Change Tool${from ?? -1} -> Tool${to}`];
    // In a test sweep nothing is extruded, so the incoming tool is not heated either.
    const printTemp = this.printTemperature(to);

    // Start the incoming tool heating now so the M109 below barely blocks.
    lines.push(`M104 S${printTemp} T${to} ; preheat incoming tool`);
    lines.push(`G1 F${this.toolchangeTravelSpeed}`);

    if (from !== null) {
      lines.push(`G1 E-${this.toolchangeRetract.toFixed(4)} F2100 ; retract before park`);
      lines.push(`M104 S${this.requireExtruder(from).idle_temp_extruder} T${from} ; idle outgoing tool`);
      lines.push("P0 S1 L2 D0 ; park the currently-picked tool");
    }

    lines.push(`M109 S${printTemp} T${to} ; wait for incoming tool's temp`);
    lines.push(`T${to} S1 L0 D0 ; pick tool ${to}`);
    lines.push(`G1 E${this.toolchangeRetract.toFixed(4)} F1500 ; prime`);
    lines.push("G92 E0\n");

    this.activeExtruder = to;

    return lines.join("\n");
  }

  /**
   * Generates the G-code command for moving the print head to a target position without extruding.
   *
   * @param {THREE.Vector3} target - The target coordinates.
   * @param {number} extruder - The active extruder, whose travel speed is used. Defaults to the last active one.
   * @returns {string} The G-code command for moving to the target position.
   */
  public moveToPosition(target: THREE.Vector3, extruder: number = this.activeExtruder): string {
    return `G0 X${target.x.toFixed(6)} Y${target.y.toFixed(6)} Z${target.z.toFixed(6)} F${this.requireExtruder(extruder).printHead_speed_when_free_move}`;
  }

  /**
   * Generates the G-code for extruding a single viscous-thread-printing segment between two points.
   *
   * @private
   * @param {THREE.Vector3} p0 - The starting point.
   * @param {THREE.Vector3} p1 - The ending point.
   * @param {number} vStar - V* (head speed / thread speed) for this segment.
   * @param {number} edot - Filament feed rate (mm/min) for this segment.
   * @param {number} extruderIndex - The extruder printing the segment, for its nozzle geometry.
   * @returns {string} The G-code command for the extrusion segment.
   */
  private extrudeSingleSegment(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    vStar: number,
    edot: number,
    extruderIndex: number,
  ): string {
    const extruder = this.requireExtruder(extruderIndex);
    const beta = (Math.PI / 4) * Math.pow(this.diameter_filament, 2);
    const gamma = (Math.PI / 4) * Math.pow(extruder.dieSwelling * extruder.nozzleDiameter, 2);

    const S = gamma / (beta * vStar);
    const F = edot / S;

    // Jerry changed this to be multiplied by S instead of multiplied by (extrusion_speed_when_foam / printHead_speed_when_foam))
    const extrudedAmount = this.norm(p1, p0) * S;

    return `G1 X${p1.x.toFixed(6)} Y${p1.y.toFixed(6)} Z${p1.z.toFixed(6)} E${extrudedAmount.toFixed(6)} F0${Math.round(F)}`;
  }


  /**
   * Extrudes a regular line of filament between two points.
   * The intended width of the extrusion is the thread diameter, and its height is the layer
   * height the segment was sliced at (half the nozzle diameter unless stated otherwise).
   *
   * @param {THREE.Vector3} p0 The point the toolhead is coming from
   * @param {THREE.Vector3} p1 The point the toolhead is moving to.
   * @param {number} extruderIndex The extruder printing the segment.
   * @param {number} flow Multiplier on the amount of filament extruded.
   * @param {number} [speed] Head speed in mm/min. Defaults to the extruder's travel speed.
   * @param {number} [layerHeight] The layer height in mm. Defaults to half the nozzle diameter.
   * @returns  {string} The gcode to print the segment.
   */
  private extrudeRegularSegment(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    extruderIndex: number,
    flow: number = 1,
    speed?: number,
    layerHeight?: number,
  ): string {
    const extruder = this.requireExtruder(extruderIndex);
    // bead cross-section = extrusion width (nozzle diameter * dieswell) * layer height
    const beadArea = extruder.dieSwelling * extruder.nozzleDiameter * (layerHeight ?? this.regularLayerHeight(extruderIndex));
    const crossSection = Math.PI * Math.pow(this.diameter_filament / 2, 2);
    const filamentPerMM = (beadArea / crossSection) ;
    const dist = this.norm(p0, p1);
    const gcode = `G1 X${p1.x.toFixed(6)} Y${p1.y.toFixed(6)} Z${p1.z.toFixed(6)} E${(flow * filamentPerMM * dist).toFixed(6)} F${speed ?? extruder.printHead_speed_when_free_move}`;
    return gcode;
  }

  /**
   * Creates the state a toolpath emission starts from: the tool the start G-code (or the last
   * emitted toolpath) left picked, and nothing known yet about which material is loaded where.
   *
   * @param {number | null} extruder The extruder that is currently picked. Defaults to the last active one.
   * @returns {EmitterState} A fresh emitter state.
   */
  public createEmitterState(extruder: number | null = this.activeExtruder): EmitterState {
    return { extruder, initialMaterialLoaded: new Map() };
  }

  /**
   * Finds out whether the points that follow a filament change start with the initial-layer
   * material, so the change prompt can say which material to load.
   *
   * @param {PathPoint[]} toolpath The toolpath being emitted.
   * @param {number} from The index of the point the filament change happens at.
   * @returns {boolean | undefined} The first defined initialMaterial flag before the next extruder change.
   */
  private upcomingInitialMaterial(toolpath: PathPoint[], from: number): boolean | undefined {
    const extruder = toolpath[from].extruder;
    for (let i = from; i < toolpath.length; i++) {
      const point = toolpath[i];
      if (point.extruder !== undefined && point.extruder !== extruder) {
        return undefined;
      }
      if (point.initialMaterial !== undefined) {
        return point.initialMaterial;
      }
    }
    return undefined;
  }

  /**
   * Generates foam toolpath G-code from a given toolpath.
   *
   * Nothing about the print is remembered on the Printer between calls: the picked tool and the
   * material loaded in each tool come from `state`, which is updated in place. Emitting several
   * toolpaths with the same state object therefore gives correct tool changes across them.
   *
   * @param {PathPoint[]} toolpath The points to turn into gcode in order with correct properties.
   *                               Any point that isn't a travel movement or regular segment should have
   *                               hStar, vStar, and edot among their properties.
   * @param {EmitterState} state Where the printer is at when the toolpath starts; updated to where
   *                             it is when the toolpath ends. Defaults to the tool the start G-code picked.
   * @returns {string} The generated foam toolpath G-code. Empty if the toolpath is empty.
   */
  public generate_foam_gcode(
    toolpath: PathPoint[],
    state: EmitterState = this.createEmitterState(),
  ) : string {
    if (toolpath.length === 0) {
      return "";
    }

    let body_gcode: string[] = [];

    let firstPoint = toolpath[0].point.clone();
    let lastTarget: THREE.Vector3 = firstPoint;

    body_gcode.push(`G0 F2880 X${firstPoint.x.toFixed(4)} Y${firstPoint.y.toFixed(4)} Z${firstPoint.z.toFixed(4)}; move to start point`);
    body_gcode.push("M205 X8 Y8; tune down acceleration");

    for (let i = 0; i < toolpath.length; i++) {
      const point = toolpath[i];
      const currentPoint = point.point.clone();
      if (i > 0 && toolpath[i - 1].role === 'purgeLine' && point.role !== 'purgeLine') {
        body_gcode.push(`G0 Z${(lastTarget.z + PURGE_LINE_LIFT).toFixed(4)} F2400 ; lift off the purge line`);
      }
      if(point.debug !== undefined){
        body_gcode.push("; DEBUG: " + point.debug);
      }
      // Note the !== undefined: extruder 0 is falsy, so a truthiness check would never pick tool 0.
      if (point.extruder !== undefined && point.extruder !== state.extruder) {
        this.requireExtruder(point.extruder);
        let materialNote: string | undefined;
        if (!this.multipleToolheads) {
          // The one nozzle is getting a different material, so what was loaded before is gone.
          const upcoming = this.upcomingInitialMaterial(toolpath, i);
          materialNote = upcoming === undefined ? undefined : (upcoming ? "initial-layer material" : "main material");
          state.initialMaterialLoaded.clear();
          if (upcoming !== undefined) {
            state.initialMaterialLoaded.set(0, upcoming);
          }
        }
        body_gcode.push(this.switchExtruder(point.extruder, state.extruder, materialNote));
        state.extruder = point.extruder;
      }

      const extruder = state.extruder ?? 0;

      if (point.initialMaterial !== undefined) {
        // Tracked per tool for the whole print, so a second island's initial layers find out that
        // the main material is still loaded from the first island and ask for a swap back.
        const tool = this.multipleToolheads ? extruder : 0;
        const loaded = state.initialMaterialLoaded.get(tool);
        if (loaded !== undefined && loaded !== point.initialMaterial) {
          body_gcode.push(this.swapInitialMaterial(point.initialMaterial, extruder));
        }
        state.initialMaterialLoaded.set(tool, point.initialMaterial);
      }

      if (point.pause) {
        body_gcode.push(
          `\nG0 X${0} Y${this.machine_depth_y} Z50 ; present bed for pause\nM0; pause and wait for user to resume\n`
        )
      }

      if (point.preGcode?.length && !this.testSweep) {
        body_gcode.push(...point.preGcode);
      }

      if (point.extrusion !== undefined && (point.regularSegment || point.travel) && !this.testSweep) {
        // An outside slicer already worked out how much filament this move feeds; copy it as is.
        const speed = point.speed ?? this.requireExtruder(extruder).printHead_speed_when_free_move;
        body_gcode.push(
          `G1 X${currentPoint.x.toFixed(6)} Y${currentPoint.y.toFixed(6)} Z${currentPoint.z.toFixed(6)} E${point.extrusion.toFixed(6)} F${speed}`
        );
      } else if (point.ironing && !this.testSweep) {
        body_gcode.push(
          this.extrudeRegularSegment(lastTarget, currentPoint, extruder, IRONING_FLOW, IRONING_SPEED, point.layerHeight)
        );
      } else if (point.regularSegment && !this.testSweep) {
        body_gcode.push(
          // point.speed is undefined for every toolpath that does not set it, which keeps the
          // extruder's travel speed as the default.
          this.extrudeRegularSegment(lastTarget, currentPoint, extruder, 1, point.speed, point.layerHeight)
        );
      } else if (point.travel || this.testSweep) {
        body_gcode.push(
          point.speed !== undefined && !this.testSweep
            ? `G0 X${currentPoint.x.toFixed(6)} Y${currentPoint.y.toFixed(6)} Z${currentPoint.z.toFixed(6)} F${point.speed}`
            : this.moveToPosition(currentPoint, extruder)
        );
      } else {
        if (point.vStar === undefined || point.hStar === undefined || point.edot === undefined) {
          throw new Error(`Toolpath point ${i} is a foam extrusion but is missing V*, H* or Edot.`);
        }
        // Use the point's own V* and Edot without writing them back into globalVTPSettings:
        // chunks may share that object, and overwriting it left the last point's values behind.
        const line = this.extrudeSingleSegment(lastTarget, currentPoint, point.vStar, point.edot, extruder);
        body_gcode.push(
          `${line} ; V*=${point.vStar.toFixed(4)} H*=${point.hStar.toFixed(4)} deltaZ=${point.deltaZ?.toFixed(4) ?? this.globalVTPSettings.deltaZ.toFixed(4)} deltaL=${point.deltaL?.toFixed(4) ?? 'N/A'} Edot=${point.edot.toFixed(4)}`
        );
      }

      lastTarget = currentPoint;
    }

    body_gcode.push("G92 E0");
    if (state.extruder !== null) {
      this.activeExtruder = state.extruder;
    }

    return body_gcode.join("\n");
  }


  /**
   * Computes the Euclidean distance between two THREE.Vector3 points.
   *
   * @param {THREE.Vector3} p1 - The first point.
   * @param {THREE.Vector3} p0 - The second point.
   * @returns {number} The distance between p1 and p0.
   */
  public norm(p1: THREE.Vector3, p0: THREE.Vector3): number {
    return Math.sqrt(
      (p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2 + (p1.z - p0.z) ** 2
    );
  }
}