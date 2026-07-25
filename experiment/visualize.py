import os
import math
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt


def preview_comparison(panels: list, n_cols: int = 2) -> None:
    """
    Multi-panel 3D preview saved as a PNG using matplotlib.

    Green dots = kept toolpath points, red dots = edge-discarded points.
    Mesh shown as a faint wireframe surface.

    panels: list of dicts with keys:
        title       : str
        mesh        : trimesh.Trimesh
        surface_pts : (N, 3) ndarray  (lifted to Z_cmd)
        edge_pts    : (M, 3) ndarray  (lifted to Z_cmd)
    """
    from mpl_toolkits.mplot3d import Axes3D  # noqa: F401

    n = len(panels)
    n_rows = math.ceil(n / n_cols)

    ref_bounds = panels[0]['mesh'].bounds
    pad = 5.0
    xlim = (ref_bounds[0, 0] - pad, ref_bounds[1, 0] + pad)
    ylim = (ref_bounds[0, 1] - pad, ref_bounds[1, 1] + pad)
    zlim = (ref_bounds[0, 2] - pad, ref_bounds[1, 2] + 30.0)

    fig = plt.figure(figsize=(7 * n_cols, 6 * n_rows))
    fig.suptitle(
        'AugPrint Preview — green: toolpath  |  red: edge-discarded',
        fontsize=13, fontweight='bold',
    )

    for i, panel in enumerate(panels):
        ax = fig.add_subplot(n_rows, n_cols, i + 1, projection='3d')

        sp    = panel['surface_pts']
        ep    = panel['edge_pts']

        if len(ep) > 0:
            ax.scatter(ep[:, 0], ep[:, 1], ep[:, 2],
                       c='red', s=40, depthshade=False)

        if len(sp) > 0:
            ax.scatter(sp[:, 0], sp[:, 1], sp[:, 2],
                       c='green', s=40, depthshade=False)

        ax.set_xlim(*xlim)
        ax.set_ylim(*ylim)
        ax.set_zlim(*zlim)
        ax.set_title(panel['title'], fontsize=11)
        ax.set_xticklabels([])
        ax.set_yticklabels([])
        ax.set_zticklabels([])
        ax.view_init(elev=30, azim=-60)

    plt.tight_layout()
    out_path = os.path.join(os.path.dirname(__file__), 'preview.png')
    plt.savefig(out_path, dpi=120, bbox_inches='tight')
    print(f"Preview saved to {out_path}")
    os.startfile(out_path)
    plt.close(fig)


def plot_heatmaps(results_df: pd.DataFrame, output_dir: str = '.') -> None:
    """
    Plot 2×2 heatmaps of tip and body collision rates.

    Layout:
        Row 0: Tip collision rate   (noise | scale)
        Row 1: Body collision rate  (noise | scale)

    Saves to <output_dir>/collision_heatmaps.png.
    """
    Hstar_values = sorted(results_df['Hstar'].unique())
    corruption_configs = [
        ('noise', 'Surface noise σ (mm)'),
        ('scale', 'Scale factor'),
    ]

    fig, axes = plt.subplots(2, 2, figsize=(14, 10))
    fig.suptitle(
        'VTP Collision Rate vs. Mesh Corruption and H*\n'
        'Printer: nozzle ∅0.4 mm, nozzle length 4.5 mm, '
        'print head (−40,−15)→(35,70) mm',
        fontsize=12, fontweight='bold',
    )

    for col_idx, (corruption_type, x_label) in enumerate(corruption_configs):
        subset = results_df[results_df['corruption'] == corruption_type]
        magnitudes = sorted(subset['magnitude'].unique())

        tip_matrix  = np.full((len(Hstar_values), len(magnitudes)), np.nan)
        body_matrix = np.full((len(Hstar_values), len(magnitudes)), np.nan)

        for i, Hstar in enumerate(Hstar_values):
            for j, mag in enumerate(magnitudes):
                row = subset[(subset['Hstar'] == Hstar) & (subset['magnitude'] == mag)]
                if not row.empty:
                    tip_matrix[i, j]  = row['tip_collision_rate'].values[0]
                    body_matrix[i, j] = row['body_collision_rate'].values[0]

        if corruption_type == 'scale':
            mag_labels = [f'{m:.0%}' for m in magnitudes]
        else:
            mag_labels = [str(m) for m in magnitudes]

        vmax = max(np.nanmax(tip_matrix), np.nanmax(body_matrix), 1.0)

        for row_idx, (matrix, collision_label) in enumerate([
            (tip_matrix,  'Tip Collision Rate (%)'),
            (body_matrix, 'Body Collision Rate (%)'),
        ]):
            ax = axes[row_idx][col_idx]
            im = ax.imshow(
                matrix, aspect='auto', cmap='RdYlGn_r',
                vmin=0, vmax=vmax, origin='upper',
            )

            ax.set_xticks(range(len(magnitudes)))
            ax.set_xticklabels(mag_labels, rotation=45, ha='right')
            ax.set_yticks(range(len(Hstar_values)))
            ax.set_yticklabels([f'H*={h}' for h in Hstar_values])
            ax.set_xlabel(x_label)
            ax.set_title(f'{collision_label}\n({x_label.split(" ")[0]})')

            for i in range(len(Hstar_values)):
                for j in range(len(magnitudes)):
                    val = matrix[i, j]
                    if not np.isnan(val):
                        text_color = 'white' if val > vmax * 0.6 else 'black'
                        ax.text(j, i, f'{val:.1f}%',
                                ha='center', va='center',
                                fontsize=8, color=text_color)

            plt.colorbar(im, ax=ax, label='Collision rate (%)')

    plt.tight_layout()
    out_path = os.path.join(output_dir, 'collision_heatmaps.png')
    plt.savefig(out_path, dpi=150, bbox_inches='tight')
    print(f"Heatmaps saved to {out_path}")
    plt.show()
