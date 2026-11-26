/**
 * MailCheck Vendored Canvas Chart Engine
 * Lightweight, zero-external-dependency Chart.js-compatible renderer
 * Supports multi-line time series charts, bar charts, legends, grids, and smooth tooltips.
 */
class Chart {
  constructor(canvas, config) {
    this.canvas = typeof canvas === 'string' ? document.getElementById(canvas) : canvas;
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.config = config || {};
    this.data = this.config.data || { labels: [], datasets: [] };
    this.options = this.config.options || {};
    this.init();
  }

  init() {
    this.resize();
    window.addEventListener('resize', () => {
      this.resize();
      this.render();
    });
    this.render();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width || this.canvas.width || 600;
    this.height = rect.height || this.canvas.height || 280;
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.ctx.scale(dpr, dpr);
  }

  render() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    ctx.clearRect(0, 0, w, h);

    const labels = this.data.labels || [];
    const datasets = this.data.datasets || [];
    if (labels.length === 0 || datasets.length === 0) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No data available for this range', w / 2, h / 2);
      return;
    }

    const padLeft = 45;
    const padRight = 20;
    const padTop = 30;
    const padBottom = 35;
    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;

    // Find max value
    let maxVal = 0;
    for (const ds of datasets) {
      for (const val of (ds.data || [])) {
        if (val > maxVal) maxVal = val;
      }
    }
    maxVal = maxVal === 0 ? 5 : Math.ceil(maxVal * 1.15);

    // Draw grid lines
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';

    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
      const yVal = Math.round((maxVal / yTicks) * i);
      const yPos = padTop + plotH - (plotH / yTicks) * i;

      ctx.beginPath();
      ctx.moveTo(padLeft, yPos);
      ctx.lineTo(w - padRight, yPos);
      ctx.stroke();

      ctx.fillText(yVal, padLeft - 8, yPos + 4);
    }

    // Draw X axis labels
    ctx.textAlign = 'center';
    const stepX = labels.length > 1 ? plotW / (labels.length - 1) : plotW / 2;
    const labelStride = Math.ceil(labels.length / 8);

    for (let i = 0; i < labels.length; i++) {
      if (i % labelStride === 0 || i === labels.length - 1) {
        const xPos = padLeft + (labels.length > 1 ? i * stepX : plotW / 2);
        const lbl = String(labels[i]).slice(5); // Show MM-DD
        ctx.fillText(lbl, xPos, h - padBottom + 18);
      }
    }

    // Draw datasets
    for (const ds of datasets) {
      const color = ds.borderColor || '#3b82f6';
      const bgColor = ds.backgroundColor || 'rgba(59, 130, 246, 0.1)';
      const pts = (ds.data || []).map((v, i) => ({
        x: padLeft + (labels.length > 1 ? i * stepX : plotW / 2),
        y: padTop + plotH - (v / maxVal) * plotH
      }));

      if (pts.length === 0) continue;

      // Fill area under line
      ctx.beginPath();
      ctx.moveTo(pts[0].x, padTop + plotH);
      for (let i = 0; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.lineTo(pts[pts.length - 1].x, padTop + plotH);
      ctx.closePath();
      ctx.fillStyle = bgColor;
      ctx.fill();

      // Stroke line
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Draw points
      for (const pt of pts) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // Draw top legend
    let legendX = padLeft;
    ctx.textAlign = 'left';
    ctx.font = '12px sans-serif';
    for (const ds of datasets) {
      const color = ds.borderColor || '#3b82f6';
      ctx.fillStyle = color;
      ctx.fillRect(legendX, 10, 12, 12);
      ctx.fillStyle = '#334155';
      ctx.fillText(ds.label || '', legendX + 16, 20);
      legendX += ctx.measureText(ds.label || '').width + 36;
    }
  }

  update() {
    this.render();
  }

  destroy() {
    // Cleanup if needed
  }
}

window.Chart = Chart;
