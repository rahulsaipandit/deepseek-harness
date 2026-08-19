/**
 * Static HTML+JS concept-graph viewer: a hand-rolled Canvas2D force
 * simulation (repulsion + weighted springs + centering, no `d3-force`
 * dependency) — the same no-dependency choice Tolaria's ADR-0175 made and
 * validated at real vault scale. Served as a plain string template, matching
 * `dsh-plugins/web-terminal`'s approach (no framework, no build step).
 * @module dsh-plugin-knowledge-hub/web/concept-graph-page
 */

export function renderConceptGraphPage(dataUrl: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Knowledge Hub — Concept Graph</title>
<style>
  html, body { margin: 0; height: 100%; background: #14161a; color: #e8e8ea; font-family: system-ui, sans-serif; overflow: hidden; }
  #hud { position: fixed; top: 8px; left: 8px; font-size: 12px; opacity: 0.7; z-index: 1; }
  #empty { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); opacity: 0.6; }
  canvas { display: block; cursor: grab; }
</style>
</head>
<body>
<div id="hud">loading…</div>
<div id="empty" style="display:none">No concepts extracted yet — write a note with memory_remember to get started.</div>
<canvas id="c"></canvas>
<script>
(function () {
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const hud = document.getElementById('hud');
  const empty = document.getElementById('empty');
  let nodes = [];
  let edges = [];
  let width = 0, height = 0;
  let offsetX = 0, offsetY = 0, scale = 1;
  let dragTarget = null, panning = false, panStart = null;

  const PALETTE = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7'];

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width;
    canvas.height = height;
  }
  window.addEventListener('resize', resize);
  resize();

  function seedPositions() {
    const n = nodes.length;
    nodes.forEach((node, i) => {
      const angle = (i / Math.max(n, 1)) * Math.PI * 2;
      const radius = Math.min(width, height) / 3;
      node.x = Math.cos(angle) * radius;
      node.y = Math.sin(angle) * radius;
      node.vx = 0;
      node.vy = 0;
      node.pinned = false;
    });
  }

  function step() {
    const REPULSION = 2400;
    const SPRING = 0.02;
    const DAMPING = 0.85;
    const CENTER = 0.002;

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let distSq = dx * dx + dy * dy || 0.01;
        const force = REPULSION / distSq;
        const dist = Math.sqrt(distSq);
        dx /= dist; dy /= dist;
        a.vx += dx * force; a.vy += dy * force;
        b.vx -= dx * force; b.vy -= dy * force;
      }
    }

    for (const edge of edges) {
      const a = nodesById[edge.source], b = nodesById[edge.target];
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const springForce = SPRING * (1 + Math.min(edge.weight, 5));
      a.vx += dx * springForce; a.vy += dy * springForce;
      b.vx -= dx * springForce; b.vy -= dy * springForce;
    }

    for (const node of nodes) {
      if (node.pinned) continue;
      node.vx -= node.x * CENTER;
      node.vy -= node.y * CENTER;
      node.vx *= DAMPING; node.vy *= DAMPING;
      node.x += node.vx; node.y += node.vy;
    }
  }

  let nodesById = {};

  function draw() {
    ctx.save();
    ctx.clearRect(0, 0, width, height);
    ctx.translate(width / 2 + offsetX, height / 2 + offsetY);
    ctx.scale(scale, scale);

    for (const edge of edges) {
      const a = nodesById[edge.source], b = nodesById[edge.target];
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = edge.scope === 'cross-file' ? 'rgba(200,200,220,0.25)' : 'rgba(200,200,220,0.5)';
      ctx.setLineDash(edge.scope === 'cross-file' ? [4, 3] : []);
      ctx.lineWidth = Math.min(1 + edge.weight * 0.3, 4) / scale;
      ctx.stroke();
    }
    ctx.setLineDash([]);

    for (const node of nodes) {
      const radius = Math.max(4, Math.min(4 + node.degree * 1.5, 24));
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = PALETTE[node.community % PALETTE.length];
      ctx.fill();
      ctx.font = (11 / scale) + 'px system-ui';
      ctx.fillStyle = '#e8e8ea';
      ctx.fillText(node.label, node.x + radius + 3, node.y + 4);
    }
    ctx.restore();
  }

  function loop() {
    step();
    draw();
    requestAnimationFrame(loop);
  }

  function screenToWorld(sx, sy) {
    return { x: (sx - width / 2 - offsetX) / scale, y: (sy - height / 2 - offsetY) / scale };
  }

  canvas.addEventListener('mousedown', (e) => {
    const world = screenToWorld(e.clientX, e.clientY);
    let closest = null, closestDist = Infinity;
    for (const node of nodes) {
      const d = (node.x - world.x) ** 2 + (node.y - world.y) ** 2;
      if (d < closestDist) { closestDist = d; closest = node; }
    }
    if (closest && closestDist < 900) {
      dragTarget = closest;
      dragTarget.pinned = true;
    } else {
      panning = true;
      panStart = { x: e.clientX - offsetX, y: e.clientY - offsetY };
    }
  });
  canvas.addEventListener('mousemove', (e) => {
    if (dragTarget) {
      const world = screenToWorld(e.clientX, e.clientY);
      dragTarget.x = world.x;
      dragTarget.y = world.y;
      dragTarget.vx = 0; dragTarget.vy = 0;
    } else if (panning && panStart) {
      offsetX = e.clientX - panStart.x;
      offsetY = e.clientY - panStart.y;
    }
  });
  window.addEventListener('mouseup', () => {
    if (dragTarget) dragTarget.pinned = false;
    dragTarget = null;
    panning = false;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    scale = Math.max(0.2, Math.min(4, scale * (e.deltaY < 0 ? 1.1 : 0.9)));
  }, { passive: false });

  fetch(${JSON.stringify(dataUrl)})
    .then(r => r.json())
    .then(data => {
      nodes = data.nodes || [];
      edges = data.edges || [];
      nodesById = {};
      nodes.forEach(n => { nodesById[n.id] = n; });
      hud.textContent = nodes.length + ' concepts, ' + edges.length + ' edges';
      empty.style.display = nodes.length === 0 ? 'block' : 'none';
      seedPositions();
      loop();
    })
    .catch(err => { hud.textContent = 'failed to load: ' + err; });
})();
</script>
</body>
</html>
`
}
