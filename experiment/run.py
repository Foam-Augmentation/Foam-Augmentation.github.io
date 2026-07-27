"""
AugPrint mesh-corruption experiment.

For each STL in STLs/:
  1. Renders examples of each corruption type (mesh_examples.png)
  2. Pre-computes corrupted surface points (expensive raycasting done once)
  3. Sweeps H* values and reports averaged collision rates (N_TRIALS each)
  4. Saves per-mesh results CSV and any-collision heatmap PNG

Corruption types
----------------
  noise    : spatially correlated normal-direction noise (sigma in NOISE_SIGMAS)
  scale    : uniform scale about centroid (factors in SCALE_FACTORS)
  combined : same noise realization applied to original, THEN scaled — ensures
             collision rates change monotonically with scale factor
"""

import os
import sys
import glob
import numpy as np
import pandas as pd
import trimesh

sys.path.insert(0, os.path.dirname(__file__))

from corrupt import corrupt_normal_noise, corrupt_scale
from simulate import compute_heightfield, sample_surface, make_toolpath, check_collisions
from visualize import render_mesh_examples, plot_any_collision_heatmap

# =============================================================================
# Parameters
# =============================================================================

STL_DIR      = os.path.join(os.path.dirname(__file__), '..', 'STLs')
OUTPUT_DIR   = os.path.dirname(__file__)

N_TRIALS     = 5       # averages for stochastic (noise / combined) conditions

GRID_SPACING    = 3.0
EDGE_MARGIN     = 5.0
HF_RESOLUTION   = 1.0
HF_MARGIN       = 20.0

HSTAR_VALUES    = [0.5, 1, 2, 3, 5, 7, 10, 20, 30, 40, 50]
NOISE_SIGMAS    = [0.5, 1.0, 2.0]
SCALE_FACTORS   = [0.98, 0.95, 0.90, 0.80, 1.02, 1.05, 1.10, 1.20]
COMBINED_NOISE_SIGMA = 2.0   # noise applied before scaling in combined condition

NOZZLE_DIAMETER  = 0.4
DIE_SWELLING     = 1.0
NOZZLE_LENGTH    = 4.5
PRINT_HEAD_MIN   = (-40.0, -15.0)
PRINT_HEAD_MAX   = ( 35.0,  70.0)
SAFETY_CLEARANCE = 0.0

D_T = NOZZLE_DIAMETER * DIE_SWELLING

# =============================================================================
# Helper
# =============================================================================

def _collision_rates(surface_pts, H_intended, hf_xs, hf_ys, hf_Z):
    if len(surface_pts) == 0:
        return None
    tp = make_toolpath(surface_pts, H_intended)
    df = check_collisions(hf_xs, hf_ys, hf_Z, tp,
                          NOZZLE_LENGTH, PRINT_HEAD_MIN, PRINT_HEAD_MAX,
                          SAFETY_CLEARANCE)
    n = len(df)
    return (df['tip_collision'].sum()  / n * 100,
            df['body_collision'].sum() / n * 100,
            df['off_object'].sum()     / n * 100)


# =============================================================================
# Main loop over STL files
# =============================================================================

stl_paths = sorted(glob.glob(os.path.join(STL_DIR, '*.stl')))
if not stl_paths:
    print(f"No STL files found in {STL_DIR}")
    sys.exit(1)

for stl_path in stl_paths:
    mesh_name = os.path.splitext(os.path.basename(stl_path))[0]
    print(f"\n{'='*70}")
    print(f"Mesh: {mesh_name}")
    print('='*70)

    original = trimesh.load(stl_path, force='mesh')
    print(f"  {len(original.vertices):,} vertices  |  {len(original.faces):,} faces")
    print(f"  Bounds X [{original.bounds[0,0]:.1f}, {original.bounds[1,0]:.1f}]  "
          f"Y [{original.bounds[0,1]:.1f}, {original.bounds[1,1]:.1f}]  "
          f"Z [{original.bounds[0,2]:.1f}, {original.bounds[1,2]:.1f}] mm")

    # ── Mesh example renders ──────────────────────────────────────────────────
    print("\nRendering mesh examples...")
    np.random.seed(0)
    example_cases = [
        ('Original',       original),
        ('Noise σ=0.5mm',  corrupt_normal_noise(original, 0.5)),
        ('Noise σ=1mm',    corrupt_normal_noise(original, 1.0)),
        ('Noise σ=2mm',    corrupt_normal_noise(original, 2.0)),
        ('Scale 80%',      corrupt_scale(original, 0.80)),
        ('Scale 90%',      corrupt_scale(original, 0.90)),
        ('Scale 110%',     corrupt_scale(original, 1.10)),
        ('Scale 120%',     corrupt_scale(original, 1.20)),
        ('80% + σ=2mm',    corrupt_scale(corrupt_normal_noise(original, 2.0), 0.80)),
    ]
    render_mesh_examples(
        example_cases, original.bounds,
        os.path.join(OUTPUT_DIR, f'{mesh_name}_mesh_examples.png'),
    )

    # ── Height field ─────────────────────────────────────────────────────────
    print(f"\nComputing height field (resolution={HF_RESOLUTION} mm) ...")
    hf_xs, hf_ys, hf_Z = compute_heightfield(original, HF_RESOLUTION, HF_MARGIN)
    print(f"  Shape: {hf_Z.shape}  ({np.isnan(hf_Z).mean()*100:.1f}% off-surface)")

    # ── Pre-compute surface points (raycasting, done once per corrupted mesh) ─
    print(f"\nPre-computing surface points ({N_TRIALS} trials for stochastic conditions)...")

    # Noise trials: N_TRIALS independent noise realizations per sigma
    noise_pts = {sigma: [] for sigma in NOISE_SIGMAS}
    for sigma in NOISE_SIGMAS:
        for t in range(N_TRIALS):
            sp, *_ = sample_surface(corrupt_normal_noise(original, sigma),
                                    GRID_SPACING, EDGE_MARGIN)
            noise_pts[sigma].append(sp)
        print(f"  Noise σ={sigma}mm — mean kept pts: "
              f"{np.mean([len(p) for p in noise_pts[sigma]]):.0f}")

    # Scale: deterministic (single sample)
    scale_pts = {}
    for factor in SCALE_FACTORS:
        sp, *_ = sample_surface(corrupt_scale(original, factor),
                                GRID_SPACING, EDGE_MARGIN)
        scale_pts[factor] = sp
    print(f"  Scale: {len(SCALE_FACTORS)} factors sampled")

    # Combined: N_TRIALS, same noise realization for all scale factors per trial
    combined_pts = {factor: [] for factor in SCALE_FACTORS}
    for t in range(N_TRIALS):
        noisy_base = corrupt_normal_noise(original, COMBINED_NOISE_SIGMA)
        for factor in SCALE_FACTORS:
            sp, *_ = sample_surface(corrupt_scale(noisy_base, factor),
                                    GRID_SPACING, EDGE_MARGIN)
            combined_pts[factor].append(sp)
    print(f"  Combined: {N_TRIALS} trials × {len(SCALE_FACTORS)} scale factors sampled")

    # ── Simulation loop over H* ───────────────────────────────────────────────
    print("\nRunning collision simulation...")
    all_results = []

    for Hstar in HSTAR_VALUES:
        H_intended = Hstar * D_T
        print(f"\n── H* = {Hstar}  (H = {H_intended:.2f} mm) ──")

        # Noise-only (averaged over N_TRIALS)
        for sigma in NOISE_SIGMAS:
            tip_acc, body_acc, off_acc = [], [], []
            for sp in noise_pts[sigma]:
                r = _collision_rates(sp, H_intended, hf_xs, hf_ys, hf_Z)
                if r:
                    tip_acc.append(r[0]); body_acc.append(r[1]); off_acc.append(r[2])
            if tip_acc:
                tip_m, body_m, off_m = np.mean(tip_acc), np.mean(body_acc), np.mean(off_acc)
                print(f"  noise σ={sigma:3.1f}mm  tip={tip_m:5.1f}%  body={body_m:5.1f}%  off={off_m:5.1f}%")
                all_results.append({'corruption': 'noise', 'magnitude': sigma,
                                    'Hstar': Hstar, 'H_mm': H_intended,
                                    'tip_collision_rate': tip_m,
                                    'body_collision_rate': body_m,
                                    'off_object_rate': off_m})

        # Scale-only (deterministic)
        for factor in SCALE_FACTORS:
            sp = scale_pts[factor]
            r = _collision_rates(sp, H_intended, hf_xs, hf_ys, hf_Z)
            if r:
                tip_m, body_m, off_m = r
                print(f"  scale  {factor:.0%}     tip={tip_m:5.1f}%  body={body_m:5.1f}%  off={off_m:5.1f}%")
                all_results.append({'corruption': 'scale', 'magnitude': factor,
                                    'Hstar': Hstar, 'H_mm': H_intended,
                                    'tip_collision_rate': tip_m,
                                    'body_collision_rate': body_m,
                                    'off_object_rate': off_m})

        # Combined (averaged over N_TRIALS, same noise per trial for all scales)
        for factor in SCALE_FACTORS:
            tip_acc, body_acc, off_acc = [], [], []
            for sp in combined_pts[factor]:
                r = _collision_rates(sp, H_intended, hf_xs, hf_ys, hf_Z)
                if r:
                    tip_acc.append(r[0]); body_acc.append(r[1]); off_acc.append(r[2])
            if tip_acc:
                tip_m, body_m, off_m = np.mean(tip_acc), np.mean(body_acc), np.mean(off_acc)
                print(f"  comb   {factor:.0%}+σ{COMBINED_NOISE_SIGMA}mm  "
                      f"tip={tip_m:5.1f}%  body={body_m:5.1f}%  off={off_m:5.1f}%")
                all_results.append({'corruption': 'combined', 'magnitude': factor,
                                    'Hstar': Hstar, 'H_mm': H_intended,
                                    'tip_collision_rate': tip_m,
                                    'body_collision_rate': body_m,
                                    'off_object_rate': off_m})

    # ── Save results and plot ─────────────────────────────────────────────────
    results_df = pd.DataFrame(all_results)
    csv_path = os.path.join(OUTPUT_DIR, f'{mesh_name}_results.csv')
    results_df.to_csv(csv_path, index=False)
    print(f"\nResults saved to {csv_path}")

    heatmap_path = os.path.join(OUTPUT_DIR, f'{mesh_name}_any_collision.svg')
    plot_any_collision_heatmap(results_df, heatmap_path)

print("\nAll meshes done.")
