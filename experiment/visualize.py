import os
import math
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors
import matplotlib.cm as cm


# ── Mesh example renders ───────────────────────────────────────────────────────

def render_mesh_examples(cases: list, ref_bounds: np.ndarray, output_path: str,
                         n_cols: int = 3) -> None:
    """
    Render a grid of corrupted mesh 3D views to a PNG.

    cases: list of (title, trimesh.Trimesh)
    ref_bounds: original mesh bounds (2,3) — fixes axis limits across all panels
                so scale changes are visually apparent.
    """
    from mpl_toolkits.mplot3d import Axes3D  # noqa: F401

    n = len(cases)
    n_rows = math.ceil(n / n_cols)
    pad = 8.0
    xlim = (ref_bounds[0, 0] - pad, ref_bounds[1, 0] + pad)
    ylim = (ref_bounds[0, 1] - pad, ref_bounds[1, 1] + pad)
    zlim = (ref_bounds[0, 2] - pad, ref_bounds[1, 2] + pad)

    fig = plt.figure(figsize=(6 * n_cols, 5 * n_rows))

    for i, (title, mesh) in enumerate(cases):
        ax = fig.add_subplot(n_rows, n_cols, i + 1, projection='3d')

        verts = mesh.vertices
        faces = mesh.faces

        # Subsample faces so rendering stays fast
        max_faces = 8000
        if len(faces) > max_faces:
            idx = np.random.choice(len(faces), max_faces, replace=False)
            faces = faces[idx]

        ax.plot_trisurf(verts[:, 0], verts[:, 1], verts[:, 2],
                        triangles=faces, cmap='Blues',
                        linewidth=0, alpha=1.0)

        ax.set_xlim(*xlim)
        ax.set_ylim(*ylim)
        ax.set_zlim(*zlim)
        ax.set_title(title, fontsize=11, pad=4)
        ax.set_xticklabels([])
        ax.set_yticklabels([])
        ax.set_zticklabels([])
        ax.view_init(elev=25, azim=-55)

    # Hide any unused subplot slots
    for j in range(n, n_rows * n_cols):
        fig.add_subplot(n_rows, n_cols, j + 1).set_visible(False)

    plt.suptitle('Mesh Corruption Examples', fontsize=13, fontweight='bold', y=1.01)
    plt.tight_layout()
    plt.savefig(output_path, dpi=120, bbox_inches='tight')
    print(f"Mesh examples saved to {output_path}")
    os.startfile(output_path)
    plt.close(fig)


# ── Any-collision heatmap (seaborn) ───────────────────────────────────────────

def plot_any_collision_heatmap(results_df: pd.DataFrame, output_path: str) -> None:
    """
    Three-panel seaborn heatmap: noise | scale | combined.
    Metric: max(tip_collision_rate, body_collision_rate).
    """
    import seaborn as sns

    df = results_df.copy()
    df['any_collision_rate'] = np.maximum(
        df['tip_collision_rate'], df['body_collision_rate'])

    Hstar_values = sorted(df['Hstar'].unique())
    hstar_labels = [f'H* = {h:g}' for h in Hstar_values]

    panels = [
        ('noise',    'Noise σ (mm)',         lambda m: f'{m:g}'),
        ('scale',    'Scale factor',         lambda m: f'{int(round(m * 100))}%'),
        ('combined', 'Scale (+σ=2 mm noise)', lambda m: f'{int(round(m * 100))}%'),
    ]

    cmap = plt.cm.RdYlGn_r
    norm = mcolors.Normalize(vmin=0, vmax=100)

    fig, axes = plt.subplots(1, 3, figsize=(22, 8))
    fig.suptitle('Any Collision Rate (%) vs. H* and Mesh Corruption',
                 fontsize=18, fontweight='bold', y=1.01)

    for ax, (corruption_type, x_label, fmt_mag) in zip(axes, panels):
        sub = df[df['corruption'] == corruption_type]
        if sub.empty:
            ax.set_visible(False)
            continue
        magnitudes = sorted(sub['magnitude'].unique())

        matrix = np.full((len(Hstar_values), len(magnitudes)), np.nan)
        for i, h in enumerate(Hstar_values):
            for j, m in enumerate(magnitudes):
                row = sub[(sub['Hstar'] == h) & (sub['magnitude'] == m)]
                if not row.empty:
                    matrix[i, j] = row['any_collision_rate'].values[0]

        annot = np.where(
            np.isnan(matrix), '',
            np.vectorize(lambda v: f'{v:.0f}%')(matrix)
        )

        col_labels = [fmt_mag(m) for m in magnitudes]
        df_plot = pd.DataFrame(matrix, index=hstar_labels, columns=col_labels)

        sns.heatmap(
            df_plot, ax=ax,
            cmap=cmap, norm=norm,
            annot=annot, fmt='s',
            linewidths=0.4, linecolor='#cccccc',
            cbar=False,
            annot_kws={'fontsize': 16, 'fontweight': 'bold'},
        )
        ax.set_title(x_label, fontsize=17, pad=12)
        ax.set_xlabel('')
        ax.set_ylabel('H*' if ax is axes[0] else '', fontsize=15)
        ax.tick_params(axis='x', rotation=45, labelsize=14)
        ax.tick_params(axis='y', rotation=0, labelsize=14)

    sm = cm.ScalarMappable(cmap=cmap, norm=norm)
    cbar = fig.colorbar(sm, ax=axes.tolist(),
                        label='Any collision rate (%)', shrink=0.85, pad=0.02)
    cbar.ax.tick_params(labelsize=14)
    cbar.set_label('Any collision rate (%)', fontsize=15)

    plt.tight_layout()
    plt.savefig(output_path, bbox_inches='tight')
    print(f"Heatmap saved to {output_path}")
    os.startfile(output_path)
    plt.close(fig)


# ── Legacy helpers ─────────────────────────────────────────────────────────────

def preview_comparison(panels: list, n_cols: int = 2) -> None:
    from mpl_toolkits.mplot3d import Axes3D  # noqa: F401
    n = len(panels)
    n_rows = math.ceil(n / n_cols)
    ref_bounds = panels[0]['mesh'].bounds
    pad = 5.0
    xlim = (ref_bounds[0, 0] - pad, ref_bounds[1, 0] + pad)
    ylim = (ref_bounds[0, 1] - pad, ref_bounds[1, 1] + pad)
    zlim = (ref_bounds[0, 2] - pad, ref_bounds[1, 2] + 30.0)
    fig = plt.figure(figsize=(7 * n_cols, 6 * n_rows))
    for i, panel in enumerate(panels):
        ax = fig.add_subplot(n_rows, n_cols, i + 1, projection='3d')
        sp = panel['surface_pts']
        ep = panel['edge_pts']
        if len(ep) > 0:
            ax.scatter(ep[:, 0], ep[:, 1], ep[:, 2], c='red', s=40, depthshade=False)
        if len(sp) > 0:
            ax.scatter(sp[:, 0], sp[:, 1], sp[:, 2], c='green', s=40, depthshade=False)
        ax.set_xlim(*xlim); ax.set_ylim(*ylim); ax.set_zlim(*zlim)
        ax.set_title(panel['title'], fontsize=11)
        ax.set_xticklabels([]); ax.set_yticklabels([]); ax.set_zticklabels([])
        ax.view_init(elev=30, azim=-60)
    plt.tight_layout()
    out_path = os.path.join(os.path.dirname(__file__), 'preview.png')
    plt.savefig(out_path, dpi=120, bbox_inches='tight')
    print(f"Preview saved to {out_path}")
    os.startfile(out_path)
    plt.close(fig)
