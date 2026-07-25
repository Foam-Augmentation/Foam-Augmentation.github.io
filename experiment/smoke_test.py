import sys, os
sys.path.insert(0, os.path.dirname(__file__))

import numpy as np
import trimesh
from simulate import compute_heightfield, sample_surface, make_toolpath, check_collisions
from corrupt import corrupt_normal_noise, corrupt_scale

MESH_PATH = os.path.join(os.path.dirname(__file__), '..', 'STLs', 'bike_seat.stl')

print("Loading mesh...")
mesh = trimesh.load(MESH_PATH, force='mesh')
print(f"  {len(mesh.vertices):,} verts | bounds Z=[{mesh.bounds[0,2]:.1f}, {mesh.bounds[1,2]:.1f}] mm")

print("Computing height field...")
xs, ys, Z = compute_heightfield(mesh, resolution=1.0, margin=20.0)
print(f"  shape={Z.shape}, {np.isnan(Z).mean()*100:.1f}% NaN")

print("Sampling surface...")
sp, ep, _, _, _, _ = sample_surface(mesh, grid_spacing=3.0, edge_margin=5.0)
print(f"  {len(sp)} kept, {len(ep)} edge-discarded")

print("Testing corruption + collision check...")
noisy = corrupt_normal_noise(mesh, sigma=2.0)
sp2, _, _, _, _, _ = sample_surface(noisy, grid_spacing=3.0, edge_margin=5.0)
tp = make_toolpath(sp2, H_intended=20 * 0.4)
df = check_collisions(xs, ys, Z, tp, nozzle_length=4.5,
                      print_head_min=(-40, -15), print_head_max=(35, 70))
print(f"  tip_collisions={df['tip_collision'].sum()} / {len(df)}, "
      f"body_collisions={df['body_collision'].sum()} / {len(df)}")

print("\nSmoke test passed.")
