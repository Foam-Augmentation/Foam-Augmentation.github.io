// src/types/modelTypes.ts
import * as THREE from 'three';

/**
 * Represents a GUI item, typically a folder from a GUI library.
 */
export interface GUIItem {
    /** The DOM element of the GUI item. */
    domElement: HTMLElement;
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
interface ToolpathConfig {
    /** deltaZ (thickness of a single foam layer) */
    deltaZ: number;
    /** zOffset (distance between the nozzle and the layer under to allow VTP) */
    zOffset: number;
    /** grid size */
    gridSize: number;
    /** die swell */
    dieSwell: number;
    // sandwiched structure
    /** initial Foam layer count */
    initialFoamLayerCount: number;
    /** middle Sense layer count */
    middleSenseLayerCount: number;
    /** final Foam layer count */
    finalFoamLayerCount: number;
    /** regular Foam extrusion speed */
    extrusionSpeedRegularFoam: number;
    /** regular Foam print head speed */
    printHeadSpeedRegularFoam: number;
    /** regular Foam print head temp */
    printHeadTempRegularFoam: number;
    /** regular Foam nozzle size */
    nozzleSizeRegularFoam: number;
    /** sensing Foam extrusion speed */
    extrusionSpeedSensingFoam: number;
    /** sensing Foam print head speed */
    printHeadSpeedSensingFoam: number;
    /** sensing Foam print head temp */
    printHeadTempSensingFoam: number;
    /** sensing Foam nozzle size */
    nozzleSizeSensingFoam: number;
}


/**
 * EverydayModel: used for everyday objects. Extends BasicModel.
 */
export interface EverydayModel extends BasicModel {
    /** Mesh highlighting foam areas. */
    highlightFoamMesh?: THREE.Mesh;
    /** Mesh highlighting sense areas. */
    highlightSenseMesh?: THREE.Mesh;

    pointsMesh?: THREE.Mesh;
    /** Mesh displaying sampled foam points. */
    pointsMesh_foam?: THREE.Points;
    /** Mesh displaying sampled sense points. */
    pointsMesh_sense?: THREE.Points;
    /** Sampled points for toolpath generation. point: sample points; type: regular foam / sensing area */
    toolpathSamplePoints?: { point: THREE.Vector3, type: string }[];
    /** Group for Toolpath visualization. */
    toolpathVisualizationObject?: THREE.Group;
    /** Selected Regular Foam Mesh Area. */
    selectedRegularFoamMesh?: THREE.Mesh;
    /** Selected Sense Foam Mesh Area. */
    selectedSenseFoamMesh?: THREE.Mesh;

    /** Toolpath configurations */
    toolpathConfig: ToolpathConfig;

    /** segments of regular + sensing area */
    all_area_segments?: { point: THREE.Vector3, type: string }[][];
    /** segments of regular area */
    regular_area_segments?: { point: THREE.Vector3, type: string }[][];
    /** segments of sensing area */
    sense_area_segments?: { point: THREE.Vector3, type: string }[][];
}
