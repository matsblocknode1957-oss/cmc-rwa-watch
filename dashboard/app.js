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
    return new Date(isoStr).toUTCString().replace(' GMT', ' UTC');
  }

  function fmtShortUTC(isoStr) {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    const pad = n => String(n).padStart(2, '0');
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `${days[d.getUTCDay()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }

  function gapInfo(gap) {
    if (gap == null) return { text: '—', cls: 'gap-ok' };
    const sign = gap >= 0 ? '+' : '';
    const pct = `${sign}${Number(gap).toFixed(2)}%`;
    if (Math.abs(gap) >= 3) return { text: `${pct} HIGH`, cls: 'gap-high' };
    if (Math.abs(gap) >= 1) return { text: `${pct} WIDE`, cls: 'gap-wide' };
    return { text: pct, cls: 'gap-ok' };
  }

  function clAge(a) {
    if (a.chainlink_age_min != null) return `${a.chainlink_age_min}m`;
    if (!a.chainlink_updated_at) return '—';
    const ms = new Date(a.created_at) - new Date(a.chainlink_updated_at);
    return `${Math.round(ms / 60000)}m`;
  }

  // ── Annotation plugin ──────────────────────────────────────────────────────
  // Draws shaded regions and dashed vertical lines on a chart.
  // Options: { points: [...], items: [{ type, fromISO/atISO, toISO, label }] }

  const rwaAnnotationsPlugin = {
    id: 'rwaAnnotations',
    afterDraw(chart) {
      const opts = chart.options.plugins?.rwaAnnotations;
      if (!opts?.items?.length || !opts.points?.length) return;
      const { ctx, chartArea } = chart;
      const points = opts.points;
      const meta = chart.getDatasetMeta(0);

      function timeToPixel(isoStr) {
        const target = new Date(isoStr).getTime();
        let best = 0, bestDiff = Infinity;
        for (let i = 0; i < points.length; i++) {
          const diff = Math.abs(new Date(points[i].time).getTime() - target);
          if (diff < bestDiff) { bestDiff = diff; best = i; }
        }
        return meta.data[best]?.x ?? chartArea.left;
      }

      ctx.save();
      for (const item of opts.items) {
        if (item.type === 'region') {
          const px1 = timeToPixel(item.fromISO);
          const px2 = timeToPixel(item.toISO);
          const cx  = (px1 + px2) / 2;
          // Clipped fill
          ctx.save();
          ctx.beginPath();
          ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
          ctx.clip();
          ctx.fillStyle = 'rgba(235,104,52,0.11)';
          ctx.fillRect(px1, chartArea.top, px2 - px1, chartArea.bottom - chartArea.top);
          ctx.restore();
          // Label (unclipped, anchored to top of chart area) — skipped when label is null
          if (item.label && cx > chartArea.left && cx < chartArea.right) {
            ctx.fillStyle = '#eb6834';
            ctx.font = '600 10px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(item.label, Math.max(chartArea.left + 2, Math.min(chartArea.right - 2, cx)), chartArea.top + 4);
          }
        } else if (item.type === 'line') {
          const px = timeToPixel(item.atISO);
          if (px > chartArea.left && px < chartArea.right) {
            // Clipped dashed line
            ctx.save();
            ctx.beginPath();
            ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
            ctx.clip();
            ctx.strokeStyle = 'rgba(230,237,243,0.45)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([5, 3]);
            ctx.beginPath();
            ctx.moveTo(px, chartArea.top);
            ctx.lineTo(px, chartArea.bottom);
            ctx.stroke();
            ctx.restore();
            // Label — skipped when label is null
            if (!item.label) continue;
            ctx.fillStyle = '#c9d1d9';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(item.label, Math.max(chartArea.left + 2, Math.min(chartArea.right - 2, px)), chartArea.top + 18);
          }
        }
      }
      ctx.restore();
    },
  };

  Chart.register(rwaAnnotationsPlugin);

  // Annotations shared by both case study charts
  const CS_ANNOTATIONS = [
    { type: 'region', fromISO: '2026-11-23T13:46:00Z', toISO: '2026-11-23T14:02:00Z', label: 'News lands' },
    { type: 'line',   atISO:  '2026-11-23T14:30:00Z',                                  label: 'Opening bell' },
  ];

  // ── Charts ─────────────────────────────────────────────────────────────────

  Chart.defaults.color = '#8b949e';
  Chart.defaults.borderColor = '#21262d';
  Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

  function makeChart(ctx, points, { title, annotations } = {}) {
    return new Chart(ctx, {
      type: 'line',
      data: {
        labels: points.map(p => fmtShortUTC(p.time)),
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
          rwaAnnotations: annotations?.length ? { points, items: annotations } : { items: [] },
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
                const prefix = item.datasetIndex === 0 ? 'Token:    ' : 'Chainlink:';
                return `${prefix} $${Number(v).toFixed(2)}`;
              },
              afterBody(items) {
                const tok = items.find(i => i.datasetIndex === 0)?.raw;
                const cl  = items.find(i => i.datasetIndex === 1)?.raw;
                if (tok != null && cl != null && cl > 0) {
                  const g = (tok - cl) / cl * 100;
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
            grid:  { color: '#21262d' },
          },
          y: {
            grid:  { color: '#21262d' },
            ticks: { font: { size: 11 }, callback: v => `$${Number(v).toFixed(2)}` },
          },
        },
      },
    });
  }

  // ── Render cards ───────────────────────────────────────────────────────────

  const ASSET_ORDER = ['SPY', 'NVDA', 'TSLA', 'GOLD', 'QQQ'];
  const EQUITY_ASSETS = new Set(['SPY', 'NVDA', 'TSLA']);

  function renderCards(latest) {
    const section = document.getElementById('cards-section');
    section.innerHTML = '';
    for (const asset of ASSET_ORDER) {
      const d = latest[asset];
      if (!d) continue;
      const { text: gapText, cls: gapCls } = gapInfo(d.gap);
      const peerSpreadStr = d.peerSpread != null ? `Spread ${fmt(d.peerSpread, 2)}%` : '';

      let clHtml;
      if (asset === 'QQQ') {
        clHtml = '<div class="card-no-feed">No Chainlink feed on Arbitrum. Peer spread only.</div>';
      } else {
        const ageStr = d.clAgeMin != null ? ` · ${d.clAgeMin}m ago` : '';
        const closedHtml = !d.market_open && EQUITY_ASSETS.has(asset)
          ? '<div class="card-cl-closed">Market closed: oracle updates slowly, gaps are expected to grow.</div>'
          : '';
        clHtml = `<div class="card-cl">CL $${fmt(d.clPrice)}${ageStr}${closedHtml}</div>`;
      }

      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="card-header">
          <span class="card-asset">${asset}</span>
          <span class="badge ${d.market_open ? 'badge-open' : 'badge-closed'}">${d.market_open ? 'Open' : 'Closed'}</span>
          ${d.alertOpen ? '<span class="badge badge-alert">Alert open</span>' : ''}
        </div>
        <div class="card-price">$${fmt(d.tokenMedian)}</div>
        ${clHtml}
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

  function renderAlerts(allAlerts) {
    const tbody = document.getElementById('alerts-body');
    if (!allAlerts.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="loading-cell">No alerts yet.</td></tr>';
      return;
    }
    tbody.innerHTML = allAlerts.map(a => {
      const gapStr = a.gap_pct != null
        ? `${Number(a.gap_pct) >= 0 ? '+' : ''}${Number(a.gap_pct).toFixed(2)}%`
        : '—';
      const sourceLabel = a.source === 'live' ? 'Live' : 'Backtest';
      return `<tr>
        <td>${fmtShortUTC(a.created_at)}</td>
        <td><strong>${a.asset}</strong></td>
        <td class="type-${a.alert_type}">${a.alert_type}</td>
        <td class="ev-${a.event}">${a.event.toUpperCase()}</td>
        <td>${a.market_state ?? '—'}</td>
        <td>${gapStr}</td>
        <td>${clAge(a)}</td>
        <td><span class="badge badge-${a.source}">${sourceLabel}</span></td>
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
          e.excluded_reason === 'stale'            ? 'Stale — price frozen 2h+'
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
    mainChart = makeChart(document.getElementById('main-chart').getContext('2d'), initialPoints);
    switchAsset(defaultAsset);

    // Case study — full weekend overview (band + line, no text labels — they'd overlap at the right edge)
    const csPoints = data.casestudy ?? [];
    makeChart(
      document.getElementById('cs-chart').getContext('2d'),
      csPoints,
      { annotations: CS_ANNOTATIONS.map(a => ({ ...a, label: null })) }
    );

    // Case study — Monday zoom 13:00–15:00 UTC
    const zoomFrom = new Date('2026-11-23T13:00:00Z').getTime();
    const zoomTo   = new Date('2026-11-23T15:00:00Z').getTime();
    const zoomPoints = csPoints.filter(p => {
      const t = new Date(p.time).getTime();
      return t >= zoomFrom && t <= zoomTo;
    });
    makeChart(
      document.getElementById('cs-zoom-chart').getContext('2d'),
      zoomPoints,
      { annotations: CS_ANNOTATIONS }
    );

    // Alert log — merge live + backtest
    const liveAlerts = (data.alerts ?? []).map(a => ({ ...a, source: 'live' }));
    let backtestAlerts = [];
    try {
      const br = await fetch('/backtest-alerts.json');
      if (br.ok) {
        backtestAlerts = (await br.json()).map(a => ({ ...a, created_at: a.time, source: 'backtest' }));
      }
    } catch {}
    const allAlerts = [...liveAlerts, ...backtestAlerts]
      .sort((a, b) => (a.created_at > b.created_at ? -1 : 1));
    renderAlerts(allAlerts);

    // Excluded
    renderExcluded(data.excluded ?? []);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
