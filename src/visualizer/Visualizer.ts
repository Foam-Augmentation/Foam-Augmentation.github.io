import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader';
import { MeshBVH, INTERSECTED, NOT_INTERSECTED, CONTAINED } from 'three-mesh-bvh';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls';
import tippy from 'tippy.js';
import initGUI, { InitGUIResult } from './gui/initGUI';
import initRenderer from './renderer/initRenderer';
import initTransformControls from './interactions/initTransformControls';
import { initLassoSelect, LassoState } from './interactions/initLassoSelect';
import { generateFoamToolpath } from './toolpath/generateFoamToolpath';
import { sampleSelectedMesh } from './toolpath/sampleSelectedMesh';
import { updateSelectedMeshBoundingBox } from './toolpath/updateSelectedMeshBoundingBox';
import { createSelectedMeshFromHighlight } from './interactions/createSelectedMeshFromHighlight';
import { updateSelection } from './interactions/updateSelection';
import { FoamModel, EverydayModel } from './types/modelTypes';
import Printer, { Extruder, createDefaultExtruder } from '../printer/Printer';
import { saveGcodeToFile } from './toolpath/saveGcodeToFile';
import {ViewCube} from './gui/ViewCube';

/**
 * Visualizer class handles the rendering of 3D models, GUI initialization,
 * and user interactions (such as lasso selection and transform controls).
 */
export default class Visualizer { 
    /** The container HTML element */ 
    public container: HTMLElement; 
    /** Printer instance (used for generating G-code) */ 
    public printer: Printer;  
    /** Three.js renderer */ 
    public renderer: THREE.WebGLRenderer; 
    /** Three.js scene */ 
    public scene: THREE.Scene;
    /** Perspective camera */
    public camera: THREE.PerspectiveCamera;
    /** Orbit controls for camera manipulation */
    public orbitControls: OrbitControls;
    /** Array of objects representing the printer base for visualization */
    public printBaseObjects: THREE.Object3D[];

    /** TransformControls instance for model transformation */
    public transformControls: TransformControls;

    /** List of foam models for slicing */
    public foamModelList: FoamModel[];
    /** List of everyday object models */
    public everydayModelList: EverydayModel[];
    /** Map of model UUIDs to model objects (foam or everyday) */
    public uuid_to_modelObj_Map: Map<string, FoamModel | EverydayModel>;

    /** Unordered toolpath sample points */
    public toolpathSamplePoints: THREE.Vector3[];
    /** Visualization objects for the toolpath (if any) */
    public toolpathVisualize: THREE.Object3D[] | null;

    public showGcodeVisualization: boolean = false;
    public currentSelectedModel: EverydayModel | null = null;
    public viewCube: ViewCube;


    /**
     * Configuration for selection and toolpath parameters.
     */
    public config: {
        toolMode: string;
        selectionMode: string;
        liveUpdate: boolean;
        selectModel: boolean;
        selectWireframe: boolean;
        objectWireframe: boolean;
        objectBoundingBox: boolean;
        selectBoundingBox: boolean;
        bedTemp: number;
        /** Per-extruder parameters. Mirrors Printer.extruders. */
        extruders: Extruder[];
        machineDepth: number;
        machineDepthY: number;
        machineHeight: number;
        // zOffset: number;
        // deltaZ: number;
        //     layers_cube = int(height_cube/increment_z) + (height_cube % increment_z > 0
        // foamLayers: number;
        // extrusion_speed_when_foam: number;
        // VStar: number;
        // HStar: number;
        // Edot: number;
        filamentDiameter: number;
        // extrusion_m: number; // This can be used to adjust the extrusion rate if needed.
        // height: number;
        showGcodeVisualization: false,
        currentSelectedModel: EverydayModel | null;
        useTreeSlicer: boolean;
        useFermatSpirals: boolean;
        generateBoundary: boolean;
        purgeLine: boolean;
        checkCollisions: boolean;
        printHeadMinX: number;
        printHeadMinY: number;
        printHeadMaxX: number;
        printHeadMaxY: number;
        bedLeveling: boolean;
        testSweep: boolean;

        startHStarTest: number;
        endHStarTest: number;
        startVStarTest: number;
        endVStarTest: number;
        testDeltaL: number;
        testSize: number;
    };

    /**
     * State for lasso selection.
     */
    public lassoState: LassoState & { selectionShape: THREE.Line };

    /** Current selected object's mesh */
    public current_Obj_mesh?: THREE.Mesh;
    /** Current selected object (as a Three.js Object3D) */
    public current_Obj?: EverydayModel | FoamModel;
    /** Current selection type, e.g. 'foam' or other */
    public current_selection_type: string;
    /** Bounding box of the bottom of the mesh (used as a constraint) */
    public constrainBounding: THREE.Vector3[];
    /** Sample step (grid size) for sampling the selected mesh */
    public sampleStep: number;

    /** GUI instance (from lil-gui) */
    public gui: GUI;
    /** GUI folder for foam model list */
    public foamModelListFolder: GUI;
    /** GUI folder for everyday model list */
    public everydayModelListFolder: GUI;

    public saveFolder: GUI;


    /**
     * Creates an instance of Visualizer.
     *
     * @param {string} containerId - The ID of the container element.
     * @param printer - The printer instance used for generating G-code.
     */
    constructor(containerId: string, printer: Printer) {
        const container = document.getElementById(containerId);
        if (!container) {
            throw new Error("Container element not found");
        }
        this.container = container;
        this.printer = printer;

        // Initialize renderer, scene, camera, orbit controls, and printer base objects.
        const { renderer, scene, camera, orbitControls, printBaseObjects, viewCube } = initRenderer(this.container, printer);
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;
        this.orbitControls = orbitControls;
        this.printBaseObjects = printBaseObjects;
        this.viewCube = viewCube;

        // Initialize transform controls for model manipulation.
        this.transformControls = initTransformControls(this);

        // Initialize model lists.
        this.foamModelList = [];
        this.everydayModelList = [];
        this.uuid_to_modelObj_Map = new Map();

        // Initialize toolpath sample points.
        this.toolpathSamplePoints = [];

        // Initialize toolpath visualization as null.
        this.toolpathVisualize = null;

        // Set configuration parameters.
      
        this.config = {
            toolMode: 'lasso',
            selectionMode: 'centroid-visible',
            liveUpdate: false,
            selectModel: false,
            selectWireframe: false,
            objectWireframe: false,
            objectBoundingBox: false,
            selectBoundingBox: false,
            bedTemp: 60,
            // Seeded from the printer so the GUI always reflects the printer's actual extruders.
            extruders: printer.extruders.map(extruder => ({ ...extruder })),
            machineDepth: 250,
            machineDepthY: 210,
            machineHeight: 220,
            // zOffset: 3.38,
            // deltaZ: 1.7,
            // height: 20,
            // layers_cube = int(height_cube/increment_z) + (height_cube % increment_z > 0
            // foamLayers: 3,
            // extrusion_speed_when_foam: 758.17,
            // VStar: 0.15,
            // HStar: 9,
            // Edot: 35,
            filamentDiameter: 1.75,
            // extrusion_m: 0.92,
            showGcodeVisualization: false,
            currentSelectedModel: null,
            useTreeSlicer: false,
            useFermatSpirals: false,
            generateBoundary: false,
            purgeLine: true,
            checkCollisions: false,
            printHeadMinX: -40,
            printHeadMinY: -15,
            printHeadMaxX: 35,
            printHeadMaxY: 70,
            bedLeveling: false,
            testSweep: false,

            startHStarTest: 5,
            endHStarTest: 10,
            startVStarTest: 0.15,
            endVStarTest: 0.3,
            testDeltaL: 3,
            testSize: 15,
        };

        // Initialize lasso selection state.
        this.lassoState = {
            selectionPoints: [],
            dragging: false,
            selectionShapeNeedsUpdate: false,
            selectionNeedsUpdate: false,
            startX: -Infinity,
            startY: -Infinity,
            prevX: -Infinity,
            prevY: -Infinity,
            tempVec0: new THREE.Vector2(),
            tempVec1: new THREE.Vector2(),
            tempVec2: new THREE.Vector2(),
            // Initialize the selection shape with an empty geometry and basic material.
            selectionShape: new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial())
        };

        // Initialize lasso select functionality.
        initLassoSelect(this);

        // Initialize current selected object and its mesh.
        // this.current_Obj_mesh = new THREE.Mesh();
        
        
        this.current_selection_type = 'foam';

        // Initialize constrain bounding box.
        this.constrainBounding = [];

        // Set sampling step for the grid sampling process.
        this.sampleStep = 4;

        // Initialize the GUI and retrieve folders.
        const guiResult: InitGUIResult = initGUI(this);
        this.gui = guiResult.gui;
        this.foamModelListFolder = guiResult.foamModelListFolder;
        this.everydayModelListFolder = guiResult.everydayModelListFolder;
        //save folder for the gcode 
        this.saveFolder = guiResult.saveFolder;
    }

    /**
     * The render loop that updates selection shapes and renders the scene.
     */
    public render = (): void => {
        requestAnimationFrame(this.render);
        // Update the selection lasso lines if needed.
        if (this.lassoState.selectionShapeNeedsUpdate) {
            if (this.config.toolMode === 'lasso') {
                const ogLength = this.lassoState.selectionPoints.length;
                // Append the first point to close the lasso shape.
                this.lassoState.selectionPoints.push(
                    this.lassoState.selectionPoints[0],
                    this.lassoState.selectionPoints[1],
                    this.lassoState.selectionPoints[2]
                );
                this.lassoState.selectionShape.geometry.setAttribute(
                    'position',
                    new THREE.Float32BufferAttribute(this.lassoState.selectionPoints, 3, false)
                );
                // Reset the selection points length.
                this.lassoState.selectionPoints.length = ogLength;
            } else {
                this.lassoState.selectionShape.geometry.setAttribute(
                    'position',
                    new THREE.Float32BufferAttribute(this.lassoState.selectionPoints, 3, false)
                );
            }
            this.lassoState.selectionShape.frustumCulled = false;
            this.lassoState.selectionShapeNeedsUpdate = false;
        }

        // If a selection update is needed, update the selection.
        if (this.lassoState.selectionNeedsUpdate) {
            this.lassoState.selectionNeedsUpdate = false;
            if (this.lassoState.selectionPoints.length > 0) {
                if (this.current_Obj) {
                    if (this.current_Obj && 'toolpathConfig' in this.current_Obj) {
                        updateSelection(this, this.current_Obj as EverydayModel);
                    }
                }
            }
        }

        // Update the lasso shape scale based on the camera's field of view.
        const yScale = Math.tan(THREE.MathUtils.DEG2RAD * this.camera.fov / 2) * this.lassoState.selectionShape.position.z;
        this.lassoState.selectionShape.scale.set(-yScale * this.camera.aspect, -yScale, 1);
        // update the orbit controls
        this.orbitControls.update();

        // Render the scene.
        this.renderer.render(this.scene, this.camera);
    }

    public saveGcodeToFile(gcode: string, name: string): void {
        console.log("G-code content:", this.printer);
        console.log("G-code content:", gcode);
        console.log("saveToolpathGcodeToFile called");
        if (gcode) {
            // this.printer.toolpathGcode += this.printer.end_gcode;
            // saveGcodeToFile(this.printer.toolpathGcode, name);  //originally was just gcode but didnt getupdated stuff
            saveGcodeToFile(gcode, name);
        }
    }


    /**
     * Updates all the printer parameters to the visualizer parameters.
     */
    public syncConfigToPrinter(): void {
        this.printer.material_bed_temperature = this.config.bedTemp;
        this.printer.machine_depth = this.config.machineDepth;
        this.printer.machine_depth_y = this.config.machineDepthY;
        this.printer.machine_height = this.config.machineHeight;
        this.printer.diameter_filament = this.config.filamentDiameter;
        this.printer.printHeadDims.min.setX(this.config.printHeadMinX);
        this.printer.printHeadDims.min.setY(this.config.printHeadMinY);
        this.printer.printHeadDims.max.setX(this.config.printHeadMaxX);
        this.printer.printHeadDims.max.setY(this.config.printHeadMaxY);
        this.printer.globalVTPSettings.useFermatSpirals = this.config.useFermatSpirals;
        this.printer.generateBoundary = this.config.generateBoundary;
        this.printer.purgeLine = this.config.purgeLine;
        this.printer.checkCollisions = this.config.checkCollisions;
        this.printer.bedLeveling = this.config.bedLeveling;
        this.printer.testSweep = this.config.testSweep;
        this.syncExtrudersToPrinter();
    }

    /**
     * Copies the per-extruder config onto the printer.
     * The printer gets its own copies so later GUI edits only take effect through this method.
     */
    public syncExtrudersToPrinter(): void {
        this.printer.extruders = this.config.extruders.map(extruder => ({ ...extruder }));
    }

    /**
     * Appends a new extruder to the config (and the printer).
     * The new extruder is cloned from the last existing one so it starts from something sensible.
     *
     * @returns {number} The index of the newly added extruder.
     */
    public addExtruder(): number {
        const last = this.config.extruders[this.config.extruders.length - 1];
        this.config.extruders.push(last ? { ...last } : createDefaultExtruder());
        this.syncExtrudersToPrinter();
        return this.config.extruders.length - 1;
    }

    /**
     * Removes the extruder at the given index. The last remaining extruder cannot be removed
     * because the printer always needs at least one.
     *
     * @param {number} index - The index of the extruder to remove.
     * @returns {boolean} True if the extruder was removed.
     */
    public removeExtruder(index: number): boolean {
        if (this.config.extruders.length <= 1) {
            console.warn("Cannot remove the last extruder.");
            return false;
        }
        if (index < 0 || index >= this.config.extruders.length) {
            console.warn(`No extruder at index ${index}.`);
            return false;
        }
        this.config.extruders.splice(index, 1);
        this.syncExtrudersToPrinter();
        return true;
    }
}
