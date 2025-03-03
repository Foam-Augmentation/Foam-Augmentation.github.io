import * as THREE from 'three';

/**
 * Printer class is used to generate G-code for a 3D printer,
 * including generating base (boundary) G-code and foam toolpath G-code.
 */
export default class Printer {
  /** Current cumulative extruded amount */
  public extrudedAmount: number;
  /** Nozzle diameter (in mm) */
  public nozzleDiameter: number;
  /** Die swelling factor */
  public dieSwelling: number;
  /** Foam extrusion speed (mm/min) */
  public extrusion_speed_when_foam: number;
  /** Foam interlayer extrusion rate (e.g., 0.07 mm extrusion per 1 mm movement) */
  public extrusion_foam_interlayer_rate: number;
  /** Normal extrusion rate for standard printing */
  public extrusion_norm_rate: number;
  /** Print head speed during free movement */
  public printHead_speed_when_free_move: number;
  /** Print head speed when extruding foam */
  public printHead_speed_when_foam: number;
  /** Print head speed for interlayer moves */
  public printHead_speed_when_interlayer_move: number;
  /** Print head speed during normal printing */
  public printHead_speed_when_normal_print: number;
  /** Material bed temperature */
  public material_bed_temperature: number;
  /** Left extruder temperature (for TPU) */
  public print_temp_left_extruder: number;
  /** Right extruder temperature (for PLA) */
  public print_temp_right_extruder: number;
  /** Machine depth (maximum x/y axis length) */
  public machine_depth: number;
  /** Machine height (maximum z axis length) */
  public machine_height: number;
  /** Stores the generated boundary G-code */
  public boundaryGcode: string;
  /** Stores the generated toolpath G-code */
  public toolpathGcode: string;
  /** End G-code string */
  public end_gcode: string;

  /**
   * Creates a new Printer instance and initializes default parameters and end G-code.
   */
  constructor() {
    this.extrudedAmount = 0;
    this.nozzleDiameter = 0.4; // nozzle diameter
    this.dieSwelling = 1.1; // die swelling factor
    this.extrusion_speed_when_foam = 70; // foam extrusion speed (mm/min)
    this.extrusion_foam_interlayer_rate = 0.2; // foam interlayer extrusion rate (0.07mm per 1mm move)
    this.extrusion_norm_rate = 0.07; // normal extrusion rate
    this.printHead_speed_when_free_move = 1000; // free move speed
    this.printHead_speed_when_foam = 70; // print head speed when extruding foam
    this.printHead_speed_when_interlayer_move = 200; // interlayer move speed for foam
    this.printHead_speed_when_normal_print = 800; // normal printing extrusion speed
    this.material_bed_temperature = 110; // bed temperature
    this.print_temp_left_extruder = 240; // left extruder temperature (TPU)
    this.print_temp_right_extruder = 260; // right extruder temperature (PLA)
    this.machine_depth = 302; // machine depth (max x/y)
    this.machine_height = 402; // machine height (max z)
    this.boundaryGcode = ""; // initialize boundary G-code
    this.toolpathGcode = ""; // initialize toolpath G-code

    this.end_gcode = `
;SV04 end
M107; turn off fan
G91 ;Relative positioning
G1 E-2 F2700 ;Retract a bit
G1 E-2 Z0.2 F2400 ;Retract and raise Z
G1 X0 Y240 F3000 ;Wipe out
G1 Z10 ;Raise Z more
G90 ;Absolute positioning
G1 X0 Y${this.machine_depth} ;Present print
M106 S0 ;Turn-off fan
M104 S0 ;Turn-off hotend
M140 S0 ;Turn-off bed
M84 X Y E ;Disable all steppers except Z
M82 ;Set absolute extrusion mode
        `;
  }

  /**
   * Builds the starting G-code to initialize printer settings.
   *
   * @private
   * @param {number} extruderId - The extruder ID (1 for left extruder, any other value for right extruder).
   * @returns {string} The starting G-code string.
   */
  private build_start_gcode(extruderId: number): string {
    if (extruderId === 1) {
      // Left extruder (TPU)
      return `
;Generated with Cura_SteamEngine 5.4.0
T0; left extruder
M82 ;Set absolute extrusion mode
;SV04 start
M140 S${this.material_bed_temperature}; set bed temperature and heat
M104 S${this.print_temp_left_extruder}; set nozzle temperature and heat
M280 P0 S160;
G4 P100; pause 100ms
G28; home x, y, z
M420 S1; enable bed leveling
M190 S${this.material_bed_temperature}; wait for bed temperature
M109 S${this.print_temp_left_extruder}; wait for nozzle temperature
G92 E0; reset extrusion count

; Test print of two segments of lines
G1 X10.1 Y20 Z0.28 F5000.0; fast move to position
G1 X10.1 Y200.0 Z0.28 F1500.0 E15; print the first segment
G1 X10.4 Y200.0 Z0.28 F5000.0; fast move to the second position
G1 X10.4 Y20 Z0.28 F1500.0 E30; print the second segment
G92 E0 ;Reset Extruder
G1 Z2.0 F3000;
G92 E0
G92 E0
G1 F2400 E-0.5

; M106 S255; start fan (if needed)
M204 S500; set acceleration
M205 X16 Y16; set jerk/acceleration
      `;
    } else {
      return `
;Generated with Cura_SteamEngine 5.4.0
T1; right extruder
M82 ;Set absolute extrusion mode
;SV04 start
M140 S${this.material_bed_temperature}; set bed temperature and heat
M104 S${this.print_temp_right_extruder}; set nozzle temperature and heat
M280 P0 S160;
G4 P100; pause 100ms
G28; home x, y, z
M420 S1; enable bed leveling
M190 S${this.material_bed_temperature}; wait for bed temperature
M109 S${this.print_temp_right_extruder}; wait for nozzle temperature
G92 E0; reset extrusion count

; Test print of two segments of lines
G1 X10.1 Y20 Z0.28 F5000.0; fast move to position
G1 X10.1 Y200.0 Z0.28 F1500.0 E15; print the first segment
G1 X10.4 Y200.0 Z0.28 F5000.0; fast move to the second position
G1 X10.4 Y20 Z0.28 F1500.0 E30; print the second segment
G92 E0 ;Reset Extruder
G1 Z2.0 F3000;
G92 E0
G92 E0
G1 F2400 E-0.5

;M106 S255; start fan (if needed)
M204 S500; set acceleration
M205 X16 Y16; set jerk/acceleration
      `;
    }
  }

  /**
   * Generates the G-code command for moving the print head to a target position.
   *
   * @param {[number, number, number]} target - The target [x, y, z] coordinates.
   * @returns {string} The G-code command for moving to the target position.
   */
  public move_to_position(target: [number, number, number]): string {
    return `G0 X${target[0].toFixed(3)} Y${target[1].toFixed(3)} Z${target[2].toFixed(3)} F${this.printHead_speed_when_free_move}`;
  }

  /**
   * Generates the G-code for extruding a single segment between two points
   * while updating the extruded amount.
   *
   * @private
   * @param {THREE.Vector3} p0 - The starting point.
   * @param {THREE.Vector3} p1 - The ending point.
   * @param {number} extrusion_speed_when_foam - The foam extrusion speed.
   * @param {number} printHead_speed_when_foam - The print head speed when extruding foam.
   * @returns {string} The G-code command for the extrusion segment.
   */
  private extrude_single_segment(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    extrusion_speed_when_foam: number,
    printHead_speed_when_foam: number
  ): string {
    this.extrudedAmount += this.norm(p1, p0) * (extrusion_speed_when_foam / printHead_speed_when_foam);
    return `G1 X${p1.x.toFixed(4)} Y${p1.y.toFixed(4)} Z${p1.z.toFixed(4)} E${this.extrudedAmount.toFixed(4)} F${printHead_speed_when_foam}`;
  }

  /**
   * Generates the base (boundary) G-code based on the bottom boundary of the model.
   * This is intended for PLA printing.
   *
   * @param {THREE.Vector3[]} constrainBounding - An array of at least 4 points defining the bottom boundary.
   * @param {number} [offset=0.2] - The offset distance to expand the bounding box.
   * @param {number} [extruderId=2] - The extruder ID (1 for left, otherwise right).
   * @param {number} [layerHeight=0.2] - The Z height for the base layer.
   * @returns {string} The generated base G-code.
   */
  public generate_base_constraints(
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
        this.extrude_single_segment(
          corners[i],
          corners[i + 1],
          this.extrusion_norm_rate,
          this.printHead_speed_when_normal_print
        )
      );
    }

    body_gcode.push("G92 E0");
    this.extrudedAmount = 0;

    this.boundaryGcode =
      this.build_start_gcode(extruderId) +
      "\n\n" +
      body_gcode.join("\n") +
      "\n\n" +
      this.end_gcode;
    return this.boundaryGcode;
  }

  /**
   * Generates foam toolpath G-code from a given toolpath.
   *
   * @param {THREE.Vector3[][]} toolpath - A two-dimensional array of points where each sub-array represents a layer of the toolpath.
   * @param {number} extruderId - The extruder ID (1 for left, otherwise right).
   * @returns {string} The generated foam toolpath G-code.
   */
  public generate_foam_gcode(toolpath: THREE.Vector3[][], extruderId: number): string {

    if (toolpath.length === 0 || toolpath[0].length === 0) {
      console.error("Toolpath is empty.");
      return "";
    }

    let body_gcode: string[] = [];
    let lastTarget: THREE.Vector3 = toolpath[0][0];
    this.extrudedAmount = 0;

    for (let i = 0; i < toolpath.length; i++) {
      if (i === 0) {
        body_gcode.push(
          `G0 F2880 X${toolpath[i][0].x} Y${toolpath[i][0].y} Z${toolpath[i][0].z}; move to start point`
        );
        body_gcode.push("M205 X8 Y8; tune down acceleration");
        body_gcode.push("G1 F2400 E0; not sure the purpose of this line");
      } else {
        body_gcode.push(
          this.extrude_single_segment(
            lastTarget,
            toolpath[i][0],
            this.extrusion_foam_interlayer_rate,
            this.printHead_speed_when_interlayer_move
          )
        );
      }
      lastTarget = toolpath[i][0];

      for (let j = 1; j < toolpath[i].length; j++) {
        body_gcode.push(
          this.extrude_single_segment(
            lastTarget,
            toolpath[i][j],
            this.extrusion_speed_when_foam,
            this.printHead_speed_when_foam
          )
        );
        lastTarget = toolpath[i][j];
      }
    }

    body_gcode.push("G92 E0");
    this.extrudedAmount = 0;

    this.toolpathGcode =
      this.build_start_gcode(extruderId) +
      "\n\n" +
      body_gcode.join("\n") +
      "\n\n" +
      this.end_gcode;
    return this.toolpathGcode;
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
