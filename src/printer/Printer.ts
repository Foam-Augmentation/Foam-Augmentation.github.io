import * as THREE from 'three';
import { generateBoundaryContours } from "../visualizer/utils/TreeSlicer";
import { ToolpathConfig } from "../visualizer/types/modelTypes";
import { PathPoint } from "../visualizer/toolpath/generateFoamToolpath";
import Visualizer from "../visualizer/Visualizer";


/**
 * Printer class is used to generate G-code for a 3D printer,
 * including generating base (boundary) G-code and foam toolpath G-code.
 */
export default class Printer {
  /** Current cumulative extruded amount */
  public extrudedAmount: number;
  /** Nozzle diameter (in mm) */
  public nozzleDiameter: number;
  public nozzleLength: number;
  /** Die swelling factor */
  public dieSwelling: number;
  /** Print head speed during free movement */
  public printHead_speed_when_free_move: number;
  /** Material bed temperature */
  public material_bed_temperature: number;
  /** Left extruder temperature (for TPU) */
  public print_temp_left_extruder: number;
  /** Right extruder temperature (for PLA) */
  public print_temp_right_extruder: number;
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
  /** End G-code string */
  public end_gcode: string;

  public diameter_filament: number;

  public V_Star: number;
  public vStarEnd: number;

  public Edot: number;

  public deltaZ: number; // deltaZ (thickness of a single foam layer)

  public ZOffset: number; // zOffset (distance between the nozzle and the layer under to allow VTP)
  public H_star: number; // H_star (height of the foam layer)
  public hStarEnd: number;
  public useFermatSpirals: boolean;
  public generateBoundary: boolean;
  public purgeLine: boolean;
  public checkCollisions: boolean;

  public printHeadDims: { min: THREE.Vector2, max: THREE.Vector2 };
  
  public bedLeveling: boolean;
  public testSweep: boolean;

  /**
   * Creates a new Printer instance and initializes default parameters and end G-code.
   */
  constructor() {
    this.extrudedAmount = 0;
    this.nozzleDiameter = 0.4; // nozzle diameter
    this.nozzleLength = 4.5;
    this.dieSwelling = 1.0; // die swelling factor
    this.printHead_speed_when_free_move = 1000; // free move speed
    this.material_bed_temperature = 60; // bed temperature
    this.print_temp_left_extruder = 230; // left extruder temperature (TPU)
    this.print_temp_right_extruder = 260; // right extruder temperature (PLA)
    this.machine_depth = 250; // machine depth (max x)
    this.machine_depth_y = 210; // machine y axis length
    this.machine_height = 220; // machine height (max z)
    // this.boundaryGcode = ""; // initialize boundary G-code
    // this.toolpathGcode = ""; // initialize toolpath G-code
    this.diameter_filament = 1.75;
    this.V_Star = 0.15;
    this.vStarEnd = 0.15;

    this.Edot = 50;
    this.deltaZ = 1.7; // deltaZ (thickness of a single foam layer)
    this.ZOffset = 3.38
    this.H_star = 6.0
    this.hStarEnd = 6.0;
    this.useFermatSpirals = false;
    this.generateBoundary = false;
    this.purgeLine = true;
    this.checkCollisions = false;
    this.printHeadDims = { min: new THREE.Vector2(-40, -15), max: new THREE.Vector2(35, 70) }
    this.bedLeveling = false;
    this.testSweep = false;

    this.end_gcode = `
G4 S5; Dwell for 5 Second(s) 
M104 S0 ; turn off temperature 
M140 S0 ; turn off heatbed 
M107 ; turn off fan 
G91 ; set relative positioning
G1 E-1.0 F1800 ; retract filament slightly
G0 Z10 F5000 ; move print head up 10mm
G90 ; set absolute positioning
G28 X Y ; home x and y
M900 K0 ; reset LA 
M84 ; disable motors 
M73 P100 R0 ; progress to 100%`
  }


  /**
   * Updates the printers parameters.
   * 
   * @param {ToolpathConfig} toolpathConfig The toolpath config to update the parameters to.
   */
  public updateParameters(
    toolpathConfig: ToolpathConfig
  ): void {
    this.deltaZ = toolpathConfig.deltaZ;
    this.V_Star = toolpathConfig.vStar;
    this.H_star = toolpathConfig.hStar;
    this.ZOffset = this.H_star * (this.nozzleDiameter * this.dieSwelling);

    this.Edot = toolpathConfig.edot;
  }


  /**
   * Builds the starting G-code to initialize printer settings.
   *
   * @private
   * @param {number} extruderId - The extruder ID (1 for left extruder, any other value for right extruder).
   * @returns {string} The starting G-code string.
   */
  public build_start_gcode(extruderId: number): string {
    if (extruderId === 1) {
      // Left extruder (TPU)
      //       return `
      // ;Generated with Cura_SteamEngine 5.4.0
      // T0; left extruder
      // M83 ;Set relative extrusion mode
      // ;SV04 start
      // M140 S${this.material_bed_temperature}; set bed temperature and heat
      // M104 S${this.print_temp_left_extruder}; set nozzle temperature and heat
      // M280 P0 S160;
      // G4 P100; pause 100ms
      // G28; home x, y, z
      // M420 S1; enable bed leveling
      // M190 S${this.material_bed_temperature}; wait for bed temperature
      // M109 S${this.print_temp_left_extruder}; wait for nozzle temperature
      // G92 E0; reset extrusion count

      // ; Test print of two segments of lines
      // G1 X10.1 Y20 Z0.28 F5000.0; fast move to position
      // G1 X10.1 Y200.0 Z0.28 F1500.0 E15; print the first segment
      // G1 X10.4 Y200.0 Z0.28 F5000.0; fast move to the second position
      // G1 X10.4 Y20 Z0.28 F1500.0 E30; print the second segment
      // G92 E0 ;Reset Extruder
      // G1 Z2.0 F3000;
      // G92 E0
      // G92 E0
      // G1 F2400 E-0.5

      // ; M106 S255; start fan (if needed)
      // M204 S500; set acceleration
      // M205 X16 Y16; set jerk/acceleration

      // M221 S${this.extrusion_m} ; Set flow percentage
      //       `;
      //     } else {
      //       return `
      // ;Generated with Cura_SteamEngine 5.4.0
      // T1; right extruder
      // M83 ;Set relative extrusion mode
      // ;SV04 start
      // M140 S${this.material_bed_temperature}; set bed temperature and heat
      // M104 S${this.print_temp_right_extruder}; set nozzle temperature and heat
      // M280 P0 S160;
      // G4 P100; pause 100ms
      // G28; home x, y, z
      // M420 S1; enable bed leveling
      // M190 S${this.material_bed_temperature}; wait for bed temperature
      // M109 S${this.print_temp_right_extruder}; wait for nozzle temperature
      // G92 E0; reset extrusion count

      // ; Test print of two segments of lines
      // G1 X10.1 Y20 Z0.28 F5000.0; fast move to position
      // G1 X10.1 Y200.0 Z0.28 F1500.0 E15; print the first segment
      // G1 X10.4 Y200.0 Z0.28 F5000.0; fast move to the second position
      // G1 X10.4 Y20 Z0.28 F1500.0 E30; print the second segment
      // G92 E0 ;Reset Extruder
      // G1 Z2.0 F3000;
      // G92 E0
      // G92 E0
      // G1 F2400 E-0.5

      // ;M106 S255; start fan (if needed)
      // M204 S500; set acceleration
      // M205 X16 Y16; set jerk/acceleration

      // M221 S${this.extrusion_m} ; Set flow percentage
      //       `;

      // matching jupyter notebook
      return `; Parameters:
; V* = ${this.V_Star}
; H* = ${this.H_star}
; Edot (mm/min) = ${this.Edot}
; deltaZ (mm) = ${this.deltaZ}

; Calculated Parameters:
; ZOffset (mm) = ${this.ZOffset.toFixed(6)}
; printHeadSpeed (mm/min) = ${(this.Edot * this.V_Star * (Math.pow(this.diameter_filament, 2) / Math.pow(this.nozzleDiameter * this.dieSwelling, 2))).toFixed(6)}


M201 X9000 Y9000 Z500 E10000 ; sets maximum accelerations, mm/sec^2,
M203 X500 Y500 Z12 E120 ; sets maximum feedrates, mm/sec,
M204 P2000 R1500 T2000 ; sets acceleration (P, T) and retract acceleration (R), mm/sec^2 
M205 X10.00 Y10.00 Z0.20 E4.50 ; sets the jerk limits, mm/sec 
M205 S0 T0 ; sets the minimum extruding and travel feed rate, mm/sec 
M107 ; turns off fan
M862.1 P${this.nozzleDiameter} ; nozzle diameter check 

M104 S${this.testSweep ? 20 : this.print_temp_left_extruder} ; set extruder temp 
M190 S${this.testSweep ? 20 : this.material_bed_temperature} ; set bed temp and wait to reach it
M109 S${this.print_temp_left_extruder} ; wait for extruder temp 
M862.3 P "MK3S" ; printer model check

G28 ; home axes
G92 X0 Y0 ; tell printer all axes are 0
${this.bedLeveling ? "G29" : "M420 S1\n"} ; probe the printbed or use previously stored printbed mesh

G21 ; set units to millimeters 
G90 ; use absolute coordinates 
M83  ; extruder relative mode 
M900 K0.05 ; Filament gcode LA 1.5 
M900 K30 ; Filament gcode LA 1.0 

G1 Z0.200 F2400.000 

M204 S1000 
          
`;
    } else {
      return `; Parameters:
; V* = ${this.V_Star}
; H* = ${this.H_star}
; Edot (mm/min) = ${this.Edot}
; deltaZ (mm) = ${this.deltaZ}

; Calculated Parameters:
; ZOffset (mm) = ${this.ZOffset.toFixed(6)}
; printHeadSpeed (mm/min) = ${(this.Edot * this.V_Star * (Math.pow(this.diameter_filament, 2) / Math.pow(this.nozzleDiameter * this.dieSwelling, 2))).toFixed(6)}

M201 X9000 Y9000 Z500 E10000 ; sets maximum accelerations, mm/sec^2,
M203 X500 Y500 Z12 E120 ; sets maximum feedrates, mm/sec,
M204 P2000 R1500 T2000 ; sets acceleration (P, T) and retract acceleration (R), mm/sec^2 
M205 X10.00 Y10.00 Z0.20 E4.50 ; sets the jerk limits, mm/sec 
M205 S0 T0 ; sets the minimum extruding and travel feed rate, mm/sec 
M107 ; turns off fan
M862.1 P${this.nozzleDiameter} ; nozzle diameter check

M104 S${this.print_temp_left_extruder} ; set extruder temp 
M109 S${this.print_temp_left_extruder} ; wait for extruder temp 
M862.3 P "MK3S" ; printer model check 

G28 ; home axes
G92 X0 Y0 ; tell printer all axes are 0
${this.bedLeveling ? "G29" : "M420 S1\n"} ; probe the printbed or use previously stored printbed mesh

G21 ; set units to millimeters 
G90 ; use absolute coordinates 
M83  ; extruder relative mode 
M900 K0.05 ; Filament gcode LA 1.5 
M900 K30 ; Filament gcode LA 1.0 
G92 E0.0

G1 Z0.200 F2400.000 

M204 S1000 

`;
    }
  }

  /**
   * Generates the G-code command for moving the print head to a target position without extruding.
   *
   * @param {THREE.Vector3} target - The target coordinates.
   * @returns {string} The G-code command for moving to the target position.
   */
  public moveToPosition(target: THREE.Vector3): string {
    return `G0 X${target.x.toFixed(6)} Y${target.y.toFixed(6)} Z${target.z.toFixed(6)} F${this.printHead_speed_when_free_move}`;
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
    const gamma = (Math.PI / 4) * Math.pow(this.dieSwelling * this.nozzleDiameter, 2);

    const S = gamma / (beta * this.V_Star);
    const F = this.Edot / S;

    // Jerry changed this to be multiplied by S instead of multiplied by (extrusion_speed_when_foam / printHead_speed_when_foam))

    this.extrudedAmount = (this.norm(p1Point, p0Point)) * S;
    let gcode = '';

    // if (isFirstInLayer) {
    //   gcode += `G1 X${p0Point.x.toFixed(6)} Y${p0Point.y.toFixed(6)} Z${p0Point.z.toFixed(6)} E0.0050 F0114 ; Move to start of new layer\n`;
    // }

    gcode += `G1 X${p1Point.x.toFixed(6)} Y${p1Point.y.toFixed(6)} Z${p1Point.z.toFixed(6)} E${this.extrudedAmount.toFixed(6)} F0${Math.round(F)}`;

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
    const beadArea = this.dieSwelling * Math.pow(this.nozzleDiameter, 2) / 2;
    const crossSection = Math.PI * Math.pow(this.diameter_filament / 2, 2);
    const filamentPerMM = (beadArea / crossSection) * 2;
    const dist = this.norm(p0, p1);
    const gcode = `G1 X${p1.x.toFixed(6)} Y${p1.y.toFixed(6)} Z${p1.z.toFixed(6)} E${(filamentPerMM * dist).toFixed(6)} F${this.printHead_speed_when_free_move}`;
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

    body_gcode.push(`G0 F2880 X${firstPoint.x.toFixed(4)} Y${firstPoint.y.toFixed(4)} Z${firstPoint.z.toFixed(4)}; move to start point`);
    body_gcode.push("M205 X8 Y8; tune down acceleration");

    for (let i = 0; i < toolpath.length; i++) {
      const point = toolpath[i];
      const currentPoint = point.point.clone();

      if (point.switchFilament) {
        // For now it just switches to 230, but can add option for different nozzle temperatures
        body_gcode.push(
          `\n
M600 ; switch filament to TPU
M104 S${230} ; set extruder temp 
M109 S${230} ; wait for extruder temp\n\n`
        )
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
        this.V_Star = point.vStar!;
        this.H_star = point.hStar!;
        this.Edot = point.edot!;
        this.ZOffset = this.H_star * (this.nozzleDiameter * this.dieSwelling);
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
