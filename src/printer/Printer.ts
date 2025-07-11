import * as THREE from 'three';
import Visualizer from '../visualizer/Visualizer';
import {getSegmentsFromMesh, connectSegments} from '../visualizer/utils/TreeSlicer'

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
  // Machine depth (maximum y axis lenght)
  public machine_depth_y: number;
  /** Machine height (maximum z axis length) */
  public machine_height: number;
  /** Stores the generated boundary G-code */
  public boundaryGcode: string;
  /** Stores the generated toolpath G-code */
  public toolpathGcode: string;
  /** End G-code string */
  public end_gcode: string;

  public diameter_filament: number;

  public V_Star: number;

  public Edot: number;

  public extrusion_m: number;

  public deltaZ: number; // deltaZ (thickness of a single foam layer)

  public ZOffset: number; // zOffset (distance between the nozzle and the layer under to allow VTP)
  public H_star: number; // H_star (height of the foam layer)

  /**
   * Creates a new Printer instance and initializes default parameters and end G-code.
   */
  constructor() {
    this.extrudedAmount = 0;
    this.nozzleDiameter = 0.4; // nozzle diameter
    this.dieSwelling = 0.94; // die swelling factor
    this.extrusion_speed_when_foam = 758.17; // foam extrusion speed (mm/min)
    this.extrusion_foam_interlayer_rate = 0.2; // foam interlayer extrusion rate (0.07mm per 1mm move)
    this.extrusion_norm_rate = 0.07; // normal extrusion rate
    this.printHead_speed_when_free_move = 1000; // free move speed
    this.printHead_speed_when_foam = 113.7; // print head speed when extruding foam
    this.printHead_speed_when_interlayer_move = 200; // interlayer move speed for foam
    this.printHead_speed_when_normal_print = 800; // normal printing extrusion speed
    this.material_bed_temperature = 60; // bed temperature
    this.print_temp_left_extruder = 230; // left extruder temperature (TPU)
    this.print_temp_right_extruder = 260; // right extruder temperature (PLA)
    this.machine_depth = 250; // machine depth (max x)
    this.machine_depth_y = 210; // machine y axis length
    this.machine_height = 210; // machine height (max z)
    this.boundaryGcode = ""; // initialize boundary G-code
    this.toolpathGcode = ""; // initialize toolpath G-code
    this.diameter_filament = 1.75;
    this.V_Star = 0.15;
    this.Edot = 35;
    this.extrusion_m = 0.92,
      this.deltaZ = 1.7; // deltaZ (thickness of a single foam layer)
    this.ZOffset = 3.38
    this.H_star = 6.0
   
    this.end_gcode = `
G1 F10800.000 
G4 S20; Dwell for 20 Second(s) 
M104 S0 ; turn off temperature 
M140 S0 ; turn off heatbed 
M107 ; turn off fan 
G1 Z042.08 F5000 ; Move print head up 
M73 P91 R0 
G1 X0 Y190 F3000 ; home 
M900 K0 ; reset LA 
M84 ; disable motors 
M73 P100 R0 `
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
      return `
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



G21 ; set units to millimeters 
G90 ; use absolute coordinates 
M83  ; extruder relative mode 
M900 K0.05 ; Filament gcode LA 1.5 
M900 K30 ; Filament gcode LA 1.0 
G92 E0.0 

G1 Z0.200 F10800.000 

M204 S1000 
          
      `;
    } else {
      return `
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

G21 ; set units to millimeters 
G90 ; use absolute coordinates 
M83  ; extruder relative mode 
M900 K0.05 ; Filament gcode LA 1.5 
M900 K30 ; Filament gcode LA 1.0 
G92 E0.0 

G1 Z0.200 F10800.000 

M204 S1000 
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
    p0: THREE.Vector3 | { point: THREE.Vector3; type: string },
    p1: THREE.Vector3 | { point: THREE.Vector3; type: string },
    extrusion_speed_when_foam: number,
    printHead_speed_when_foam: number,
    ZlayerIndex: number,
    isFirstInLayer: boolean = false
  ): string {
    // Extract Vector3 points regardless of input type

    const p0Point = (p0 instanceof THREE.Vector3) ? p0 : p0.point;
    const p1Point = (p1 instanceof THREE.Vector3) ? p1 : p1.point;

    const beta = (Math.PI / 4) * Math.pow(this.diameter_filament, 2);
    const gamma = (Math.PI / 4) * Math.pow(this.dieSwelling * this.nozzleDiameter, 2);

    const S = gamma / (beta * this.V_Star);
    const F = this.Edot / S;


    console.log("📌 Extruding segment: ", { p0Point, p1Point });
    // Jerry changed this to be multiplied by S instead of multiplied by (extrusion_speed_when_foam / printHead_speed_when_foam))

    this.extrudedAmount = (this.norm(p1Point, p0Point)) * S;
    let gcode = '';

    if (isFirstInLayer) {
      gcode += `G1 X${p0Point.x.toFixed(4)} Y${p0Point.y.toFixed(4)} Z${p0Point.z.toFixed(4)} E0.0050 F0114 ; Move to start of new layer\n`;
    }

    gcode += `G1 X${p1Point.x.toFixed(4)} Y${p1Point.y.toFixed(4)} Z${p1Point.z.toFixed(4)} E${this.extrudedAmount.toFixed(4)} F0${Math.round(F)}`;

    return gcode;
  }


  /**
   * Gets the contour of the bottom of a mesh.
   * 
   * @private
   * @param {THREE.Mesh} mesh - The mesh to get the base contour from.
   * @returns {{ start: THREE.Vector3; end: THREE.Vector3 }[]} The contour in the form of a list of line segments.
   */
  private get_base_contour(mesh: THREE.Mesh): { start: THREE.Vector3; end: THREE.Vector3 }[] {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const positions = geometry.attributes.position.array as Float32Array;

    // find the minimum z value
    let minZ = Infinity;
    for (let i = 2; i < positions.length; i += 3) {
        minZ = Math.min(minZ, positions[i]);
    }
    minZ += 0.01; // add a small amount to avoid issues with being exactly at the bottom of the mesh

    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -minZ);

    return getSegmentsFromMesh(mesh, plane);
  }


    /**
   * Takes in a contour in the form of a list of line segments and returns an ordered list 
   * of points representing the contour.
   * 
   * @private
   * @param {{ start: THREE.Vector3; end: THREE.Vector3 }[]} segments - The contour in the form of line segments.
   * @returns {THREE.Vector3} The ordered list of points making up the contour.
   */
  private make_ordered_contour(
    segments: { start: THREE.Vector3; end: THREE.Vector3 }[]
  ): THREE.Vector3[] {
    const baseContour: THREE.Vector3[] = [];

    if (segments.length === 0) return baseContour;

    let current = segments[0];
    baseContour.push(current.start.clone());
    baseContour.push(current.end.clone());
    segments.splice(0, 1);

    while (segments.length > 0) {
      const lastPoint = baseContour[baseContour.length - 1];

      // find next connected segment
      const nextIndex = segments.findIndex(
        s => s.start.distanceTo(lastPoint) < 1e-6 || s.end.distanceTo(lastPoint) < 1e-6
      );

      if (nextIndex === -1) break; // contour is open or broken

      const nextSegment = segments.splice(nextIndex, 1)[0];

      if (nextSegment.start.distanceTo(lastPoint) < 1e-6) {
        baseContour.push(nextSegment.end.clone());
      } else {
        baseContour.push(nextSegment.start.clone());
      }
    }
    return baseContour;
  }


  /**
   * Expands a contour outwards (or inwards if offset is negative) by a given amount.
   * 
   * @param {THREE.Vector3[]} contour The contour to be offset.
   * @param {number} offset How much to offset the contour outwards by
   * @returns {THREE.Vector3[]}
   */
  private offset_contour(
    contour: THREE.Vector3[],
    offset: number,
  ): THREE.Vector3[] {
    // find the center of the contour
    const centroid = new THREE.Vector2(0, 0);
    contour.forEach(p => centroid.add(new THREE.Vector2(p.x, p.y)));
    centroid.divideScalar(contour.length);

    const expandedContour: THREE.Vector3[] = [];
    for (let i = 0; i < contour.length; i++) {
      const lastPoint = i <= 0 ? contour[contour.length - 1 - i] : contour[i - 1];
      const point = contour[i];
      const nextPoint = i + 1 >= contour.length ? contour[i + 1 - contour.length] : contour[i + 1];

      // compute the normal using the two points next to the current point
      const bisector = new THREE.Vector2(nextPoint.x - lastPoint.x, nextPoint.y - lastPoint.y);
      let norm = new THREE.Vector2(-bisector.y, bisector.x).normalize();

      // flip the normal if it points towards the center
      const toCenter = new THREE.Vector2(point.x, point.y).sub(centroid);
      if (norm.dot(toCenter) < 0) {
        norm.negate();
      }

      expandedContour.push(new THREE.Vector3(point.x + norm.x * offset, 
                                             point.y + norm.y * offset, 
                                             point.z));
    }
    return expandedContour;
  }

  /**
   * Generates the gcode for a brim around the bottom of a mesh.
   * 
   * @param {THREE.Mesh} mesh - The mesh to get the brim of.
   * @param {number} offset - How far away the brim should be from the mesh.
   * @param {number} extruderId - The ID of the extruder. 1 For left 2 for right.
   * @returns {string} The gcode as a string.
   */
  public generate_boundary_gcode(
    mesh: THREE.Mesh,
    offset: number = 3,
    extruderId: number = 1
  ): string {
    // get ordered set of points representing the boundary of the bottom layer
    const baseContours: THREE.Vector3[][] = connectSegments(this.get_base_contour(mesh));

    // push the contour out by offset

    const expandedContours: THREE.Vector3[][] = [];

    for (const contour of baseContours) {
      expandedContours.push(this.offset_contour(contour, offset))
    }

    // align contour with model
    expandedContours.forEach(contour => contour.forEach(p => p.add(mesh.position)))

    let boundaryGcode: string[] = [];

    // create gcode for following the expanded contours
    for (const expandedContour of expandedContours) {
      const firstPoint = expandedContour[0];
      boundaryGcode.push(`G0 X${firstPoint.x.toFixed(4)} Y${firstPoint.y.toFixed(4)} Z${firstPoint.z.toFixed(4)}
                          F${this.printHead_speed_when_free_move}`) // move to first point in contour
      for (let i = 0; i < expandedContour.length; i++) {
        const nextPoint = i + 1 >= expandedContour.length ? expandedContour[i + 1 -expandedContour.length] : expandedContour[i +  1];
        const point = expandedContour[i];
        boundaryGcode.push(
          this.extrude_single_segment(
            point,
            nextPoint,
            this.extrusion_norm_rate,
            this.printHead_speed_when_normal_print,
            0
          )
        );
      }
    }

    this.boundaryGcode =
      this.build_start_gcode(extruderId) +
      "\n\n" +
      boundaryGcode.join("\n") +
      "\n\n" +
      this.end_gcode;

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
          this.extrusion_norm_rate,
          this.printHead_speed_when_normal_print,
          0
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
  
  public generate_foam_gcode(
    toolpath: THREE.Vector3[][],
    extruderId: number,
    modelPosition: THREE.Vector3 = new THREE.Vector3(0, 0, 0)
  ): string {
    if (toolpath.length === 0 || toolpath[0].length === 0) {
      console.error("Toolpath is empty.");
      return "";
    }

    let body_gcode: string[] = [];
    // Apply model position to first point
    let firstPoint = toolpath[0][0].clone().add(modelPosition);
    let lastTarget: THREE.Vector3 = firstPoint;
    this.extrudedAmount = 0;

    console.log("Total layers:", toolpath.length);
    console.log("Model position applied:", modelPosition);

    for (let i = 0; i < toolpath.length; i++) {
      let layerIndex = i;
      if (i === 0) {
        const firstPointPos = {
          x: firstPoint.x,
          y: firstPoint.y,
          z: firstPoint.z
        };

        body_gcode.push(
          `G0 F2880 X${firstPointPos.x.toFixed(4)} Y${firstPointPos.y.toFixed(4)} Z${firstPointPos.z.toFixed(4)}; move to start point`
        );

        body_gcode.push("M205 X8 Y8; tune down acceleration");
        body_gcode.push("G1 F2400 E0; not sure the purpose of this line");
      } else {
        // Apply model position to the first point of each layer
        const currentPoint = toolpath[i][0].clone().add(modelPosition);
        body_gcode.push(
          this.extrude_single_segment(
            lastTarget,
            currentPoint,
            this.extrusion_speed_when_foam,
            this.printHead_speed_when_foam,
            layerIndex,
            true
          )
        );
        lastTarget = currentPoint;
      }

      // Process the rest of the points in the layer
      for (let j = 1; j < toolpath[i].length; j++) {
        // Apply model position to each point
        const currentPoint = toolpath[i][j].clone().add(modelPosition);
        body_gcode.push(
          this.extrude_single_segment(
            lastTarget,
            currentPoint,
            this.extrusion_speed_when_foam,
            this.printHead_speed_when_foam,
            i,
            false
          )
        );
        lastTarget = currentPoint;
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
