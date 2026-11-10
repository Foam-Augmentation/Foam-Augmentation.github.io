// src/types/modelTypes.ts
import * as THREE from 'three';
import { Gradient } from '../loaders/modelLoader'

/**
 * Represents a GUI item, typically a folder from a GUI library.
 */
export interface GUIItem {
    /** The DOM element of the GUI item. */
    domElement: HTMLElement;
    /** Removes the GUI item and its controllers (lil-gui `destroy()`). */
    destroy?: () => void;
}

/**
 * Common properties for models.
 */
export interface BasicModel {
    /** Model name. */
    name: string;
    /** The Three.js mesh for the model. */
    mesh: THREE.Mesh;
    /** The geometry of the model. */
    geometry: THREE.BufferGeometry;
    /** Transformation type: 'move', 'rotate', or 'scale'. */
    transformType: 'move' | 'rotate' | 'scale';
    /** X-axis transformation data. */
    transformX: { x: number };
    /** Y-axis transformation data. */
    transformY: { y: number };
    /** Z-axis transformation data. */
    transformZ: { z: number };
    /** Associated GUI item. */
    guiItem?: GUIItem;

    // nozzle
    /** nozzle diameter for regular TPU */
    nozzleDiameterRegularTPU?: number;
    /** nozzle diameter for conductive TPU */
    nozzleDiameterConductiveTPU?: number;

    // nozzle temperature
    /** nozzle temperature for regular TPU */
    nozzleTemperatureRegularTPU?: number;
    /** nozzle temperature for conductive TPU */
    nozzleTemperatureConductiveTPU?: number;
}

/**
 * FoamModel: used for foam slicing. Extends BasicModel.
 */
export interface FoamModel extends BasicModel {
    // Add foam-specific properties if needed.
}

/**
 * Toolpath Configurations.
 */
export interface ToolpathConfig {
    /** deltaZ (thickness of a single foam layer) */
    deltaZ: number;
    hStar: number;
    hStarEnd: number;
    vStar: number;
    vStarEnd: number;
    deltaLEnd: number;

    senseDeltaLEnd: number;
    senseDeltaZ: number;
    senseHStar: number;
    senseHStarEnd: number;
    senseVStar: number;
    SenseVStarEnd: number;
    /** zOffset **Not set manually** (distance between the nozzle and the layer under to allow VTP) */
    // zOffset: number;
    /** grid size */
    gridSize: number;
    deltaL: number;
    senseDeltaL: number;
    /** die swell */
    // dieSwell: number;
    // sandwiched structure
    /** initial Foam layer count */
    initialFoamLayerCount: number;
    /** middle Sense layer count */
    middleSenseLayerCount: number;
    /** final Foam layer count */
    finalFoamLayerCount: number;
    edot: number;
    senseEdot: number;
    bumpSpacingX: number;
    bumpSpacingY: number;
    bumpScale: number;
    generateBumps: boolean;
    curveAugment: boolean;
    steepnessThreshold: number;
    flatLayerZOffset: number;
    additionalCurveLayers: number;

    /** regular Foam extrusion speed */
    // extrusionSpeedRegularFoam: number;
    /** regular Foam print head speed */
    // printHeadSpeedRegularFoam: number;
    /** regular Foam print head temp */
    // printHeadTempRegularFoam: number;
    /** regular Foam nozzle size */
    // nozzleSizeRegularFoam: number;

    /** sensing Foam extrusion speed */
    // extrusionSpeedSensingFoam: number;
    // /** sensing Foam print head speed */
    // printHeadSpeedSensingFoam: number;
    // /** sensing Foam print head temp */
    // printHeadTempSensingFoam: number;
    // /** sensing Foam nozzle size */
    // nozzleSizeSensingFoam: number;
}

export interface PointCloudPoint {
    point: THREE.Vector3
    type: string //In the future we can connect this to extruder types. 
}

/**
 * What an object on the plate is, which decides how (and whether) it is printed:
 * - `augment`: an existing object placed on the bed. It is not printed; foam is printed onto
 *   the area selected on it.
 * - `foam`: a model printed entirely as foam.
 * - `regular`: a model printed as an ordinary solid plastic part.
 */
export type ObjectKind = 'augment' | 'foam' | 'regular';

/** Settings of a model printed as an ordinary solid part (`kind === 'regular'`). */
export interface RegularPrintSettings {
    /** Layer height (mm). */
    layerHeight: number;
    /** Number of wall loops around every layer. */
    perimeters: number;
    /** Sparse infill density, 0 to 100 (%). */
    infillDensity: number;
    /** Number of solid layers under every top surface and over every bottom surface. */
    topBottomLayers: number;
    /** Index of the extruder that prints the part. */
    extruder: number;
    /** Speed of extruding moves (mm/min). */
    printSpeed: number;
}

/**
 * EverydayModel: an object on the plate. Extends BasicModel.
 */
export interface EverydayModel extends BasicModel {
    /** What the object is: something to augment, a foam print or a regular print. */
    kind: ObjectKind;
    /** Print settings used while `kind` is `regular`. */
    regularConfig: RegularPrintSettings;

    /** Mesh highlighting foam areas, for visualization. */
    highlightFoamMesh?: THREE.Mesh;
    /** Mesh highlighting sense areas, for visualization. */
    highlightSenseMesh?: THREE.Mesh;

    pointsMesh?: THREE.Mesh;
    /** Mesh displaying sampled foam points. */
    pointsMesh_foam?: THREE.Points;
    /** Mesh displaying sampled sense points. */
    pointsMesh_sense?: THREE.Points;
    /** Sampled points for toolpath generation. point: sample points; type: regular foam / sensing area */
    toolpathSamplePoints?: PointCloudPoint[];

    augmentSamplePoints?: THREE.Vector3[][];
    /** Group for Toolpath visualization. */
    toolpathVisualizationObject?: THREE.Group;
    /** Selected Regular Foam Mesh Area, for intersection detection. */
    selectedRegularFoamMesh?: THREE.Mesh;
    /** Selected Sense Foam Mesh Area, for intersection detection. */
    selectedSenseFoamMesh?: THREE.Mesh;
    /** List of models for intersect detection (for sensing areas) */
    sensingIntersectModelList?: THREE.Mesh[];

    bumpMesh?: THREE.Mesh;

    gradient: Gradient;

    /** Toolpath configurations */
    toolpathConfig: ToolpathConfig;

    initialConfig: ToolpathConfig;
    initialOffset: number;

    /** segments of regular + sensing area */
    all_area_segments?: PointCloudPoint[][];
    /** segments of regular area */
    regular_area_segments?: PointCloudPoint[][];
    /** segments of sensing area */
    sense_area_segments?: PointCloudPoint[][];

}
