import matplotlib.pyplot as plt
from pathlib import Path

OUT = Path('/home/ubuntu/Deriv-bot/parameter_comparison.png')

profiles = {
    'Current defaults': {'Minimum score': 55, 'Minimum body ratio': 0.40, 'Maximum extension (ATR)': 1.50, 'Close location minimum': None, 'Cooldown (15-min candles)': 4},
    'R_75 candidate': {'Minimum score': 65, 'Minimum body ratio': 0.60, 'Maximum extension (ATR)': 1.00, 'Close location minimum': 0.88, 'Cooldown (15-min candles)': 8},
    'JD100 candidate': {'Minimum score': 65, 'Minimum body ratio': 0.60, 'Maximum extension (ATR)': 1.00, 'Close location minimum': 0.85, 'Cooldown (15-min candles)': 8},
}
colors = ['#64748b', '#dc2626', '#2563eb']
parameters = list(next(iter(profiles.values())).keys())

plt.style.use('default')
fig, axes = plt.subplots(1, len(parameters), figsize=(15, 5.8), facecolor='#f8fafc')
fig.subplots_adjust(left=0.055, right=0.985, top=0.78, bottom=0.27, wspace=0.28)

for ax, parameter in zip(axes, parameters):
    values = [profiles[p][parameter] for p in profiles]
    numeric = [v for v in values if v is not None]
    maxv = max(numeric)
    ax.set_facecolor('#ffffff')
    ax.bar(range(3), [v if v is not None else 0 for v in values], color=colors, width=0.62, edgecolor='white', linewidth=1.5)
    for i, v in enumerate(values):
        label = 'Not set' if v is None else (f'{v:.2f}' if isinstance(v, float) else str(v))
        y = maxv * 0.035 if v is None else v + maxv * 0.04
        ax.text(i, y, label, ha='center', va='bottom', fontsize=10, fontweight='bold', color='#0f172a')
    ax.set_title(parameter, fontsize=10.5, fontweight='bold', color='#0f172a', pad=12, wrap=True)
    ax.set_xticks([])
    ax.set_ylim(0, maxv * 1.22)
    ax.grid(axis='y', color='#e2e8f0', linewidth=0.8)
    ax.set_axisbelow(True)
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.tick_params(axis='y', labelsize=8, colors='#64748b')
    if parameter == 'Minimum score':
        ax.set_yticks([0, 20, 40, 60, 80])
    elif parameter == 'Cooldown (15-min candles)':
        ax.set_yticks([0, 2, 4, 6, 8])
    elif maxv <= 1.5:
        ax.set_yticks([0, 0.5, 1.0, 1.5])

fig.suptitle('Parameter comparison: current defaults vs shadow candidate profiles', fontsize=17, fontweight='bold', color='#0f172a', y=0.95)
fig.text(0.5, 0.885, 'R_75 and JD100 values are proposed for paper/shadow validation only — not deployed production settings', ha='center', fontsize=10.5, color='#475569')
fig.text(0.5, 0.16, 'Current defaults', ha='center', fontsize=10, color=colors[0], fontweight='bold')
fig.text(0.5, 0.115, 'R_75 candidate', ha='center', fontsize=10, color=colors[1], fontweight='bold')
fig.text(0.5, 0.07, 'JD100 candidate', ha='center', fontsize=10, color=colors[2], fontweight='bold')
fig.text(0.055, 0.02, 'Interpretation: higher body/score/close-location requirements are stricter; lower maximum extension is stricter; longer cooldown reduces repeat exposure.', fontsize=9, color='#475569')

fig.savefig(OUT, dpi=220, bbox_inches='tight', facecolor=fig.get_facecolor())
print(OUT)
