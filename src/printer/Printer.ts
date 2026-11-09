import * as THREE from 'three';
import { generateBoundaryContours } from "../visualizer/utils/TreeSlicer";
import { ToolpathConfig } from "../visualizer/types/modelTypes";
import { PathPoint } from "../visualizer/toolpath/generateFoamToolpath";
import Visualizer from "../visualizer/Visualizer";

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
    color: 0x00ff00
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
 * Printer class is used to generate G-code for a 3D printer,
 * including generating base (boundary) G-code and foam toolpath G-code.
 */
export default class Printer {
  /** Current cumulative extruded amount */
  public extrudedAmount: number;
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
  /** Index of the currently active extruder. Drives nozzle geometry for every extrude/move. */
  public activeExtruder: number;
  /** Filament retracted before parking a tool and pushed back after picking one (in mm) */
  public toolchangeRetract: number;

  public purgeTower: boolean;

  public mblTemp: number;
  public toolchangeZHop: number;
  public toolchangeTravelSpeed: number;
  /** Index = G-code tool, value = physical toolhead. Undefined = no remapping. */
  public toolMapping?: number[];

  /**
   * Creates a new Printer instance and initializes default parameters and end G-code.
   */
  constructor() {
    this.extrudedAmount = 0;
    this.material_bed_temperature = 60; // bed temperature
    this.extruders = [
      {// TPU extruder
        nozzleDiameter: 0.4,
        nozzleLength: 4.5,
        dieSwelling: 1.0,
        printHead_speed_when_free_move: 1000,
        print_temp_extruder: 230,
        idle_temp_extruder: 70,
        color: 0x00FF00
      },
      {//conductive TPU extruder
        nozzleDiameter: 0.4,
        nozzleLength: 4.5,
        dieSwelling: 1.0,
        printHead_speed_when_free_move: 1000,
        print_temp_extruder: 240,
        idle_temp_extruder: 70,
        color: 0xFF0000
      }
    ];
    this.purgeTower = true;
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
    this.globalVTPSettings.ZOffset = this.globalVTPSettings.H_star * (this.extruders[0].nozzleDiameter * this.extruders[0].dieSwelling);
    this.globalVTPSettings.hStarEnd = toolpathConfig.hStarEnd;
    this.globalVTPSettings.vStarEnd = toolpathConfig.vStarEnd;
    this.globalVTPSettings.Edot = toolpathConfig.edot;

    this.senseVTPSettings.deltaZ = toolpathConfig.senseDeltaZ;
    this.senseVTPSettings.V_Star = toolpathConfig.senseVStar;
    this.senseVTPSettings.H_star = toolpathConfig.senseHStar;
    this.senseVTPSettings.deltaL = toolpathConfig.senseDeltaL;
    this.senseVTPSettings.deltaLEnd = toolpathConfig.senseDeltaLEnd;
    this.senseVTPSettings.ZOffset = this.senseVTPSettings.H_star * (this.extruders[0].nozzleDiameter * this.extruders[0].dieSwelling);
    this.senseVTPSettings.hStarEnd = toolpathConfig.senseHStarEnd;
    this.senseVTPSettings.vStarEnd = toolpathConfig.SenseVStarEnd;
    this.senseVTPSettings.Edot = toolpathConfig.senseEdot;
  }

  /**
   * Builds the ending G-code that shuts the printer down after a print.
   *
   * @param {number[]} usedExtruders The indices of the extruders this print actually used.
   * @returns {string} The ending G-code string.
   */
  public build_end_gcode(usedExtruders: number[]): string {
    const lines: string[] = ["", "G4 S5; Dwell for 5 Second(s)"];

    if (this.multipleToolheads) {
      for (const n of usedExtruders) {
        lines.push(`M104 T${n} S0 ; turn off tool ${n}`);
      }
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

  public boundsFromToolpath(toolpath: PathPoint[]): FirstLayerBounds | undefined {
    return this.firstLayerBounds(
      toolpath.filter(p => !p.travel).map(p => ({ x: p.point.x, y: p.point.y, z: p.point.z }))
    );
  }

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
    const first = this.extruders[firstExtruder];
    const printTemp = (n: number) => this.testSweep ? 20 : this.extruders[n].print_temp_extruder;
    const bedTemp = this.testSweep ? 20 : this.material_bed_temperature;
    const mbl = this.testSweep ? 20 : this.mblTemp;
    const bedX = this.machine_depth;
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
        `M104 T${t} S${printTemp(t)}`,
        `M109 T${t} S${printTemp(t)}`,
        `T${t} S1 L0 D0`
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
        `M104 S${printTemp(firstExtruder)}`,
        `M109 S${printTemp(firstExtruder)}`
      ].join("\n");
    }

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
   * @returns {string} The G-code performing the switch.
   */
  public switchExtruder(to: number, from: number | null): string {
    return this.multipleToolheads
      ? this.changeTool(to, from)
      : this.changeFilament(to);
  }

  /**
   * Generates the G-code to swap materials on a single toolhead, pausing for the user to
   * physically change the filament and then bringing the nozzle to the new material's temperature.
   *
   * @param {number} to The index of the extruder profile whose material is being loaded.
   * @returns {string} The filament change G-code.
   */
  public changeFilament(to: number): string {
    const temp = this.extruders[to].print_temp_extruder;

    this.activeExtruder = to;

    return [
      `\n; Change filament to extruder ${to}'s material`,
      "M600 ; pause and prompt the user to swap filament",
      `M104 S${temp} ; set extruder temp`,
      `M109 S${temp} ; wait for extruder temp`,
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

    // Start the incoming tool heating now so the M109 below barely blocks.
    lines.push(`M104 S${this.extruders[to].print_temp_extruder} T${to} ; preheat incoming tool`);
    lines.push(`G1 F${this.toolchangeTravelSpeed}`);

    if (from !== null) {
      lines.push(`G1 E-${this.toolchangeRetract.toFixed(4)} F2100 ; retract before park`);
      lines.push(`M104 S${this.extruders[from].idle_temp_extruder} T${from} ; idle outgoing tool`);
      lines.push("P0 S1 L2 D0 ; park the currently-picked tool");
    }

    lines.push(`M109 S${this.extruders[to].print_temp_extruder} T${to} ; wait for incoming tool's temp`);
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
   * @returns {string} The G-code command for moving to the target position.
   */
  public moveToPosition(target: THREE.Vector3): string {
    return `G0 X${target.x.toFixed(6)} Y${target.y.toFixed(6)} Z${target.z.toFixed(6)} F${this.extruders[this.activeExtruder].printHead_speed_when_free_move}`;
  }

  /**
   * Generates the G-code for extruding a single segment between two points
   * while updating the extruded amount.
   *
   * @private
   * @param {THREE.Vector3} p0 - The starting point.
   * @param {THREE.Vector3} p1 - The ending point.
   * @returns {string} The G-code command for the extrusion segment.
   */
  private extrudeSingleSegment(
    p0: THREE.Vector3 | { point: THREE.Vector3; type: string },
    p1: THREE.Vector3 | { point: THREE.Vector3; type: string },
  ): string {
    // Extract Vector3 points regardless of input type
    const p0Point = (p0 instanceof THREE.Vector3) ? p0 : p0.point;
    const p1Point = (p1 instanceof THREE.Vector3) ? p1 : p1.point;

    const beta = (Math.PI / 4) * Math.pow(this.diameter_filament, 2);
    const extruder = this.extruders[this.activeExtruder];
    const gamma = (Math.PI / 4) * Math.pow(extruder.dieSwelling * extruder.nozzleDiameter, 2);

    const S = gamma / (beta * this.globalVTPSettings.V_Star);
    const F = this.globalVTPSettings.Edot / S;

    // Jerry changed this to be multiplied by S instead of multiplied by (extrusion_speed_when_foam / printHead_speed_when_foam))
    this.extrudedAmount = (this.norm(p1Point, p0Point)) * S;
    let gcode = '';

    gcode += `G1 X${p1Point.x.toFixed(6)} Y${p1Point.y.toFixed(6)} Z${p1Point.z.toFixed(6)} E${this.extrudedAmount.toFixed(6)} F0${Math.round(F)}`;
    return gcode;
  }


  /**
   * Extrudes a regular line of filament between two points.
   * The intended layer height of the extrusion is the nozzle diameter / 2 and the
   * intended width of the extrusion is the thread diameter.
   * 
   * @param {THREE.Vector3} p0 The point the toolhead is coming from
   * @param {THREE.Vector3} p1 The point the toolhead is moving to.
   * @returns  {string} The gcode to print the segment.
   */
  private extrudeRegularSegment(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    flow: number = 1,
    speed?: number,
  ): string {
    // layer height = nozzleDiameter / 2, extrusion width = nozzle diameter * dieswell
    const extruder = this.extruders[this.activeExtruder];
    const beadArea = extruder.dieSwelling * Math.pow(extruder.nozzleDiameter, 2) / 2;
    const crossSection = Math.PI * Math.pow(this.diameter_filament / 2, 2);
    const filamentPerMM = (beadArea / crossSection) ;
    const dist = this.norm(p0, p1);
    const gcode = `G1 X${p1.x.toFixed(6)} Y${p1.y.toFixed(6)} Z${p1.z.toFixed(6)} E${(flow * filamentPerMM * dist).toFixed(6)} F${speed ?? extruder.printHead_speed_when_free_move}`;
    return gcode;
  }

  /**
   * Extrudes an ironing segment between two points: 20% of the regular flow at 25 mm/s.
   *
   * @param {THREE.Vector3} p0 The point the toolhead is coming from
   * @param {THREE.Vector3} p1 The point the toolhead is moving to.
   * @returns {string} The gcode to iron the segment.
   */
  private extrudeIroningSegment(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
  ): string {
    return this.extrudeRegularSegment(p0, p1, 0.2, 1500);
  }


  /**
   * Generates the base (boundary) G-code based on the bottom boundary of the model.
   * This prints a rectangular bounding box.
   * This is intended for PLA printing.
   *
   * @param {THREE.Vector3[]} constrainBounding - An array of at least 4 points defining the bottom boundary.
   * @param {number} [offset=0.2] - The offset distance to expand the bounding box.
   * @param {number} [extruderId=2] - The extruder ID (1 for left, otherwise right).
   * @param {number} [layerHeight=0.2] - The Z height for the base layer.
   * @returns {string} The generated base G-code.
   */
  public generateBaseConstraints(
    constrainBounding: THREE.Vector3[],
    offset: number = 0.2,
    extruderId: number = 2,
    layerHeight: number = 0.2
  ): string {
    if (constrainBounding.length < 4) {
      console.error("ConstrainBounding does not have enough points to define a rectangle.");
      return "";
    }
    const minX = Math.min(...constrainBounding.map(p => p.x)) - offset;
    const maxX = Math.max(...constrainBounding.map(p => p.x)) + offset;
    const minY = Math.min(...constrainBounding.map(p => p.y)) - offset;
    const maxY = Math.max(...constrainBounding.map(p => p.y)) + offset;

    const corners: THREE.Vector3[] = [
      new THREE.Vector3(minX, minY, layerHeight), // Bottom Left
      new THREE.Vector3(minX, maxY, layerHeight), // Top Left
      new THREE.Vector3(maxX, maxY, layerHeight), // Top Right
      new THREE.Vector3(maxX, minY, layerHeight), // Bottom Right
      new THREE.Vector3(minX, minY, layerHeight)  // Close loop back to Bottom Left
    ];

    let body_gcode: string[] = [];
    this.extrudedAmount = 0;

    body_gcode.push(
      `G0 F2880 X${corners[0].x} Y${corners[0].y} Z${corners[0].z}; move to start point`
    );
    body_gcode.push("M205 X8 Y8; tune down acceleration");
    body_gcode.push("G1 F2400 E0; not sure the purpose of this line");

    for (let i = 0; i < corners.length - 1; i++) {
      body_gcode.push(
        this.extrudeSingleSegment(
          corners[i],
          corners[i + 1],
        )
      );
    }

    body_gcode.push("G92 E0");
    this.extrudedAmount = 0;

    return body_gcode.join("\n");
  }


    /**
   * Generates foam toolpath G-code from a given toolpath.
   *
   * @param {PathPoint[]} toolpath The points to turn into gcode in order with correct properties.
   *                               Any point that isn't a travel movement or regular segment should have
   *                               hStar, vStar, and edot among their properties.
   * @returns {string} The generated foam toolpath G-code.
   */
  public generate_foam_gcode(
    toolpath: PathPoint[]
  ) : string {
    if (toolpath.length === 0) {
      console.error("Toolpath is empty.");
      return "";
    }

    let body_gcode: string[] = [];

    let firstPoint = toolpath[0].point.clone();
    let lastTarget: THREE.Vector3 = firstPoint;
    // Seeded from the tool the start G-code already picked, so we don't emit a redundant
    // toolchange for the first point.
    let extruder: number | null = this.activeExtruder;
    let purgeDone = !this.purgeLine;

    body_gcode.push(`G0 F2880 X${firstPoint.x.toFixed(4)} Y${firstPoint.y.toFixed(4)} Z${firstPoint.z.toFixed(4)}; move to start point`);
    body_gcode.push("M205 X8 Y8; tune down acceleration");

    for (let i = 0; i < toolpath.length; i++) {
      const point = toolpath[i];
      const currentPoint = point.point.clone();
      if (!purgeDone && i > 0 && !point.regularSegment) {
        purgeDone = true;
        body_gcode.push(`G0 Z${(lastTarget.z + 2).toFixed(4)} F2400 ; lift off the purge line`);
      }
      // Note the !== undefined: extruder 0 is falsy, so a truthiness check would never pick tool 0.
      if(point.debug !== undefined){
        body_gcode.push("; DEBUG: " + point.debug);
      }
      if (point.extruder !== undefined && point.extruder !== extruder) {
        body_gcode.push(this.switchExtruder(point.extruder, extruder));
        extruder = point.extruder;
      }

      if (point.switchFilament) {
        let to = this.activeExtruder == 0 ? 1 : 0;
        body_gcode.push(this.changeFilament(to));
      }

      if (point.pause) {
        body_gcode.push(
          `\nG0 X${0} Y${this.machine_depth_y} Z50 ; present bed for pause\nM0; pause and wait for user to resume\n`
        )
      }

      if (point.ironing && !this.testSweep) {
        body_gcode.push(
          this.extrudeIroningSegment(
            lastTarget,
            currentPoint
          )
        );
      } else if (point.regularSegment && !this.testSweep) {
        body_gcode.push(
          this.extrudeRegularSegment(
            lastTarget, 
            currentPoint
          )
        );
      } else if (point.travel || this.testSweep) {
        body_gcode.push(
          this.moveToPosition(currentPoint)
        );
      } else {
        this.globalVTPSettings.V_Star = point.vStar!;
        this.globalVTPSettings.H_star = point.hStar!;
        this.globalVTPSettings.Edot = point.edot!;
        this.globalVTPSettings.ZOffset = this.globalVTPSettings.H_star * (this.extruders[this.activeExtruder].nozzleDiameter * this.extruders[this.activeExtruder].dieSwelling);
        body_gcode.push(
          this.extrudeSingleSegment(
            lastTarget,
            currentPoint
          )
        );
      }

      lastTarget = currentPoint;
    }

    body_gcode.push("G92 E0");
    this.extrudedAmount = 0;

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