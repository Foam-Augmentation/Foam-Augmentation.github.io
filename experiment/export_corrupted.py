"""Export corrupted mesh variants as STL files."""
import os, sys, glob
import numpy as np
import trimesh

sys.path.insert(0, os.path.dirname(__file__))
from corrupt import corrupt_normal_noise, corrupt_scale

STL_DIR    = os.path.join(os.path.dirname(__file__), '..', 'STLs')
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'STLs', 'corrupted')
os.makedirs(OUTPUT_DIR, exist_ok=True)

for stl_path in sorted(glob.glob(os.path.join(STL_DIR, '*.stl'))):
    name = os.path.splitext(os.path.basename(stl_path))[0]
    original = trimesh.load(stl_path, force='mesh')
    np.random.seed(0)

    cases = [
        ('original',           original),
        ('noise_0.5mm',        corrupt_normal_noise(original, 0.5)),
        ('noise_2mm',          corrupt_normal_noise(original, 2.0)),
        ('scale_80pct',        corrupt_scale(original, 0.80)),
        ('scale_120pct',       corrupt_scale(original, 1.20)),
        ('combined_80pct_2mm', corrupt_scale(corrupt_normal_noise(original, 2.0), 0.80)),
    ]

    for suffix, mesh in cases:
        out = os.path.join(OUTPUT_DIR, f'{name}_{suffix}.stl')
        mesh.export(out)
        print(f'Saved {out}')
