/**
 * Neural Network Canvas Animation
 * Renders floating nodes with glowing blue connections on a <canvas>.
 * Designed for the unlock overlay background.
 */

const DEFAULTS = {
  nodeCount: 55,
  connectionDistance: 160,
  nodeSpeed: 0.25,
  nodeMinRadius: 1.2,
  nodeMaxRadius: 2.8,
  lineWidth: 0.6,
  colorNode: [59, 108, 255],      // --primary blue
  colorNodeAlt: [0, 229, 208],    // --aqua accent
  colorLine: [59, 108, 255],
  glowStrength: 18,
  fps: 60,
};

class NeuralCanvas {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cfg = { ...DEFAULTS, ...opts };
    this.nodes = [];
    this.running = false;
    this._raf = null;
    this._lastTime = 0;
    this._frameInterval = 1000 / this.cfg.fps;

    this._resize = this._resize.bind(this);
    this._tick = this._tick.bind(this);

    window.addEventListener("resize", this._resize);
    this._resize();
    this._initNodes();
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _initNodes() {
    this.nodes = [];
    for (let i = 0; i < this.cfg.nodeCount; i++) {
      const isAlt = Math.random() < 0.18;
      const color = isAlt ? this.cfg.colorNodeAlt : this.cfg.colorNode;
      this.nodes.push({
        x: Math.random() * this.w,
        y: Math.random() * this.h,
        vx: (Math.random() - 0.5) * this.cfg.nodeSpeed * 2,
        vy: (Math.random() - 0.5) * this.cfg.nodeSpeed * 2,
        r: this.cfg.nodeMinRadius + Math.random() * (this.cfg.nodeMaxRadius - this.cfg.nodeMinRadius),
        color,
        alpha: 0.3 + Math.random() * 0.5,
        pulseOffset: Math.random() * Math.PI * 2,
      });
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._lastTime = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  }

  destroy() {
    this.stop();
    window.removeEventListener("resize", this._resize);
  }

  _tick(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._tick);

    const delta = now - this._lastTime;
    if (delta < this._frameInterval) return;
    this._lastTime = now - (delta % this._frameInterval);

    const { ctx, w, h, nodes, cfg } = this;
    const time = now * 0.001;

    ctx.clearRect(0, 0, w, h);

    // Update positions
    for (const n of nodes) {
      n.x += n.vx;
      n.y += n.vy;

      // Soft wrap with padding
      const pad = 40;
      if (n.x < -pad) n.x = w + pad;
      if (n.x > w + pad) n.x = -pad;
      if (n.y < -pad) n.y = h + pad;
      if (n.y > h + pad) n.y = -pad;
    }

    // Draw connections
    const maxDist = cfg.connectionDistance;
    const maxDist2 = maxDist * maxDist;

    ctx.lineWidth = cfg.lineWidth;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 > maxDist2) continue;

        const dist = Math.sqrt(dist2);
        const opacity = (1 - dist / maxDist) * 0.28;

        const [r, g, b] = cfg.colorLine;
        ctx.strokeStyle = `rgba(${r},${g},${b},${opacity})`;
        ctx.beginPath();
        ctx.moveTo(nodes[i].x, nodes[i].y);
        ctx.lineTo(nodes[j].x, nodes[j].y);
        ctx.stroke();
      }
    }

    // Draw nodes with glow
    for (const n of nodes) {
      const pulse = Math.sin(time * 1.2 + n.pulseOffset) * 0.15 + 0.85;
      const alpha = n.alpha * pulse;
      const [r, g, b] = n.color;

      // Glow
      const grad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r + cfg.glowStrength);
      grad.addColorStop(0, `rgba(${r},${g},${b},${alpha * 0.6})`);
      grad.addColorStop(0.3, `rgba(${r},${g},${b},${alpha * 0.15})`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + cfg.glowStrength, 0, Math.PI * 2);
      ctx.fill();

      // Core
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

let _instance = null;

/**
 * Initialize the neural canvas on the given <canvas> element.
 * Returns the NeuralCanvas instance. Safe to call multiple times.
 */
export function initNeuralCanvas(canvasEl, opts) {
  if (_instance) _instance.destroy();
  _instance = new NeuralCanvas(canvasEl, opts);
  return _instance;
}

/**
 * Start the animation (call after overlay becomes visible).
 */
export function startNeural() {
  _instance?.start();
}

/**
 * Pause the animation (call when overlay hides to save resources).
 */
export function stopNeural() {
  _instance?.stop();
}

export function destroyNeural() {
  if (_instance) {
    _instance.destroy();
    _instance = null;
  }
}
