"""
Diagnostic script: spot-check the collision detection pipeline.
"""
import sys, os
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))

import trimesh
from corrupt import corrupt_normal_noise
from simulate import compute_heightfield, sample_surface, make_toolpath, check_collisions

MESH_PATH = os.path.join(os.path.dirname(__file__), '..', 'STLs', 'bike_seat.stl')
original = trimesh.load(MESH_PATH, force='mesh')

D_T = 0.4
H_intended = 0.5 * D_T   # H* = 0.5 → H = 0.2mm

print("=== Height field ===")
hf_xs, hf_ys, hf_Z = compute_heightfield(original, resolution=1.0, margin=20.0)
print(f"  hf_xs: {hf_xs[0]:.1f} to {hf_xs[-1]:.1f}  ({len(hf_xs)} cells)")
print(f"  hf_ys: {hf_ys[0]:.1f} to {hf_ys[-1]:.1f}  ({len(hf_ys)} cells)")
print(f"  hf_Z range (non-NaN): {np.nanmin(hf_Z):.2f} to {np.nanmax(hf_Z):.2f}")
print(f"  NaN fraction: {np.isnan(hf_Z).mean()*100:.1f}%")

print("\n=== Corrupted mesh (noise sigma=2mm) ===")
np.random.seed(42)
corrupted = corrupt_normal_noise(original, sigma=2.0)
print(f"  Original Z range: {original.bounds[0,2]:.2f} to {original.bounds[1,2]:.2f}")
print(f"  Corrupted Z range: {corrupted.bounds[0,2]:.2f} to {corrupted.bounds[1,2]:.2f}")

# Vertex-level Z change
dz = corrupted.vertices[:, 2] - original.vertices[:, 2]
print(f"  Per-vertex dZ: min={dz.min():.3f}  max={dz.max():.3f}  std={dz.std():.3f}")

print("\n=== Toolpath from corrupted mesh ===")
surface_pts, _, _, _, _, _ = sample_surface(corrupted, grid_spacing=3.0, edge_margin=5.0)
print(f"  {len(surface_pts)} surface points")
print(f"  Z range of surface points: {surface_pts[:,2].min():.2f} to {surface_pts[:,2].max():.2f}")

toolpath = make_toolpath(surface_pts, H_intended)
print(f"  Z_cmd range: {toolpath[:,2].min():.2f} to {toolpath[:,2].max():.2f}")

print("\n=== Collision check ===")
df = check_collisions(
    hf_xs, hf_ys, hf_Z, toolpath,
    nozzle_length=4.5,
    print_head_min=(-40., -15.),
    print_head_max=(35., 70.),
    safety_clearance=0.0,
)
print(f"  actual_H: min={df['actual_H'].min():.3f}  max={df['actual_H'].max():.3f}  mean={df['actual_H'].mean():.3f}")
print(f"  off_object: {df['off_object'].sum()} / {len(df)}")
print(f"  tip_collisions: {df['tip_collision'].sum()} / {len(df)}")
print(f"  body_collisions: {df['body_collision'].sum()} / {len(df)}")

print("\n=== Sample of lowest actual_H points ===")
valid = df[~df['off_object']].nsmallest(10, 'actual_H')
print(valid[['x','y','Z_cmd','actual_H','tip_collision']].to_string(index=False))

print("\n=== Direct comparison: original vs corrupted surface Z at toolpath XY ===")
# For 10 toolpath points, look up both original and corrupted surface Z
from scipy.interpolate import RegularGridInterpolator
# Rebuild corrupted height field on the fly
hf_xs_c, hf_ys_c, hf_Z_c = compute_heightfield(corrupted, resolution=1.0, margin=5.0)
interp_orig = RegularGridInterpolator(
    (hf_ys, hf_xs), hf_Z, method='nearest', bounds_error=False, fill_value=np.nan)
interp_corr = RegularGridInterpolator(
    (hf_ys_c, hf_xs_c), hf_Z_c, method='nearest', bounds_error=False, fill_value=np.nan)

pts_xy = surface_pts[:, :2]
z_orig = interp_orig(pts_xy[:, ::-1])   # (y, x) order
z_corr = interp_corr(pts_xy[:, ::-1])
dz_surface = z_corr - z_orig

print(f"  Surface dZ (corrupted - original):")
print(f"    min={np.nanmin(dz_surface):.3f}  max={np.nanmax(dz_surface):.3f}  std={np.nanstd(dz_surface):.3f}")
print(f"    Points where corrupted surface > 0.2mm BELOW original: {np.sum(dz_surface < -0.2)}")
print(f"    Points where corrupted surface > 1mm BELOW original: {np.sum(dz_surface < -1.0)}")
