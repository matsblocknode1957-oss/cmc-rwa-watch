(function () {
  'use strict';

  // ── Helpers ────────────────────────────────────────────────────────────────

  function fmt(n, decimals) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return Number(n).toLocaleString('en-US', {
      minimumFractionDigits: decimals ?? 2,
      maximumFractionDigits: decimals ?? 2,
    });
  }

  function fmtUTC(isoStr) {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    return d.toUTCString().replace(' GMT', ' UTC');
  }

  function fmtShortUTC(isoStr) {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    const pad = n => String(n).padStart(2, '0');
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `${days[d.getUTCDay()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }

  function gapInfo(gap) {
    if (gap == null) return { text: '— (no feed)', cls: 'gap-ok' };
    const sign = gap >= 0 ? '+' : '';
    const pct = `${sign}${Number(gap).toFixed(2)}%`;
    if (Math.abs(gap) >= 3) return { text: `${pct} HIGH`, cls: 'gap-high' };
    if (Math.abs(gap) >= 1) return { text: `${pct} WIDE`, cls: 'gap-wide' };
    return { text: pct, cls: 'gap-ok' };
  }

  function clAge(alertRow) {
    if (!alertRow.chainlink_updated_at) return '—';
    const ms = new Date(alertRow.created_at) - new Date(alertRow.chainlink_updated_at);
    const mins = Math.round(ms / 60000);
    return `${mins}m`;
  }

  // ── Charts ─────────────────────────────────────────────────────────────────

  Chart.defaults.color = '#8b949e';
  Chart.defaults.borderColor = '#21262d';
  Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

  function makeChart(ctx, points, title) {
    const labels = points.map(p => fmtShortUTC(p.time));
    return new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Token median',
            data: points.map(p => p.tokenMedian),
            borderColor: '#2a78d6',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.15,
            spanGaps: true,
          },
          {
            label: 'Chainlink',
            data: points.map(p => p.clPrice),
            borderColor: '#eb6834',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            pointRadius: 0,
            stepped: 'before',
            spanGaps: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          title: title ? { display: true, text: title, color: '#8b949e', font: { size: 12 } } : { display: false },
          legend: {
            labels: { boxWidth: 12, padding: 16, font: { size: 12 } },
          },
          tooltip: {
            backgroundColor: '#1c2128',
            borderColor: '#30363d',
            borderWidth: 1,
            titleColor: '#8b949e',
            bodyColor: '#e6edf3',
            callbacks: {
              title(items) {
                const idx = items[0]?.dataIndex;
                return points[idx] ? fmtUTC(points[idx].time) : '';
              },
              label(item) {
                const v = item.raw;
                if (v == null) return null;
                const prefix = item.datasetIndex === 0 ? 'Token:  ' : 'Chainlink:';
                return `${prefix} $${Number(v).toFixed(2)}`;
              },
              afterBody(items) {
                const tok = items.find(i => i.datasetIndex === 0)?.raw;
                const cl  = items.find(i => i.datasetIndex === 1)?.raw;
                if (tok != null && cl != null && cl > 0) {
                  const g = ((tok - cl) / cl * 100);
                  return [`Gap: ${g >= 0 ? '+' : ''}${g.toFixed(2)}%`];
                }
                return [];
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { maxTicksLimit: 8, maxRotation: 0, font: { size: 11 } },
            grid: { color: '#21262d' },
          },
          y: {
            grid: { color: '#21262d' },
            ticks: {
              font: { size: 11 },
              callback: v => `$${Number(v).toFixed(2)}`,
            },
          },
        },
      },
    });
  }

  // ── Render cards ───────────────────────────────────────────────────────────

  const ASSET_ORDER = ['SPY', 'NVDA', 'TSLA', 'GOLD', 'QQQ'];

  function renderCards(latest) {
    const section = document.getElementById('cards-section');
    section.innerHTML = '';
    for (const asset of ASSET_ORDER) {
      const d = latest[asset];
      if (!d) continue;
      const { text: gapText, cls: gapCls } = gapInfo(d.gap);
      const peerSpreadStr = d.peerSpread != null ? `Spread ${fmt(d.peerSpread, 2)}%` : '';
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="card-header">
          <span class="card-asset">${asset}</span>
          <span class="badge ${d.market_open ? 'badge-open' : 'badge-closed'}">${d.market_open ? 'Open' : 'Closed'}</span>
          ${d.alertOpen ? '<span class="badge badge-alert">Alert open</span>' : ''}
        </div>
        <div class="card-price">$${fmt(d.tokenMedian)}</div>
        <div class="card-cl">
          CL <span>$${fmt(d.clPrice)}</span>
          ${d.clAgeMin != null ? `<span style="color:var(--muted)"> · ${d.clAgeMin}m ago</span>` : ''}
        </div>
        <div class="card-gap ${gapCls}">Gap: ${gapText}</div>
        <div class="card-meta">
          <span>${d.tokensUsed} token${d.tokensUsed !== 1 ? 's' : ''}</span>
          ${peerSpreadStr ? `<span>${peerSpreadStr}</span>` : ''}
        </div>
      `;
      section.appendChild(card);
    }
  }

  // ── Render alert log ───────────────────────────────────────────────────────

  function renderAlerts(alerts) {
    const tbody = document.getElementById('alerts-body');
    if (!alerts.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="loading-cell">No alerts yet.</td></tr>';
      return;
    }
    tbody.innerHTML = alerts.map(a => {
      const gapStr = a.gap_pct != null
        ? `${Number(a.gap_pct) >= 0 ? '+' : ''}${Number(a.gap_pct).toFixed(2)}%`
        : '—';
      return `<tr>
        <td>${fmtShortUTC(a.created_at)}</td>
        <td><strong>${a.asset}</strong></td>
        <td class="type-${a.alert_type}">${a.alert_type}</td>
        <td class="ev-${a.event}">${a.event.toUpperCase()}</td>
        <td>${a.market_state ?? '—'}</td>
        <td>${gapStr}</td>
        <td>${clAge(a)}</td>
      </tr>`;
    }).join('');
  }

  // ── Render excluded / data quality ─────────────────────────────────────────

  function renderExcluded(excluded) {
    const container = document.getElementById('excluded-list');
    if (!excluded.length) {
      container.innerHTML = '<p class="loading-cell" style="color:var(--muted)">No tokens currently excluded.</p>';
      return;
    }
    container.innerHTML = excluded.map(e => `
      <div class="excl-card">
        <div><span class="excl-sym">${e.symbol ?? '?'}</span>
        <span class="excl-issuer"> · ${e.asset} · ${e.issuer ?? '—'}</span></div>
        <span class="excl-reason ${e.excluded_reason}">${
          e.excluded_reason === 'stale' ? 'Stale — price frozen 2h+'
          : e.excluded_reason === 'hyperliquid_perp' ? 'Hyperliquid perp (not spot)'
          : e.excluded_reason
        }</span>
      </div>
    `).join('');
  }

  // ── Main ───────────────────────────────────────────────────────────────────

  let mainChart = null;

  async function init() {
    let data;
    try {
      const r = await fetch('/api/data');
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      data = await r.json();
      if (data.error) throw new Error(data.error);
    } catch (err) {
      const banner = document.getElementById('error-banner');
      banner.textContent = `Failed to load data: ${err.message}. Please try refreshing.`;
      banner.removeAttribute('hidden');
      document.getElementById('last-updated').textContent = 'Data unavailable';
      return;
    }

    // Header
    document.getElementById('last-updated').textContent =
      `Last updated: ${fmtUTC(data.meta.lastPoll)} · ${(data.meta.total ?? '?').toLocaleString()} total rows`;

    // Cards
    renderCards(data.latest);

    // Asset picker + main chart
    const picker = document.getElementById('asset-picker');
    const assets = ASSET_ORDER.filter(a => data.series[a]?.length);

    function switchAsset(asset) {
      picker.querySelectorAll('.pick-btn').forEach(b => b.classList.toggle('active', b.dataset.asset === asset));
      const points = data.series[asset] ?? [];
      if (mainChart) {
        mainChart.data.labels = points.map(p => fmtShortUTC(p.time));
        mainChart.data.datasets[0].data = points.map(p => p.tokenMedian);
        mainChart.data.datasets[1].data = points.map(p => p.clPrice);
        mainChart.update('none');
      }
    }

    assets.forEach(asset => {
      const btn = document.createElement('button');
      btn.className = 'pick-btn';
      btn.dataset.asset = asset;
      btn.textContent = asset;
      btn.addEventListener('click', () => switchAsset(asset));
      picker.appendChild(btn);
    });

    const defaultAsset = assets[0] ?? 'SPY';
    const initialPoints = data.series[defaultAsset] ?? [];
    const mainCtx = document.getElementById('main-chart').getContext('2d');
    mainChart = makeChart(mainCtx, initialPoints);
    switchAsset(defaultAsset);

    // Case study chart
    const csCtx = document.getElementById('cs-chart').getContext('2d');
    makeChart(csCtx, data.casestudy ?? [], 'NVDA · 20–23 Nov 2026');

    // Alerts
    renderAlerts(data.alerts ?? []);

    // Excluded
    renderExcluded(data.excluded ?? []);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
