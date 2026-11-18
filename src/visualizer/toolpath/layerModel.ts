// ---------------------------------------------------------------------------------------------
// How thick a foam layer comes out at a given H*, and the H* that makes a layer a given thickness.
//
// In viscous thread printing the layer height follows the nozzle height: Emery et al. 2024
// (Advanced Science, arXiv 2407.06051) model it from V*, H* and the line spacing, with layers
// thickening as H* rises. Over several layers the stack pulls each layer back to the layer
// thickness (ΔZ), as the nozzle height above the fresh foam adjusts. The top layer under a roof
// has nothing printed on it but the roof, so lowering the nozzle there thins that layer for good:
// that is how foam is fitted under a roof (Thin Foam Under Roofs).
//
// The relation used here is a straight line through the nominal point (H*₀ gives ΔZ) whose slope
// is the extruder's Layer Response g′: lowering the nozzle by δ thins the layer by g′ δ. Neither
// g′ nor the lowest usable H* has been measured; the defaults (g′ = 1, H* no lower than 3) are
// assumptions to be checked by test prints (plans/C6-foam-under-roofs.md, section 5).
//
// No DOM here, so it can be unit-tested under Node.
// ---------------------------------------------------------------------------------------------

/** The settings a foam layer is printed at when nothing is fitted under a roof. */
export interface NominalLayer {
    /** H*₀: the point's own H*, gradient included. */
    hStar: number;
    /** ΔZ: the layer thickness (mm). */
    deltaZ: number;
}

/** How an extruder's foam layers respond to a lowered nozzle. */
export interface LayerResponse {
    /** The lowest H* that still lays foam a roof can be printed onto. */
    minHStar: number;
    /** g′: how much thinner a layer comes out per mm the nozzle is lowered, from 0 to 1. */
    response: number;
}

/**
 * How thick a layer comes out when its nozzle is at `hStar` instead of the nominal H*.
 *
 * @param {number} hStar The H* it is printed at.
 * @param {NominalLayer} nominal The nominal H* and layer thickness.
 * @param {number} threadDiameter The thread diameter (mm): nozzle diameter times die swell.
 * @param {number} response g′ (see LayerResponse).
 * @returns {number} The layer's thickness (mm): ΔZ − g′ (H*₀ − H*) d.
 */
export function layerHeightAt(hStar: number, nominal: NominalLayer, threadDiameter: number, response: number): number {
    return nominal.deltaZ - response * (nominal.hStar - hStar) * threadDiameter;
}

/**
 * The lowest H* a layer may be printed at: no lower than the extruder's Lowest H*, nor so low that
 * the nozzle comes closer above the foam it lays than `minGap` (or than it is at the nominal H*,
 * if that is closer already). With g′ = 1 the nozzle keeps the same height above the foam however
 * far it is lowered; with g′ < 1 it gets closer as it goes down. Never above the nominal H*.
 *
 * @param {NominalLayer} nominal The nominal H* and layer thickness.
 * @param {number} threadDiameter The thread diameter (mm).
 * @param {LayerResponse} layer The extruder's Lowest H* and Layer Response.
 * @param {number} minGap The least height (mm) the nozzle tip keeps above the top of the foam.
 * @returns {number} The lowest H*.
 */
export function lowestHStar(nominal: NominalLayer, threadDiameter: number, layer: LayerResponse, minGap: number): number {
    let lowest = Math.max(0, layer.minHStar);
    if (layer.response < 1) {
        // The nozzle's height above the top of the foam: H* d − layerHeightAt(H*), which falls by
        // (1 − g′) d per H* the nozzle is lowered.
        const nominalGap = nominal.hStar * threadDiameter - nominal.deltaZ;
        const gap = Math.min(minGap, nominalGap);
        lowest = Math.max(lowest, nominal.hStar - (nominalGap - gap) / ((1 - layer.response) * threadDiameter));
    }
    return Math.min(nominal.hStar, lowest);
}

/**
 * The H* that makes a layer `room` thick, or as thin as it can be made if that is thinner.
 *
 * @param {number} room How thick (mm) the layer may be.
 * @param {NominalLayer} nominal The nominal H* and layer thickness.
 * @param {number} threadDiameter The thread diameter (mm).
 * @param {number} response g′ (see LayerResponse). Must be above 0.
 * @param {number} lowest The lowest H* allowed (see lowestHStar).
 * @returns {number} H*₀ where there is a whole layer of room or more; otherwise
 *          H*₀ − (ΔZ − room) / (g′ d), but not below `lowest`.
 */
export function hStarForLayerHeight(room: number, nominal: NominalLayer, threadDiameter: number, response: number, lowest: number): number {
    if (room >= nominal.deltaZ) {
        return nominal.hStar;
    }
    return Math.min(nominal.hStar, Math.max(lowest, nominal.hStar - (nominal.deltaZ - room) / (response * threadDiameter)));
}

/**
 * The thinnest layer the lowest H* gives. Never thinner than a thread: no layer of foam is.
 *
 * @param {NominalLayer} nominal The nominal H* and layer thickness.
 * @param {number} threadDiameter The thread diameter (mm).
 * @param {number} response g′ (see LayerResponse).
 * @param {number} lowest The lowest H* allowed (see lowestHStar).
 * @returns {number} The thickness (mm).
 */
export function thinnestLayer(nominal: NominalLayer, threadDiameter: number, response: number, lowest: number): number {
    return Math.min(nominal.deltaZ, Math.max(threadDiameter, layerHeightAt(lowest, nominal, threadDiameter, response)));
}
