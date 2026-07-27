import os
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.cm as cm
import matplotlib.colors as mcolors
import seaborn as sns

df = pd.read_csv(os.path.join(os.path.dirname(__file__), 'results.csv'))
df['any_collision_rate'] = np.maximum(df['tip_collision_rate'], df['body_collision_rate'])

Hstar_values = sorted(df['Hstar'].unique())
hstar_labels = [f'H* = {h:g}' for h in Hstar_values]

panels = [
    ('noise',    'Noise σ (mm)',              lambda m: f'{m:g}'),
    ('scale',    'Scale factor',              lambda m: f'{int(round(m*100))}%'),
    ('combined', 'Scale (+σ=2 mm noise)',     lambda m: f'{int(round(m*100))}%'),
]

cmap = cm.RdYlGn_r
norm = mcolors.Normalize(vmin=0, vmax=100)

fig, axes = plt.subplots(1, 3, figsize=(18, 6))
fig.suptitle('Any Collision Rate vs. H* and Mesh Corruption', fontsize=14, fontweight='bold', y=1.01)

for ax, (corruption_type, x_label, fmt_mag) in zip(axes, panels):
    sub = df[df['corruption'] == corruption_type]
    magnitudes = sorted(sub['magnitude'].unique())

    matrix = np.full((len(Hstar_values), len(magnitudes)), np.nan)
    for i, h in enumerate(Hstar_values):
        for j, m in enumerate(magnitudes):
            row = sub[(sub['Hstar'] == h) & (sub['magnitude'] == m)]
            if not row.empty:
                matrix[i, j] = row['any_collision_rate'].values[0]

    # String annotations: blank for 0, value% for non-zero
    annot = np.where(
        matrix == 0, '0',
        np.where(np.isnan(matrix), '',
                 np.vectorize(lambda v: f'{v:.0f}%')(matrix))
    )

    col_labels = [fmt_mag(m) for m in magnitudes]
    df_plot = pd.DataFrame(matrix, index=hstar_labels, columns=col_labels)

    sns.heatmap(
        df_plot,
        ax=ax,
        cmap=cmap,
        norm=norm,
        annot=annot,
        fmt='s',
        linewidths=0.4,
        linecolor='#cccccc',
        cbar=False,
        annot_kws={'fontsize': 8, 'fontweight': 'bold'},
    )

    ax.set_title(x_label, fontsize=11, pad=8)
    ax.set_xlabel('')
    ax.set_ylabel('H*' if ax is axes[0] else '', fontsize=10)
    ax.tick_params(axis='x', rotation=45, labelsize=9)
    ax.tick_params(axis='y', rotation=0, labelsize=9)

# Single shared colorbar on the right, no overlap
sm = cm.ScalarMappable(cmap=cmap, norm=norm)
cbar = fig.colorbar(sm, ax=axes.tolist(), label='Any collision rate (%)',
                    shrink=0.85, pad=0.02)
cbar.ax.tick_params(labelsize=9)

plt.tight_layout()
out = os.path.join(os.path.dirname(__file__), 'any_collision.png')
plt.savefig(out, dpi=150, bbox_inches='tight')
print(f'Saved to {out}')
os.startfile(out)
