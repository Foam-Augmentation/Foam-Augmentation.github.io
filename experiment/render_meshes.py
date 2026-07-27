"""
Render original and corrupted meshes side by side using pyvista.
Smooth Phong shading, perspective camera, correct aspect ratios.
"""
import os, sys, glob
import numpy as np
import trimesh
import pyvista as pv

sys.path.insert(0, os.path.dirname(__file__))
from corrupt import corrupt_normal_noise, corrupt_scale

STL_DIR    = os.path.join(os.path.dirname(__file__), '..', 'STLs')
OUTPUT_DIR = os.path.dirname(__file__)

MESH_COLOR = '#c8d4e0'   # neutral blue-gray
BG_COLOR   = 'white'
PANEL_W    = 520
PANEL_H    = 440


def trimesh_to_pv(mesh: trimesh.Trimesh) -> pv.PolyData:
    v = mesh.vertices.astype(np.float64)
    f = mesh.faces.astype(np.int32)
    faces_pv = np.hstack([np.full((len(f), 1), 3, dtype=np.int32), f]).ravel()
    return pv.PolyData(v, faces_pv)


def make_camera(bounds: np.ndarray, azimuth_deg: float = 35, elevation_deg: float = 22):
    """
    Return a pyvista CameraPosition for a natural perspective view.
    azimuth/elevation control the viewing angle; distance is set to frame
    the whole object with a narrow (30°) FOV so proportions look realistic.
    """
    center  = bounds.mean(axis=0)
    extents = bounds[1] - bounds[0]
    # Distance so the object fills ~70% of the frame at 30° FOV
    dist = extents.max() / (2 * np.tan(np.radians(15))) * 1.4

    az  = np.radians(azimuth_deg)
    el  = np.radians(elevation_deg)
    offset = dist * np.array([
        np.cos(el) * np.cos(az),
        np.cos(el) * np.sin(az),
        np.sin(el),
    ])
    cam_pos = center + offset
    return [tuple(cam_pos), tuple(center), (0.0, 0.0, 1.0)]


for stl_path in sorted(glob.glob(os.path.join(STL_DIR, '*.stl'))):
    mesh_name = os.path.splitext(os.path.basename(stl_path))[0]
    print(f"\nRendering {mesh_name} ...")

    original: trimesh.Trimesh = trimesh.load(stl_path, force='mesh')

    np.random.seed(0)
    cases = [
        ('Original',          original),
        ('Noise  σ = 0.5 mm', corrupt_normal_noise(original, 0.5)),
        ('Noise  σ = 2 mm',   corrupt_normal_noise(original, 2.0)),
        ('Scale  80 %',       corrupt_scale(original, 0.80)),
        ('Scale 120 %',       corrupt_scale(original, 1.20)),
        ('80 % + σ = 2 mm',   corrupt_scale(corrupt_normal_noise(original, 2.0), 0.80)),
    ]

    n_cols = 3
    n_rows = 2
    cam_pos = make_camera(original.bounds)

    plotter = pv.Plotter(
        shape=(n_rows, n_cols),
        off_screen=True,
        window_size=[n_cols * PANEL_W, n_rows * PANEL_H],
        border=False,
    )

    for i, (title, mesh) in enumerate(cases):
        row, col = divmod(i, n_cols)
        plotter.subplot(row, col)
        plotter.set_background(BG_COLOR)

        pv_mesh = trimesh_to_pv(mesh)

        plotter.add_mesh(
            pv_mesh,
            smooth_shading=True,
            color=MESH_COLOR,
            ambient=0.25,
            diffuse=0.75,
            specular=0.45,
            specular_power=25,
            show_edges=False,
        )

        plotter.camera_position = cam_pos
        plotter.camera.view_angle = 30          # telephoto — natural proportions
        plotter.reset_camera_clipping_range()

        # Title inside the panel
        plotter.add_text(
            title,
            position='upper_edge',
            font_size=12,
            color='#222222',
            font='arial',
        )

    out_path = os.path.join(OUTPUT_DIR, f'{mesh_name}_mesh_examples.png')
    plotter.screenshot(out_path, transparent_background=False)
    plotter.close()
    print(f"  Saved to {out_path}")

print("\nDone.")
