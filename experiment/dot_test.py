import os
import plotly.graph_objects as go

fig = go.Figure()

fig.add_trace(go.Scatter3d(
    x=[0, 1, 2, 3, 4],
    y=[0, 1, 2, 3, 4],
    z=[0, 1, 2, 3, 4],
    mode='markers',
    marker=dict(size=20, color='red'),
    name='Red dots',
))

fig.add_trace(go.Scatter3d(
    x=[0, 1, 2, 3, 4],
    y=[4, 3, 2, 1, 0],
    z=[2, 2, 2, 2, 2],
    mode='markers',
    marker=dict(size=20, color='green'),
    name='Green dots',
))

out = os.path.join(os.path.dirname(__file__), 'dot_test.html')
fig.write_html(out, include_plotlyjs='cdn')
print(f"Saved to {out}")
os.startfile(out)
