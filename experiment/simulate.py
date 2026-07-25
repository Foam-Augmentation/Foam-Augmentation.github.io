import numpy as np
import pandas as pd
import trimesh
from scipy.ndimage import binary_erosion


def compute_heightfield(
    mesh: trimesh.Trimesh,
    resolution: float = 1.0,
    margin: float = 20.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Precompute a 2D height field from the mesh by downward raycasting.

    The grid extends `margin` mm beyond the mesh bounding box in XY to ensure
    toolpath points from over-scaled corrupted meshes still get valid lookups
    (they will return NaN if off the real surface, which is correct).

    Returns:
        xs: 1D array of x grid coordinates
        ys: 1D array of y grid coordinates
        Z:  2D array (len(ys), len(xs)) of topmost surface Z; NaN where no hit
    """
    bbox = mesh.bounds
    xs = np.arange(bbox[0, 0] - margin, bbox[1, 0] + margin + resolution, resolution)
    ys = np.arange(bbox[0, 1] - margin, bbox[1, 1] + margin + resolution, resolution)
    XX, YY = np.meshgrid(xs, ys)

    n = XX.size
    origins = np.column_stack([XX.ravel(), YY.ravel(), np.full(n, bbox[1, 2] + 10.0)])
    dirs = np.zeros((n, 3), dtype=float)
    dirs[:, 2] = -1.0

    locs, ray_idx, _ = mesh.ray.intersects_location(origins, dirs, multiple_hits=True)

    Z = np.full(XX.shape, np.nan)
    if len(ray_idx) > 0:
        df = pd.DataFrame({'ri': ray_idx.astype(int), 'z': locs[:, 2]})
        best = df.loc[df.groupby('ri')['z'].idxmax()]
        rows = best['ri'].values // len(xs)
        cols = best['ri'].values % len(xs)
        Z[rows, cols] = best['z'].values

    return xs, ys, Z


def sample_surface(
    mesh: trimesh.Trimesh,
    grid_spacing: float,
    edge_margin: float = 5.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Sample the mesh surface on a regular grid and apply edge erosion.

    For each grid cell (x, y), a downward ray finds the topmost surface Z.
    Cells within `edge_margin` mm of the mesh boundary are discarded: a cell
    is kept only if every cell within a circle of radius `edge_margin` is also
    a valid hit (scipy binary_erosion with a circular structuring element).

    Returns:
        surface_pts:  (N, 3) kept surface points [x, y, z]
        edge_pts:     (M, 3) edge-discarded surface points
        valid_grid:   2D bool array of raw raycast hits
        eroded_grid:  2D bool array after erosion
        xs:           x axis of the grid
        ys:           y axis of the grid
    """
    bbox = mesh.bounds
    xs = np.arange(bbox[0, 0], bbox[1, 0] + grid_spacing, grid_spacing)
    ys = np.arange(bbox[0, 1], bbox[1, 1] + grid_spacing, grid_spacing)
    XX, YY = np.meshgrid(xs, ys)

    n = XX.size
    origins = np.column_stack([XX.ravel(), YY.ravel(), np.full(n, bbox[1, 2] + 10.0)])
    dirs = np.zeros((n, 3), dtype=float)
    dirs[:, 2] = -1.0

    locs, ray_idx, _ = mesh.ray.intersects_location(origins, dirs, multiple_hits=True)

    valid_grid = np.zeros(XX.shape, dtype=bool)
    z_grid = np.full(XX.shape, np.nan)

    if len(ray_idx) > 0:
        df = pd.DataFrame({'ri': ray_idx.astype(int), 'z': locs[:, 2]})
        best = df.loc[df.groupby('ri')['z'].idxmax()]
        rows = best['ri'].values // len(xs)
        cols = best['ri'].values % len(xs)
        valid_grid[rows, cols] = True
        z_grid[rows, cols] = best['z'].values

    # Circular structuring element for erosion
    r = int(np.ceil(edge_margin / grid_spacing))
    yi, xi = np.ogrid[-r:r + 1, -r:r + 1]
    struct = (xi ** 2 + yi ** 2) <= r ** 2
    eroded_grid = binary_erosion(valid_grid, structure=struct, border_value=0)

    # Collect kept and discarded points
    rows_all, cols_all = np.where(valid_grid)
    kept_mask = eroded_grid[rows_all, cols_all]

    surface_pts = np.column_stack([
        xs[cols_all[kept_mask]],
        ys[rows_all[kept_mask]],
        z_grid[rows_all[kept_mask]],
    ]) if kept_mask.any() else np.empty((0, 3))

    edge_pts = np.column_stack([
        xs[cols_all[~kept_mask]],
        ys[rows_all[~kept_mask]],
        z_grid[rows_all[~kept_mask]],
    ]) if (~kept_mask).any() else np.empty((0, 3))

    return surface_pts, edge_pts, valid_grid, eroded_grid, xs, ys


def make_toolpath(surface_pts: np.ndarray, H_intended: float) -> np.ndarray:
    """
    Lift each surface point by H_intended to get the commanded nozzle Z.

    Returns (N, 4): [x, y, Z_cmd, Z_surface_on_corrupted_mesh]
    """
    Z_cmd = surface_pts[:, 2] + H_intended
    return np.column_stack([surface_pts[:, 0], surface_pts[:, 1], Z_cmd, surface_pts[:, 2]])


def check_collisions(
    hf_xs: np.ndarray,
    hf_ys: np.ndarray,
    hf_Z: np.ndarray,
    toolpath: np.ndarray,
    nozzle_length: float,
    print_head_min: tuple[float, float],
    print_head_max: tuple[float, float],
    safety_clearance: float = 0.0,
) -> pd.DataFrame:
    """
    Simulate running `toolpath` (generated from a corrupted mesh) over the
    original mesh and detect two classes of collision:

    Tip collision:
        The actual surface directly below the nozzle tip is above Z_cmd
        (i.e., actual_H <= safety_clearance). Mirrors the tip-clearance
        check implied by getRequiredZOffset in the design tool.

    Body collision:
        Any height-field cell inside the print head rectangle rises above
        Z_cmd + nozzle_length, meaning the carriage/heat-block would strike
        a raised feature of the object. Mirrors the meshIntersectsSquareAtZ
        logic in the design tool, using the same printHeadDims defaults.

    Args:
        hf_xs, hf_ys, hf_Z: precomputed height field of the ORIGINAL mesh
        toolpath:            (N, 4) array from make_toolpath()
        nozzle_length:       distance from nozzle tip to bottom of body (mm)
        print_head_min/max:  XY extent of print head rectangle relative to nozzle
        safety_clearance:    minimum acceptable actual_H for tip (mm)

    Returns:
        DataFrame with columns: x, y, Z_cmd, actual_H,
                                 tip_collision, body_collision, off_object
    """
    xs_tp = toolpath[:, 0]
    ys_tp = toolpath[:, 1]
    Z_cmd = toolpath[:, 2]

    # Vectorised nearest-neighbour lookup for tip collision
    ix = np.argmin(np.abs(xs_tp[:, None] - hf_xs[None, :]), axis=1)
    iy = np.argmin(np.abs(ys_tp[:, None] - hf_ys[None, :]), axis=1)
    Z_actual = hf_Z[iy, ix]

    actual_H = Z_cmd - Z_actual
    off_object = np.isnan(Z_actual)
    tip_collision = ~off_object & (actual_H <= safety_clearance)

    # Body collision — loop (each point slices a different patch of the height field)
    ph_min_x, ph_min_y = print_head_min
    ph_max_x, ph_max_y = print_head_max
    body_collision = np.zeros(len(toolpath), dtype=bool)

    for i in range(len(toolpath)):
        if off_object[i]:
            continue

        x, y, Zc = xs_tp[i], ys_tp[i], Z_cmd[i]
        Z_body_start = Zc + nozzle_length

        x_lo = max(0, np.searchsorted(hf_xs, x + ph_min_x, side='left'))
        x_hi = min(len(hf_xs), np.searchsorted(hf_xs, x + ph_max_x, side='right'))
        y_lo = max(0, np.searchsorted(hf_ys, y + ph_min_y, side='left'))
        y_hi = min(len(hf_ys), np.searchsorted(hf_ys, y + ph_max_y, side='right'))

        if x_hi <= x_lo or y_hi <= y_lo:
            continue

        patch = hf_Z[y_lo:y_hi, x_lo:x_hi]
        if patch.size > 0:
            body_collision[i] = np.nanmax(patch) > Z_body_start

    return pd.DataFrame({
        'x': xs_tp,
        'y': ys_tp,
        'Z_cmd': Z_cmd,
        'actual_H': actual_H,
        'tip_collision': tip_collision,
        'body_collision': body_collision,
        'off_object': off_object,
    })
