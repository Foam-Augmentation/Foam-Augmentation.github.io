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
  public boundaryGcode: string;
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
    this.boundaryGcode = ""; // initialize boundary G-code
    // this.toolpathGcode = ""; // initialize toolpath G-code
    this.diameter_filament = 1.75;
    this.V_Star = 0.15;
    this.vStarEnd = 0.15;

    this.Edot = 35;
    this.deltaZ = 1.7; // deltaZ (thickness of a single foam layer)
    this.ZOffset = 3.38
    this.H_star = 6.0
    this.hStarEnd = 6.0;
    this.useFermatSpirals = false;
    this.generateBoundary = false;
    this.purgeLine = true;
    this.checkCollisions = false;
    this.printHeadDims = { min: new THREE.Vector2(-40, -15), max: new THREE.Vector2(35, 70) }

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


  public updateParameters(
    toolpathConfig: ToolpathConfig
  ): void {
    this.deltaZ = toolpathConfig.deltaZ;
    this.V_Star = toolpathConfig.vStar;
    this.H_star = toolpathConfig.hStar;
    this.ZOffset = this.H_star * (this.nozzleDiameter * this.dieSwelling);

    this.Edot = toolpathConfig.edot;
  }

  // public updateVisualizerParameters(
  //   config: Visualizer["config"]
  // ): void {
  //   this.nozzleDiameter = config.nozzleDiameter;
  //   this.nozzleLength = config.nozzleLength;
  //   this.dieSwelling = config.dieSwelling;
  //   this.material_bed_temperature = config.bedTemp;
  //   this.print_temp_left_extruder = config.nozzleLeftTemp;
  //   this.print_temp_right_extruder = config.nozzleRightTemp;
  //   this.machine_depth = config.machineDepth;
  //   this.machine_depth_y = config.machineDepthY;
  //   this.machine_height = config.machineHeight;
  //   this.checkCollisions = config.checkCollisions;
  //   this.useFermatSpirals = config.useFermatSpirals;
  //   this.diameter_filament = config.filamentDiameter;
  //   this.printHeadDims = {min: new THREE.Vector2(config.printHeadMinX, config.printHeadMinY), 
  //                         max: new THREE.Vector2(config.printHeadMaxX, config.printHeadMaxY)},
  //   this.purgeLine = config.purgeLine;
  //   this.generateBoundary = config.generateBoundary;
  // }

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


M104 S${this.print_temp_left_extruder} ; set extruder temp 
M190 S${this.material_bed_temperature} ; set bed temp and wait to reach it
M109 S${this.print_temp_left_extruder} ; wait for extruder temp 
M862.3 P "MK3S" ; printer model check

G28 ; home axes
G92 X0 Y0 ; tell printer all axes are 0

G21 ; set units to millimeters 
G90 ; use absolute coordinates 
M83  ; extruder relative mode 
M900 K0.05 ; Filament gcode LA 1.5 
M900 K30 ; Filament gcode LA 1.0 
G92 E0.0 

G1 Z0.200 F2400.000 

M204 S1000 
          
`  + (this.purgeLine ? "G0 X5 Y5 Z0.2 F1000\n" + this.extrude_regular_segment(new THREE.Vector3(5, 5, 0.1), new THREE.Vector3(this.machine_depth - 5, 5, 0.1)) : "");
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

G21 ; set units to millimeters 
G90 ; use absolute coordinates 
M83  ; extruder relative mode 
M900 K0.05 ; Filament gcode LA 1.5 
M900 K30 ; Filament gcode LA 1.0 
G92 E0.0

G1 Z0.200 F2400.000 

M204 S1000 

`  + (this.purgeLine ? "G0 X5 Y5 Z0.2 F1000\n" + this.extrude_regular_segment(new THREE.Vector3(5, 5, 0.1), new THREE.Vector3(this.machine_depth - 5, 5, 0.1)) : "");
    }
  }

  /**
   * Generates the G-code command for moving the print head to a target position.
   *
   * @param {[number, number, number]} target - The target [x, y, z] coordinates.
   * @returns {string} The G-code command for moving to the target position.
   */
  public move_to_position(target: THREE.Vector3): string {
    return `G0 X${target.x.toFixed(6)} Y${target.y.toFixed(6)} Z${target.z.toFixed(6)} F${this.printHead_speed_when_free_move}`;
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
    p0: THREE.Vector3 | { point: THREE.Vector3; type: string },
    p1: THREE.Vector3 | { point: THREE.Vector3; type: string },
    isFirstInLayer: boolean = false,
    extrude: boolean = true,
  ): string {
    // Extract Vector3 points regardless of input type
    const p0Point = (p0 instanceof THREE.Vector3) ? p0 : p0.point;
    const p1Point = (p1 instanceof THREE.Vector3) ? p1 : p1.point;

    const beta = (Math.PI / 4) * Math.pow(this.diameter_filament, 2);
    const gamma = (Math.PI / 4) * Math.pow(this.dieSwelling * this.nozzleDiameter, 2);

    const S = gamma / (beta * this.V_Star);
    const F = this.Edot / S;

    // console.log("📌 Extruding segment: ", { p0Point, p1Point });
    // Jerry changed this to be multiplied by S instead of multiplied by (extrusion_speed_when_foam / printHead_speed_when_foam))

    this.extrudedAmount = (this.norm(p1Point, p0Point)) * S;
    let gcode = '';

    if (isFirstInLayer) {
      gcode += `G1 X${p0Point.x.toFixed(6)} Y${p0Point.y.toFixed(6)} Z${p0Point.z.toFixed(6)} E0.0050 F0114 ; Move to start of new layer\n`;
    }

    gcode += `G1 X${p1Point.x.toFixed(6)} Y${p1Point.y.toFixed(6)} Z${p1Point.z.toFixed(6)} E${extrude ? this.extrudedAmount.toFixed(6) : 0} F0${Math.round(F)}`;

    return gcode;
  }


  private extrude_regular_segment(
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
   * Generates the gcode for a brim around the bottom of a mesh.
   * 
   * @param {THREE.Mesh} mesh - The mesh to get the brim of.
   * @param {number} offset - How far away the brim should be from the mesh.
   * @returns {string} The gcode as a string.
   */
  public generate_boundary_gcode(
    meshs: THREE.Mesh[],
    offset: number = 1,
  ): string {
    const contours: THREE.Vector3[][] = [];
    meshs.forEach(mesh => {
      mesh.geometry.scale(mesh.scale.x, mesh.scale.y, mesh.scale.z);
      mesh.scale.setScalar(1);
      const e = new THREE.Euler(
          mesh.rotation.x,
          mesh.rotation.y,
          mesh.rotation.z,
          'XYZ'
      );
      const q = new THREE.Quaternion().setFromEuler(e);
      mesh.geometry.applyQuaternion(q);
      mesh.rotation.set(0, 0, 0);
    });

    meshs.forEach(mesh => {
      const expandedContours = generateBoundaryContours(mesh, offset);
      expandedContours.forEach(contour => contour.forEach(point => point.setZ(point.z)));
      contours.push(...expandedContours);
    })

    let boundaryGcode: string[] = [];

    // create gcode for following the expanded contours
    for (const expandedContour of contours) {
      const firstPoint = expandedContour[0];
      boundaryGcode.push(`G0 X${firstPoint.x.toFixed(6)} Y${firstPoint.y.toFixed(6)} Z${firstPoint.z.toFixed(6)}
                          F${this.printHead_speed_when_free_move}`) // move to first point in contour
      for (let i = 0; i < expandedContour.length; i++) {
        const nextPoint = i + 1 >= expandedContour.length ? expandedContour[i + 1 - expandedContour.length] : expandedContour[i + 1];
        const point = expandedContour[i];
        boundaryGcode.push(
          this.extrude_regular_segment(
            point,
            nextPoint
          )
        );
      }
    }

    this.boundaryGcode = boundaryGcode.join("\n") + "\n\nG0 X0 Y0 Z20 ; park for pause\nM0 ; wait for user to press start again\n";

    return this.boundaryGcode;
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
        )
      );

    }

    body_gcode.push("G92 E0");
    this.extrudedAmount = 0;

    this.boundaryGcode = body_gcode.join("\n");
    return this.boundaryGcode;
  }

  /**
   * Generates foam toolpath G-code from a given toolpath.
   *
   * @param {THREE.Vector3[][]} toolpath - A two-dimensional array of points where each sub-array represents a layer of the toolpath.
   * @param {number} extruderId - The extruder ID (1 for left, otherwise right).
   * @returns {string} The generated foam toolpath G-code.
   */
  // public generate_foam_gcode(
  //   toolpath: PathPoint[],
  //   extruderId: number,
  //   modelPosition: THREE.Vector3 = new THREE.Vector3(0, 0, 0)
  // )
  public generate_foam_gcode(toolpath: any, extruderId: number, includeStart: boolean = true)
    : string {
    if (toolpath.length === 0) {
      console.error("Toolpath is empty.");
      return "";
    }

    let body_gcode: string[] = [];
    // Apply model position to first point
    let firstPoint = toolpath[0].point.clone();
    let lastTarget: THREE.Vector3 = firstPoint;

    body_gcode.push(`G0 F2880 X${firstPoint.x.toFixed(4)} Y${firstPoint.y.toFixed(4)} Z${firstPoint.z.toFixed(4)}; move to start point`);
    body_gcode.push("M205 X8 Y8; tune down acceleration");

    for (let i = 0; i < toolpath.length; i++) {
      const point = toolpath[i];
      const nextPoint = toolpath[(i + 1) % toolpath.length];
      const currentPoint = point.point.clone();

      this.V_Star = point.vStar!;
      this.H_star = point.hStar!;
      this.Edot = point.edot!;
      this.ZOffset = this.H_star * (this.nozzleDiameter * this.dieSwelling);

      if (point.switchFilament) {
        body_gcode.push(
          `

M600 ; switch filament to TPU
M104 S${230} ; set extruder temp 
M109 S${230} ; wait for extruder temp 

          ` // For now it just switches to 230, but can add option for different nozzle temperatures
        )
      }

      if (point.travel) {
        // if (!nextPoint.travel) {
        //   this.move_to_position(new THREE.Vector3(currentPoint.x, currentPoint.y, currentPoint.z - this.ZOffset));
        // }
        body_gcode.push(
          this.move_to_position(currentPoint)
        );
      } else {
        body_gcode.push(
          this.extrude_single_segment(
            lastTarget,
            currentPoint,
            false
          )
        );
      }
      lastTarget = currentPoint;
    }

    // console.log("Total layers:", toolpath.length);
    // console.log("Model position applied:", modelPosition);



    // for (let i = 0; i < toolpath.length; i++) {
    //   let layerIndex = i;
    //   if (i === 0) {
    //     const firstPointPos = {
    //       x: firstPoint.x,
    //       y: firstPoint.y,
    //       z: firstPoint.z
    //     };

    //     body_gcode.push(
    //       `G0 F2880 X${firstPointPos.x.toFixed(4)} Y${firstPointPos.y.toFixed(4)} Z${firstPointPos.z.toFixed(4)}; move to start point`
    //     );

    //     body_gcode.push("M205 X8 Y8; tune down acceleration");
    //     body_gcode.push("G1 F2400 E0; not sure the purpose of this line");
    //   } else {
    //     // Apply model position to the first point of each layer
    //     const currentPoint = toolpath[i][0].clone().add(modelPosition);
    //     body_gcode.push(
    //       this.extrude_single_segment(
    //         lastTarget,
    //         currentPoint,
    //         true
    //       )
    //     );
    //     lastTarget = currentPoint;
    //   }

    //   // Process the rest of the points in the layer
    //   for (let j = 1; j < toolpath[i].length; j++) {
    //     // Apply model position to each point
    //     const currentPoint = toolpath[i][j].clone().add(modelPosition);
    //     body_gcode.push(
    //       this.extrude_single_segment(
    //         lastTarget,
    //         currentPoint,
    //         false
    //       )
    //     );
    //     lastTarget = currentPoint;
    //   }
    // }

    body_gcode.push("G92 E0");
    this.extrudedAmount = 0;


    //og
    // this.toolpathGcode =
    //   this.build_start_gcode(extruderId) +
    //   "\n\n" +
    //   this.boundaryGcode +
    //   "\n\n" +
    //   body_gcode.join("\n") +
    //   "\n\n" +
    //   this.end_gcode;

    // return this.toolpathGcode;


    let gcode = "";
    // if (includeStart) {
    //   gcode += this.build_start_gcode(extruderId) + "\n\n";
    // }
    gcode += this.boundaryGcode + "\n\n";
    gcode += body_gcode.join("\n") + "\n\n";
    // gcode += this.end_gcode;
    return gcode;
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
