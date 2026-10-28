(() => {
  const c = document.getElementById('matrix');
  if (!c) return;
  const ctx = c.getContext('2d');
  let cols, drops;
  const size = 15;
  const resize = () => {
    c.width = innerWidth; c.height = innerHeight;
    cols = Math.ceil(c.width / size);
    drops = new Array(cols).fill(0).map(() => Math.random() * -80);
  };
  const draw = () => {
    ctx.fillStyle = 'rgba(5,5,7,0.09)';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.font = size + 'px monospace';
    for (let i = 0; i < cols; i++) {
      const ch = Math.random() < 0.5 ? '0' : '1';
      ctx.fillStyle = Math.random() < 0.08 ? '#ff2b2b' : '#29ff7a';
      ctx.fillText(ch, i * size, drops[i] * size);
      if (drops[i] * size > c.height && Math.random() > 0.975) drops[i] = 0;
      drops[i]++;
    }
    requestAnimationFrame(draw);
  };
  resize(); draw();
  addEventListener('resize', resize);
})();
