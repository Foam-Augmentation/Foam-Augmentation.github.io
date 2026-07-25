"""
AugPrint mesh-corruption experiment.

Tests how VTP augmentation tolerates low-fidelity meshes by:
  1. Corrupting the reference mesh (normal-direction noise or uniform scale)
  2. Generating a toolpath from the corrupted mesh at a given H*
  3. Simulating that toolpath over the original mesh
  4. Reporting tip and body collision rates

Set PREVIEW = True to inspect the toolpath coverage and edge erosion on the
original mesh before committing to a full simulation run.
"""

import os
import sys
import numpy as np
import pandas as pd
import trimesh

# ── make local imports work regardless of working directory ───────────────────
sys.path.insert(0, os.path.dirname(__file__))

from corrupt import corrupt_normal_noise, corrupt_scale
from simulate import compute_heightfield, sample_surface, make_toolpath, check_collisions
from visualize import preview_comparison, plot_heatmaps

# =============================================================================
# Parameters — edit these
# =============================================================================

MESH_PATH   = os.path.join(os.path.dirname(__file__), '..', 'STLs', 'bike_seat.stl')
OUTPUT_DIR  = os.path.dirname(__file__)

PREVIEW     = True    # True → show toolpath preview on original mesh and exit

# Toolpath sampling
GRID_SPACING    = 3.0   # ΔL (mm) — spacing between toolpath points
EDGE_MARGIN     = 5.0   # (mm) — erode this far from the mesh boundary

# Height field (original mesh, computed once)
HF_RESOLUTION   = 1.0   # (mm) — grid resolution; finer = more accurate, slower
HF_MARGIN       = 20.0  # (mm) — extend height field beyond mesh bounds

# Experiment grid
HSTAR_VALUES    = [0.5, 10, 20, 30, 40, 50]  # 0.5 ≈ traditional FFF (H=0.2mm layer height)
NOISE_SIGMAS    = [0.5, 1.0, 2.0]                 # mm — normal-direction noise
SCALE_FACTORS   = [0.98, 0.95, 0.90, 0.80, 1.02, 1.05, 1.10, 1.20]  # <1 = shrink, >1 = grow

# Printer parameters — match Printer.ts defaults
NOZZLE_DIAMETER = 0.4           # mm
DIE_SWELLING    = 1.0           # α (dimensionless)
NOZZLE_LENGTH   = 4.5           # mm (nozzle tip to bottom of heat block/body)
PRINT_HEAD_MIN  = (-40.0, -15.0)  # mm relative to nozzle, (x_min, y_min)
PRINT_HEAD_MAX  = ( 35.0,  70.0)  # mm relative to nozzle, (x_max, y_max)
SAFETY_CLEARANCE = 0.0          # mm — tip collision threshold (actual_H <= this)

D_T = NOZZLE_DIAMETER * DIE_SWELLING  # thread diameter (mm)

# =============================================================================
# Load mesh
# =============================================================================

print(f"Loading mesh: {MESH_PATH}")
original: trimesh.Trimesh = trimesh.load(MESH_PATH, force='mesh')
print(f"  {len(original.vertices):,} vertices  |  {len(original.faces):,} faces")
print(f"  Bounds X [{original.bounds[0,0]:.1f}, {original.bounds[1,0]:.1f}] mm"
      f"  Y [{original.bounds[0,1]:.1f}, {original.bounds[1,1]:.1f}] mm"
      f"  Z [{original.bounds[0,2]:.1f}, {original.bounds[1,2]:.1f}] mm")

# =============================================================================
# Preview mode
# =============================================================================

if PREVIEW:
    print(f"\nPreview mode — sampling meshes (grid={GRID_SPACING} mm, edge_margin={EDGE_MARGIN} mm) ...")

    preview_cases = [
        ('Original',      original),
        ('Noise σ=0.5mm', corrupt_normal_noise(original, 0.5)),
        ('Noise σ=2mm',   corrupt_normal_noise(original, 2.0)),
        ('Scale 80%',     corrupt_scale(original, 0.80)),
        ('Scale 90%',     corrupt_scale(original, 0.90)),
        ('Scale 110%',    corrupt_scale(original, 1.10)),
        ('Scale 120%',    corrupt_scale(original, 1.20)),
    ]

    H_preview = 20 * D_T  # lift toolpath points by H* = 20 for visibility

    panels = []
    for title, mesh in preview_cases:
        sp, ep, _, _, _, _ = sample_surface(mesh, GRID_SPACING, EDGE_MARGIN)
        print(f"  {title:18s}  kept={len(sp):4d}  edge-discarded={len(ep):4d}")
        # Lift points to commanded nozzle height so they float above the mesh
        sp_lifted = sp.copy(); sp_lifted[:, 2] += H_preview
        ep_lifted = ep.copy(); ep_lifted[:, 2] += H_preview
        panels.append({'title': title, 'mesh': mesh, 'surface_pts': sp_lifted, 'edge_pts': ep_lifted})

    preview_comparison(panels, n_cols=2)
    sys.exit(0)

# =============================================================================
# Compute original mesh height field (done once)
# =============================================================================

print(f"\nComputing height field on original mesh "
      f"(resolution={HF_RESOLUTION} mm, margin={HF_MARGIN} mm) ...")
hf_xs, hf_ys, hf_Z = compute_heightfield(original, HF_RESOLUTION, HF_MARGIN)
print(f"  Height field shape: {hf_Z.shape}  "
      f"({hf_Z.shape[1]} × {hf_Z.shape[0]} cells, "
      f"{np.isnan(hf_Z).mean()*100:.1f}% off-surface)")

# =============================================================================
# Simulation loop
# =============================================================================

print("\nRunning simulation...\n")
all_results = []

for Hstar in HSTAR_VALUES:
    H_intended = Hstar * D_T
    print(f"── H* = {Hstar:2d}  (H = {H_intended:.1f} mm) ──────────────────────")

    # ── Normal-direction noise ────────────────────────────────────────────────
    for sigma in NOISE_SIGMAS:
        corrupted = corrupt_normal_noise(original, sigma)
        surface_pts, _, _, _, _, _ = sample_surface(corrupted, GRID_SPACING, EDGE_MARGIN)

        if len(surface_pts) == 0:
            print(f"  noise σ={sigma:4.1f} mm  →  no toolpath points after erosion")
            continue

        toolpath = make_toolpath(surface_pts, H_intended)
        df = check_collisions(
            hf_xs, hf_ys, hf_Z, toolpath,
            NOZZLE_LENGTH, PRINT_HEAD_MIN, PRINT_HEAD_MAX, SAFETY_CLEARANCE,
        )

        n          = len(df)
        tip_rate   = df['tip_collision'].sum()  / n * 100
        body_rate  = df['body_collision'].sum() / n * 100
        off_rate   = df['off_object'].sum()     / n * 100

        print(f"  noise σ={sigma:4.1f} mm  |  n={n:4d}  "
              f"tip={tip_rate:5.1f}%  body={body_rate:5.1f}%  off={off_rate:5.1f}%")

        all_results.append({
            'corruption': 'noise',
            'magnitude': sigma,
            'Hstar': Hstar,
            'H_mm': H_intended,
            'n_points': n,
            'tip_collision_rate': tip_rate,
            'body_collision_rate': body_rate,
            'off_object_rate': off_rate,
        })

    # ── Uniform scale ─────────────────────────────────────────────────────────
    for factor in SCALE_FACTORS:
        corrupted = corrupt_scale(original, factor)
        surface_pts, _, _, _, _, _ = sample_surface(corrupted, GRID_SPACING, EDGE_MARGIN)

        if len(surface_pts) == 0:
            print(f"  scale {factor:.0%}  →  no toolpath points after erosion")
            continue

        toolpath = make_toolpath(surface_pts, H_intended)
        df = check_collisions(
            hf_xs, hf_ys, hf_Z, toolpath,
            NOZZLE_LENGTH, PRINT_HEAD_MIN, PRINT_HEAD_MAX, SAFETY_CLEARANCE,
        )

        n          = len(df)
        tip_rate   = df['tip_collision'].sum()  / n * 100
        body_rate  = df['body_collision'].sum() / n * 100
        off_rate   = df['off_object'].sum()     / n * 100

        print(f"  scale  {factor:.0%}     |  n={n:4d}  "
              f"tip={tip_rate:5.1f}%  body={body_rate:5.1f}%  off={off_rate:5.1f}%")

        all_results.append({
            'corruption': 'scale',
            'magnitude': factor,
            'Hstar': Hstar,
            'H_mm': H_intended,
            'n_points': n,
            'tip_collision_rate': tip_rate,
            'body_collision_rate': body_rate,
            'off_object_rate': off_rate,
        })

    print()

# =============================================================================
# Save and plot
# =============================================================================

results_df = pd.DataFrame(all_results)
csv_path = os.path.join(OUTPUT_DIR, 'results.csv')
results_df.to_csv(csv_path, index=False)
print(f"Results saved to {csv_path}\n")
print(results_df.to_string(index=False))

plot_heatmaps(results_df, OUTPUT_DIR)
