"""Re-generate heatmap SVGs from existing result CSVs without re-running simulations."""
import os, glob, pandas as pd, sys
sys.path.insert(0, os.path.dirname(__file__))
from visualize import plot_any_collision_heatmap

OUTPUT_DIR = os.path.dirname(__file__)

for csv_path in sorted(glob.glob(os.path.join(OUTPUT_DIR, '*_results.csv'))):
    mesh_name = os.path.basename(csv_path).replace('_results.csv', '')
    df = pd.read_csv(csv_path)
    out = os.path.join(OUTPUT_DIR, f'{mesh_name}_any_collision.svg')
    print(f"\n{mesh_name}")
    plot_any_collision_heatmap(df, out)
