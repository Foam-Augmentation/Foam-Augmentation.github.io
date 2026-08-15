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

/**
 * Printer class is used to generate G-code for a 3D printer,
 * including generating base (boundary) G-code and foam toolpath G-code.
 */
export default class Printer {
  /** Current cumulative extruded amount */
  public extrudedAmount: number;
  public material_bed_temperature: number;
  public extruders: Extruder[];
  /** Machine depth (maximum x/y axis length) */
  public machine_depth: number;
  // Machine depth (maximum y axis lenght)
  public machine_depth_y: number;
  /** Machine height (maximum z axis length) */
  public machine_height: number;
  /** Stores the generated boundary G-code */
  // public boundaryGcode: string;
  /** Stores the generated toolpath G-code */
  // public toolpathGcode: string;

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
   * When false, the single toolhead swaps materials with an M600 filament change instead.
   */
  public multipleToolheads: boolean;
  /** Index of the currently active extruder. Drives nozzle geometry for every extrude/move. */
  public activeExtruder: number;
  /** Filament retracted before parking a tool and pushed back after picking one (in mm) */
  public toolchangeRetract: number;

  public purgeTower: boolean;

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
    this.machine_depth = 250; // machine depth (max x)
    this.machine_depth_y = 210; // machine y axis length
    this.machine_height = 220; // machine height (max z)
    // this.boundaryGcode = ""; // initialize boundary G-code
    // this.toolpathGcode = ""; // initialize toolpath G-code
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
    this.bedLeveling = false;
    this.testSweep = false;
    this.multipleToolheads = false;
    this.activeExtruder = 0;
    this.toolchangeRetract = 3.0;
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
   * On a multi-toolhead machine every tool that was picked gets switched off individually and the
   * last one is parked; on a single-head machine the one nozzle is switched off.
   *
   * @param {number[]} usedExtruders The indices of the extruders this print actually used.
   * @returns {string} The ending G-code string.
   */
  public build_end_gcode(usedExtruders: number[]): string {
    const lines: string[] = ["", "G4 S5; Dwell for 5 Second(s)"];

    if (this.multipleToolheads) {
      // Tools never picked were already switched off in the start G-code, so only these are hot.
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

  /**
   * Builds the starting G-code to initialize printer settings.
   *
   * On a multi-toolhead machine every tool the print never picks is switched off, every tool it
   * will pick is brought to its idle temperature so later toolchanges reheat quickly, and the
   * first tool is heated fully and picked. On a single-head machine the one nozzle is simply
   * brought to the first extruder profile's temperature.
   *
   * @param {number} firstExtruder - The index of the extruder the print starts with.
   * @param {number[]} usedExtruders - The indices of every extruder this print will use.
   * @returns {string} The starting G-code string.
   */
  public build_start_gcode(firstExtruder: number, usedExtruders: number[]): string {
    const first = this.extruders[firstExtruder];
    const printTemp = (n: number) => this.testSweep ? 20 : this.extruders[n].print_temp_extruder;
    const bedTemp = this.testSweep ? 20 : this.material_bed_temperature;

    // The caller derives usedExtruders from the toolpath, which may not name the starting tool.
    const used = usedExtruders.indexOf(firstExtruder) !== -1
      ? usedExtruders
      : [firstExtruder, ...usedExtruders];

    let nozzleCheck: string;
    let heaters: string;
    let pickFirstTool = "";

    if (this.multipleToolheads) {
      nozzleCheck = used
        .map(n => `M862.1 T${n} P${this.extruders[n].nozzleDiameter} ; nozzle diameter check`)
        .join("\n");

      const heaterLines: string[] = ["; turn off the toolheads this print never picks"];
      this.extruders.forEach((_, n) => {
        if (used.indexOf(n) === -1) heaterLines.push(`M104 T${n} S0`);
      });

      heaterLines.push("", "; hold the tools we will need at idle so their reheats stay short");
      for (const n of used) {
        if (n !== firstExtruder) {
          heaterLines.push(`M104 T${n} S${this.extruders[n].idle_temp_extruder}`);
        }
      }

      heaterLines.push(
        "",
        `M104 T${firstExtruder} S${printTemp(firstExtruder)} ; set first tool's temp`,
        `M190 S${bedTemp} ; set bed temp and wait to reach it`,
        `M109 T${firstExtruder} S${printTemp(firstExtruder)} ; wait for first tool's temp`
      );
      heaters = heaterLines.join("\n");

      pickFirstTool = `T${firstExtruder} S1 L0 D0 ; pick the first tool\n`;
    } else {
      nozzleCheck = `M862.1 P${first.nozzleDiameter} ; nozzle diameter check`;
      heaters = [
        `M104 S${printTemp(firstExtruder)} ; set extruder temp`,
        `M190 S${bedTemp} ; set bed temp and wait to reach it`,
        `M109 S${printTemp(firstExtruder)} ; wait for extruder temp`
      ].join("\n");
    }

    // Tracks which nozzle geometry the extrusion math should use once the body G-code starts.
    this.activeExtruder = firstExtruder;

      return `; Parameters:
; V* = ${this.globalVTPSettings.V_Star}
; H* = ${this.globalVTPSettings.H_star}
; Edot (mm/min) = ${this.globalVTPSettings.Edot}
; deltaZ (mm) = ${this.globalVTPSettings.deltaZ}

; Calculated Parameters:
; ZOffset (mm) = ${this.globalVTPSettings.ZOffset.toFixed(6)}
; printHeadSpeed (mm/min) = ${(this.globalVTPSettings.Edot * this.globalVTPSettings.V_Star * (Math.pow(this.diameter_filament, 2) / Math.pow(first.nozzleDiameter * first.dieSwelling, 2))).toFixed(6)}


M201 X9000 Y9000 Z500 E10000 ; sets maximum accelerations, mm/sec^2,
M203 X500 Y500 Z12 E120 ; sets maximum feedrates, mm/sec,
M204 P2000 R1500 T2000 ; sets acceleration (P, T) and retract acceleration (R), mm/sec^2
M205 X10.00 Y10.00 Z0.20 E4.50 ; sets the jerk limits, mm/sec
M205 S0 T0 ; sets the minimum extruding and travel feed rate, mm/sec
M107 ; turns off fan
${nozzleCheck}

${heaters}
M862.3 P "${this.multipleToolheads ? "XL" : "MK3S"}" ; printer model check

G28 ; home axes
G92 X0 Y0 ; tell printer all axes are 0
${this.bedLeveling ? "G29" : "M420 S1\n"} ; probe the printbed or use previously stored printbed mesh

G21 ; set units to millimeters
G90 ; use absolute coordinates
M83  ; extruder relative mode
M900 K0.05 ; Filament gcode LA 1.5
M900 K30 ; Filament gcode LA 1.0
${pickFirstTool}
G1 Z0.200 F2400.000

M204 S1000 
          
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
   * Generates the G-code to swap the active toolhead.
   * Retracts and idles the outgoing tool, parks it, then heats and picks the incoming one.
   * Updates {@link activeExtruder} so subsequent moves use the new tool's nozzle geometry.
   *
   * @param {number} to The index of the extruder to pick.
   * @param {number | null} from The index of the currently picked extruder, or null if none is picked.
   * @returns {string} The toolchange G-code.
   */
  public changeTool(to: number, from: number | null): string {
    const lines: string[] = [`\n; Change Tool${from ?? -1} -> Tool${to}`];

    // Start the incoming tool heating now so the M109 below barely blocks.
    lines.push(`M104 S${this.extruders[to].print_temp_extruder} T${to} ; preheat incoming tool`);

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

    //console.log(this.V_Star, this.Edot, this.nozzleDiameter, this.dieSwelling, this.diameter_filament);

    const beta = (Math.PI / 4) * Math.pow(this.diameter_filament, 2);
    //console.log("beta", beta);
    const extruder = this.extruders[this.activeExtruder];
    const gamma = (Math.PI / 4) * Math.pow(extruder.dieSwelling * extruder.nozzleDiameter, 2);
   // console.log("gamnma ",gamma);

    const S = gamma / (beta * this.globalVTPSettings.V_Star);
    //console.log("S ", S);
    const F = this.globalVTPSettings.Edot / S;
    //console.log("F ", F);


    // Jerry changed this to be multiplied by S instead of multiplied by (extrusion_speed_when_foam / printHead_speed_when_foam))

    this.extrudedAmount = (this.norm(p1Point, p0Point)) * S;
    let gcode = '';

    // if (isFirstInLayer) {
    //   gcode += `G1 X${p0Point.x.toFixed(6)} Y${p0Point.y.toFixed(6)} Z${p0Point.z.toFixed(6)} E0.0050 F0114 ; Move to start of new layer\n`;
    // }

    gcode += `G1 X${p1Point.x.toFixed(6)} Y${p1Point.y.toFixed(6)} Z${p1Point.z.toFixed(6)} E${this.extrudedAmount.toFixed(6)} F0${Math.round(F)}`;
   // console.log(`G1 X${p1Point.x.toFixed(6)} Y${p1Point.y.toFixed(6)} Z${p1Point.z.toFixed(6)} E${this.extrudedAmount.toFixed(6)} F0${Math.round(F)}`)
    return gcode;
  }


  /**
   * Extrudes a regular line of filament between two points.
   * The intended layer height of the extrusion is the nozzle diameter / 2 and the
   * intended width of the extrusion is the thread diameter.
   * Currently multiplied by 2 becuase it didn't seem like enough otherwise.
   * 
   * @param {THREE.Vector3} p0 The point the toolhead is coming from
   * @param {THREE.Vector3} p1 The point the toolhead is moving to.
   * @returns  {string} The gcode to print the segment.
   */
  private extrudeRegularSegment(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
  ): string {
    // layer height = nozzleDiameter / 2, extrusion width = nozzle diameter * dieswell
    const extruder = this.extruders[this.activeExtruder];
    const beadArea = extruder.dieSwelling * Math.pow(extruder.nozzleDiameter, 2) / 2;
    const crossSection = Math.PI * Math.pow(this.diameter_filament / 2, 2);
    const filamentPerMM = (beadArea / crossSection) * 2;
    const dist = this.norm(p0, p1);
    const gcode = `G1 X${p1.x.toFixed(6)} Y${p1.y.toFixed(6)} Z${p1.z.toFixed(6)} E${(filamentPerMM * dist).toFixed(6)} F${extruder.printHead_speed_when_free_move}`;
    return gcode;
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

    body_gcode.push(`G0 F2880 X${firstPoint.x.toFixed(4)} Y${firstPoint.y.toFixed(4)} Z${firstPoint.z.toFixed(4)}; move to start point`);
    body_gcode.push("M205 X8 Y8; tune down acceleration");

    

    for (let i = 0; i < toolpath.length; i++) {
      const point = toolpath[i];
      const currentPoint = point.point.clone();
      // Note the !== undefined: extruder 0 is falsy, so a truthiness check would never pick tool 0.
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

      if (point.regularSegment && !this.testSweep) {
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
