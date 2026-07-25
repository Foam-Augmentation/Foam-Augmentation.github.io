import numpy as np
import trimesh
from scipy.interpolate import RegularGridInterpolator


def corrupt_normal_noise(
    mesh: trimesh.Trimesh,
    sigma: float,
    correlation_length: float = 20.0,
) -> trimesh.Trimesh:
    """
    Apply spatially correlated normal-direction noise to the mesh.

    Rather than perturbing each vertex independently (which produces an
    unrealistic fuzzy blob), noise values are generated on a coarse 3D grid
    with spacing `correlation_length` and then trilinearly interpolated to
    each vertex. This ensures that nearby vertices move together smoothly,
    mimicking the regional errors typical of photogrammetry or structured-
    light scanning (e.g., a poorly reconstructed patch shifts as a whole).

    sigma:              std dev of the noise field in mm
    correlation_length: spatial scale of perturbations in mm — larger means
                        smoother, broader deformations
    """
    bbox = mesh.bounds
    pad = correlation_length

    xs = np.arange(bbox[0, 0] - pad, bbox[1, 0] + pad + correlation_length, correlation_length)
    ys = np.arange(bbox[0, 1] - pad, bbox[1, 1] + pad + correlation_length, correlation_length)
    zs = np.arange(bbox[0, 2] - pad, bbox[1, 2] + pad + correlation_length, correlation_length)

    noise_grid = np.random.normal(0.0, sigma, (len(xs), len(ys), len(zs)))

    interp = RegularGridInterpolator(
        (xs, ys, zs), noise_grid,
        method='linear', bounds_error=False, fill_value=0.0,
    )
    noise_per_vertex = interp(mesh.vertices)

    new_verts = mesh.vertices + noise_per_vertex[:, None] * mesh.vertex_normals
    return trimesh.Trimesh(vertices=new_verts, faces=mesh.faces.copy(), process=False)


def corrupt_scale(mesh: trimesh.Trimesh, factor: float) -> trimesh.Trimesh:
    """
    Scale the mesh uniformly about its centroid by the given factor.
    Models global calibration errors (e.g., incorrect camera intrinsics in
    photogrammetry that uniformly shrink or expand the reconstructed mesh).
    """
    centroid = mesh.centroid
    new_verts = centroid + (mesh.vertices - centroid) * factor
    return trimesh.Trimesh(vertices=new_verts, faces=mesh.faces.copy(), process=False)
