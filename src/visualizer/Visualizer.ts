import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls';
import initGUI, { InitGUIResult } from './gui/initGUI';
import initRenderer, { resizeRenderer } from './renderer/initRenderer';
import initScene from './renderer/initScene';
import initTransformControls from './interactions/initTransformControls';
import { initLassoSelect, LassoState } from './interactions/initLassoSelect';
import { regenerateSelectionToolpath, updateSelection } from './interactions/updateSelection';
import { FoamModel, EverydayModel, ObjectKind } from './types/modelTypes';
import Printer, { Extruder, createDefaultExtruder } from '../printer/Printer';
import { ViewCube, ViewName } from './gui/ViewCube';
import { initEmptyState, setEmptyStateVisible } from './gui/emptyState';
import { initObjectList, renderObjectList } from './gui/objectList';
import { applyModelAppearance, disposeObject3D } from './gui/modelActions';
import type { PlateSlice } from './toolpath/plateSlice';
import { updateModeHints as renderModeHints } from './gui/bottomTooltip';
import { notify, withBusy } from './gui/notify';

/** Colour of the box drawn around the selected object (the accent colour in style.css). */
const SELECTION_OUTLINE_COLOR = 0x5b9cff;

/** How long to wait after the last parameter edit before regenerating toolpaths (ms). */
const TOOLPATH_REFRESH_DELAY_MS = 300;

/** Extra room around whatever the camera is framed on (1 = touching the window edge). */
const FRAME_MARGIN = 1.25;

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
    public viewCube: ViewCube;

    /**
     * The one selected model, or null. This is the single source of truth for "the current
     * model": change it only through `selectModel`, `armSelection` or `clearSelection`.
     * `current_Obj` and `currentSelectedModel` are views of this field.
     */
    private _selectedModel: EverydayModel | FoamModel | null = null;

    /**
     * True while an area selection is armed, i.e. a drag on the canvas selects part of
     * the selected model (as foam or sensing area, see `current_selection_type`).
     */
    public selectionArmed: boolean = false;

    /**
     * Model parameters from a preset that was imported while no everyday model was loaded.
     * They are applied to each everyday model imported afterwards (see refreshModelGUIList).
     */
    public pendingModelPreset: ((model: EverydayModel) => void) | null = null;

    /**
     * The last slice of the plate's Foam Print and Regular Print objects, waiting to be exported,
     * or null before the first slice. Set by `setPlateSlice`; marked stale by `invalidatePlateSlice`.
     */
    public plateSlice: PlateSlice | null = null;


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
        filamentDiameter: number;
        showGcodeVisualization: boolean;
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
        multipleToolheads: boolean;
        purgeTower: boolean;

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

    /** Current selection type: 'foam' or 'sense'. Only meaningful while `selectionArmed`. */
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

    /** Box drawn around the selected object in the 3D view. */
    private selectionOutline: THREE.BoxHelper | null = null;

    /** Models whose toolpath preview is waiting to be regenerated after a parameter edit. */
    private staleToolpathModels = new Set<EverydayModel>();
    private toolpathRefreshTimer: ReturnType<typeof setTimeout> | null = null;

    /** Id of the pending animation frame of the render loop, or null when it is not running. */
    private animationFrameId: number | null = null;
    /** True while a selection update is waiting for, or running behind, the busy overlay. */
    private selectionUpdatePending: boolean = false;


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

        // Keep the canvas, camera aspect and pixel density in step with the window.
        window.addEventListener('resize', this.handleResize);

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
            filamentDiameter: 1.75,
            showGcodeVisualization: false,
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
            multipleToolheads: true,
            purgeTower: true,

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
        // "Fit View" button under the view cube.
        const fitButton = document.createElement('button');
        fitButton.type = 'button';
        fitButton.id = 'fitViewButton';
        fitButton.textContent = 'Fit View';
        fitButton.title = 'Frame every model, or the whole bed when there is none';
        fitButton.addEventListener('click', () => this.fitView());
        document.body.appendChild(fitButton);

        initEmptyState(this);
        initObjectList(this);
        this.updateActionStates();
    }

    // ----- object list and action state -----

    /**
     * Brings everything that depends on which objects exist, what kind they are and what has
     * been generated for them up to date: the object list and its export buttons, and the
     * "getting started" card. Call after models, their kinds or their toolpaths change.
     */
    public updateActionStates(): void {
        // Called from model-list refreshes that can run before the constructor has finished.
        if (!this.gui) return;

        renderObjectList(this);
        setEmptyStateVisible(this.everydayModelList.length === 0 && this.foamModelList.length === 0);
    }

    /**
     * Changes what an object is (something to augment, a foam print or a regular print).
     *
     * Only an augmentation has selected areas, so leaving that kind disarms area selection and
     * hides the object's foam highlight and toolpath preview; they come back if the object is
     * made an augmentation again.
     *
     * @param model - The object to change.
     * @param kind - Its new kind.
     */
    public setModelKind(model: EverydayModel, kind: ObjectKind): void {
        model.kind = kind;
        const augmenting = kind === 'augment';

        if (!augmenting && this._selectedModel === model && this.selectionArmed) {
            this.selectionArmed = false;
            this.updateModeHints();
        }
        const augmentOnlyObjects = [
            model.highlightFoamMesh, model.highlightSenseMesh,
            model.pointsMesh_foam, model.pointsMesh_sense,
            model.toolpathVisualizationObject,
            ...(model.sensingIntersectModelList ?? []),
        ];
        augmentOnlyObjects.forEach(object => { if (object) object.visible = augmenting; });

        // The settings shown for the object depend on its kind (see style.css).
        const classes = model.guiItem?.domElement.classList;
        (['augment', 'foam', 'regular'] as ObjectKind[]).forEach(k => classes?.toggle(`kind-${k}`, k === kind));

        applyModelAppearance(model, this._selectedModel === model);
        // An object that starts or stops printing changes the plate slice.
        this.invalidatePlateSlice(model);
        this.updateActionStates();
    }

    // ----- plate slice -----

    /**
     * Keeps a new plate slice for export, replacing (and removing the preview of) the last one.
     *
     * @param slice - The new slice.
     */
    public setPlateSlice(slice: PlateSlice): void {
        this.discardPlateSlicePreview();
        this.plateSlice = slice;
        this.updateActionStates();
    }

    /**
     * Marks the plate slice as out of date because something it was made from changed, and
     * removes its preview, which no longer shows what would print. Export then asks for a new slice.
     *
     * @param model - The object that changed. An augmentation that is not part of the slice
     *                cannot change it, so it is ignored. Omit when a global setting changed.
     */
    public invalidatePlateSlice(model?: EverydayModel): void {
        const slice = this.plateSlice;
        if (!slice || slice.stale) return;
        if (model && model.kind === 'augment' && !slice.summary.objects.has(model.objectId)) return;

        slice.stale = true;
        this.discardPlateSlicePreview();
        this.updateActionStates();
    }

    /** Removes the toolpath preview drawn for the plate slice, if it is still there. */
    private discardPlateSlicePreview(): void {
        const previews = this.plateSlice?.previews ?? [];
        if (!previews.length) return;
        // The previews hang off the objects they were drawn for; let go of them there too.
        for (const model of this.everydayModelList) {
            if (model.toolpathVisualizationObject && previews.includes(model.toolpathVisualizationObject)) {
                model.toolpathVisualizationObject = undefined;
            }
        }
        previews.forEach(preview => disposeObject3D(preview));
        this.plateSlice!.previews = [];
    }

    // ----- camera framing -----

    /**
     * Moves the camera so a box fills the view, and makes the box's centre the point the
     * camera orbits around.
     *
     * @param box - What to look at, in world coordinates.
     * @param view - Look from this side. Omit to keep the current viewing direction.
     */
    public frameBox(box: THREE.Box3, view?: ViewName): void {
        if (box.isEmpty()) return;

        const sphere = box.getBoundingSphere(new THREE.Sphere());
        // Fit the sphere in the narrower of the vertical and horizontal fields of view.
        const halfVertical = THREE.MathUtils.degToRad(this.camera.fov) / 2;
        const halfHorizontal = Math.atan(Math.tan(halfVertical) * this.camera.aspect);
        const distance = Math.max(sphere.radius, 1) / Math.sin(Math.min(halfVertical, halfHorizontal)) * FRAME_MARGIN;

        const target = this.orbitControls.target;
        this.viewCube.cancelCameraAnimation();
        if (view) {
            target.copy(sphere.center);
            this.viewCube.setView(view, distance);
            return;
        }

        const direction = this.camera.position.clone().sub(target);
        if (direction.lengthSq() < 1e-8) direction.set(0, -1, 1);
        direction.normalize();
        target.copy(sphere.center);
        this.camera.position.copy(sphere.center).addScaledVector(direction, distance);
        this.orbitControls.update();
    }

    /**
     * Frames one model.
     *
     * @param model - The model to look at.
     * @param view - Look from this side. Omit to keep the current viewing direction.
     */
    public frameModel(model: EverydayModel | FoamModel, view?: ViewName): void {
        this.frameBox(new THREE.Box3().setFromObject(model.mesh), view);
    }

    /** Frames every model, or the whole bed when no model is loaded. */
    public fitView(): void {
        const box = new THREE.Box3();
        [...this.everydayModelList, ...this.foamModelList].forEach(model => box.expandByObject(model.mesh));
        if (box.isEmpty()) {
            box.set(
                new THREE.Vector3(0, 0, 0),
                new THREE.Vector3(this.printer.machine_depth, this.printer.machine_depth_y, 0)
            );
        }
        this.frameBox(box);
    }

    // ----- toolpath preview upkeep -----

    /**
     * Asks for the toolpath preview to be regenerated because something it depends on changed.
     * Requests are collected for a moment, so a burst of edits regenerates once.
     *
     * Only augmentation toolpaths are previewed live; an object of another kind, or one without
     * a selected foam area, has nothing to regenerate.
     *
     * @param model - The model that changed. Omit when a global setting changed, to refresh
     *                every model that has a selected area.
     */
    public scheduleToolpathRefresh(model?: EverydayModel): void {
        // Whatever changes a preview can change the plate slice too.
        this.invalidatePlateSlice(model);

        const candidates = model ? [model] : this.everydayModelList;
        candidates
            .filter(m => m.kind === 'augment' && m.selectedRegularFoamMesh)
            .forEach(m => this.staleToolpathModels.add(m));
        if (this.staleToolpathModels.size === 0) return;

        if (this.toolpathRefreshTimer !== null) clearTimeout(this.toolpathRefreshTimer);
        this.toolpathRefreshTimer = setTimeout(() => {
            this.toolpathRefreshTimer = null;
            // A model can have been deleted, or lost its selection, while the request waited.
            const models = [...this.staleToolpathModels].filter(
                m => this.everydayModelList.includes(m) && m.kind === 'augment' && m.selectedRegularFoamMesh
            );
            this.staleToolpathModels.clear();
            if (models.length === 0) return;

            withBusy('Updating toolpath…', () => {
                models.forEach(m => regenerateSelectionToolpath(this, m));
            })
                .catch(() => { /* withBusy has already shown the error */ })
                .then(() => this.updateActionStates());
        }, TOOLPATH_REFRESH_DELAY_MS);
    }

    // ----- selection state -----

    /** The selected model, or null when nothing is selected. */
    public get selectedModel(): EverydayModel | FoamModel | null {
        return this._selectedModel;
    }

    /**
     * The selected model. Alias of `selectedModel`, kept for existing callers.
     */
    public get current_Obj(): EverydayModel | FoamModel | undefined {
        return this._selectedModel ?? undefined;
    }
    public set current_Obj(model: EverydayModel | FoamModel | undefined) {
        this.selectModel(model ?? null);
    }

    /**
     * The selected model if it is an everyday model, otherwise null.
     * Alias of `selectedModel`, kept for existing callers.
     */
    public get currentSelectedModel(): EverydayModel | null {
        const model = this._selectedModel;
        return model && 'toolpathConfig' in model ? model : null;
    }
    public set currentSelectedModel(model: EverydayModel | null) {
        this.selectModel(model);
    }

    /**
     * Makes a model the selected one (or clears the selection with null). The selected object
     * glows in the 3D view, is marked in the object list, and is the one whose settings the
     * panel shows. Selecting a different model disarms any armed area selection, because that
     * selection belongs to the previous model.
     *
     * @param model - The model to select, or null for none.
     */
    public selectModel(model: EverydayModel | FoamModel | null): void {
        if (model === this._selectedModel) return;

        const previous = this._selectedModel;
        previous?.guiItem?.domElement.classList.remove('selectedModel');
        if (previous) applyModelAppearance(previous, false);

        this._selectedModel = model;
        this.selectionArmed = false;
        if (model) {
            model.guiItem?.domElement.classList.add('selectedModel');
            applyModelAppearance(model, true);
            // The panel shows this object's settings only, so make sure they are open.
            (model.guiItem as GUI | undefined)?.open?.();
            this.everydayModelListFolder?.open();
        }
        this.updateSelectionOutline();
        // The panel shows a hint instead of settings while nothing is selected (see style.css).
        this.gui?.domElement.classList.toggle('has-selection', model !== null);
        this.updateModeHints();
        this.updateActionStates();
    }

    /**
     * Shows the outline box around the selected object, or hides it when nothing is selected.
     */
    private updateSelectionOutline(): void {
        const model = this._selectedModel;
        if (!model) {
            if (this.selectionOutline) this.selectionOutline.visible = false;
            return;
        }
        if (!this.selectionOutline) {
            this.selectionOutline = new THREE.BoxHelper(model.mesh, SELECTION_OUTLINE_COLOR);
            this.scene.add(this.selectionOutline);
        }
        this.selectionOutline.setFromObject(model.mesh);
        this.selectionOutline.visible = true;
    }

    /**
     * Arms area selection: from now on a drag on the canvas selects part of this model.
     * The gizmo is released (a drag must draw, not move the model) and the camera goes to
     * the top view of the model, which is where areas are drawn from.
     *
     * @param model - The everyday model to select on.
     * @param kind - Whether the drawn area becomes a foam area or a sensing area.
     */
    public armSelection(model: EverydayModel, kind: 'foam' | 'sense'): void {
        if (model.kind !== 'augment') return;
        this.transformControls.detach();
        this.selectModel(model);
        this.current_selection_type = kind;
        this.selectionArmed = true;
        this.frameModel(model, 'Top');
        this.updateModeHints();
    }

    /**
     * What Esc does: releases the move gizmo, disarms area selection and deselects the model.
     */
    public clearSelection(): void {
        this.transformControls.detach();
        this.selectionArmed = false;
        this.selectModel(null);
        this.updateModeHints();
    }

    /**
     * Drops every reference the selection state holds to a model. Used before a model is
     * deleted (see `disposeModel`).
     *
     * @param model - The model that is going away.
     */
    public releaseModel(model: EverydayModel | FoamModel): void {
        if (this.transformControls.object === model.mesh) {
            this.transformControls.detach();
        }
        if (this._selectedModel === model) {
            this.selectModel(null);
            // Forget any lasso that was drawn for it, so it cannot be applied afterwards.
            this.lassoState.selectionPoints.length = 0;
            this.lassoState.selectionNeedsUpdate = false;
        }
        this.updateModeHints();
    }

    /**
     * Refreshes the on-canvas hints (selection instructions and the Esc bar) from the
     * current gizmo and selection state.
     */
    public updateModeHints(): void {
        // Called from event handlers that can fire while the constructor is still running.
        if (!this.transformControls || !this.uuid_to_modelObj_Map) return;

        const gizmoObject = this.transformControls.object;
        const gizmoModel = gizmoObject ? this.uuid_to_modelObj_Map.get(gizmoObject.uuid) : undefined;
        const armedModel = this.selectionArmed ? this._selectedModel : null;

        // While armed, a left-drag draws the area, so the view rotates with a right-drag instead
        // (Shift + right-drag pans, as usual for the orbit controls).
        const mouseButtons = this.orbitControls.mouseButtons as { LEFT?: THREE.MOUSE | null; RIGHT?: THREE.MOUSE | null };
        mouseButtons.LEFT = armedModel ? null : THREE.MOUSE.ROTATE;
        mouseButtons.RIGHT = armedModel ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
        this.renderer.domElement.style.cursor = armedModel ? 'crosshair' : '';

        renderModeHints(
            {
                gizmoModelName: gizmoObject ? (gizmoModel?.name ?? 'the model') : null,
                selection: armedModel
                    ? { modelName: armedModel.name, kind: this.current_selection_type === 'sense' ? 'sense' : 'foam' }
                    : null,
            },
            () => {
                if (armedModel) this.frameModel(armedModel, 'Top');
            }
        );
    }

    // ----- scene upkeep -----

    /**
     * Redraws the print-space outline after the printer dimensions changed, replacing (and
     * disposing) the previous outline.
     */
    public rebuildPrintBase(): void {
        this.printBaseObjects = initScene(
            this.scene, this.printer, this.printBaseObjects, { setLight: false, setPrintBase: true }
        );
    }

    /** Window resize handler. */
    private handleResize = (): void => {
        resizeRenderer(this.renderer, this.camera);
    };

    /**
     * Applies the drawn lasso/box to the selected model and regenerates its toolpath.
     * Errors are shown to the user instead of being lost in the console.
     *
     * @param model - The everyday model to select on.
     */
    private runSelectionUpdate(model: EverydayModel): void {
        if (this.selectionUpdatePending) return;

        // Live update runs on every pointer move, so it cannot wait for the busy overlay.
        if (this.lassoState.dragging) {
            try {
                updateSelection(this, model);
            } catch (error) {
                notify(error instanceof Error ? error.message : String(error), 'error');
            }
            return;
        }

        // Selection and toolpath generation block the main thread; show that it is working.
        this.selectionUpdatePending = true;
        withBusy(`Generating toolpath for “${model.name}”…`, () => {
            // The model can only be the selected one if it still exists.
            if (this._selectedModel === model) {
                updateSelection(this, model);
            }
        })
            .catch(() => { /* withBusy has already shown the error */ })
            .then(() => {
                this.selectionUpdatePending = false;
                this.updateActionStates();
            });
    }

    /**
     * The render loop that updates selection shapes and renders the scene.
     */
    public render = (): void => {
        this.animationFrameId = requestAnimationFrame(this.render);
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
                const model = this._selectedModel;
                if (this.selectionArmed && model && 'toolpathConfig' in model) {
                    this.runSelectionUpdate(model);
                } else if (!this.lassoState.dragging) {
                    notify(
                        'Nothing to select on yet: open a model in the panel and press “Select Foam Area” first.',
                        'info'
                    );
                }
            }
        }

        // Update the lasso shape scale based on the camera's field of view.
        const yScale = Math.tan(THREE.MathUtils.DEG2RAD * this.camera.fov / 2) * this.lassoState.selectionShape.position.z;
        this.lassoState.selectionShape.scale.set(-yScale * this.camera.aspect, -yScale, 1);
        // Keep the selection box on the selected object while it is moved, rotated or scaled.
        // (It is fitted to the mesh's bounding box, so this is cheap.)
        if (this.selectionOutline?.visible) {
            this.selectionOutline.update();
        }
        // update the orbit controls
        this.orbitControls.update();

        // Render the scene, then the view cube (it has no loop of its own).
        this.renderer.render(this.scene, this.camera);
        this.viewCube.render();
    }

    /**
     * Stops the render loop and releases what the Visualizer registered globally.
     */
    public dispose(): void {
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        if (this.toolpathRefreshTimer !== null) {
            clearTimeout(this.toolpathRefreshTimer);
            this.toolpathRefreshTimer = null;
        }
        window.removeEventListener('resize', this.handleResize);
        document.getElementById('fitViewButton')?.remove();
        this.viewCube.dispose();
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
        this.printer.multipleToolheads = this.config.multipleToolheads;
        this.printer.purgeTower = this.config.purgeTower;
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
        this.invalidatePlateSlice();
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
            notify('The last extruder cannot be removed.', 'warning');
            return false;
        }
        if (index < 0 || index >= this.config.extruders.length) {
            notify(`There is no extruder ${index} to remove.`, 'warning');
            return false;
        }
        this.config.extruders.splice(index, 1);
        this.syncExtrudersToPrinter();
        this.invalidatePlateSlice();
        return true;
    }
}
