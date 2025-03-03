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
import Printer from '../printer/Printer';

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
        nozzleLeftTemp: number;
        nozzleRightTemp: number;
        machineDepth: number;
        machineHeight: number;
        zOffset: number;
        deltaZ: number;
        foamLayers: number;
        extrusion_speed_when_foam: number;
        printHead_speed_when_foam: number;
        nozzleDiameter: number;
        dieSwelling: number;
        VStar: number;
        HStar: number;
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
        const { renderer, scene, camera, orbitControls, printBaseObjects } = initRenderer(this.container, printer);
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;
        this.orbitControls = orbitControls;
        this.printBaseObjects = printBaseObjects;

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
            bedTemp: 100,
            nozzleLeftTemp: 240,
            nozzleRightTemp: 260,
            machineDepth: 302,
            machineHeight: 402,
            zOffset: 12,
            deltaZ: 5,
            foamLayers: 3,
            extrusion_speed_when_foam: 70,
            printHead_speed_when_foam: 70,
            nozzleDiameter: 0.4,
            dieSwelling: 1.1,
            VStar: 0,
            HStar: 0,
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

        // Render the scene.
        this.renderer.render(this.scene, this.camera);
    }
}
