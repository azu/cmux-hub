/**
 * Sample dev server for testing cmux-hub's launch.json launcher feature.
 * Serves a simple HTML page with interactive elements for inspector testing.
 */
const port = parseInt(process.env.PORT ?? "3456", 10);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sample App</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0d1117; color: #c9d1d9; padding: 32px; }
    h1 { font-size: 24px; margin-bottom: 16px; }
    p { color: #8b949e; margin-bottom: 24px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .card h2 { font-size: 16px; margin-bottom: 8px; }
    .card p { font-size: 14px; margin-bottom: 0; }
    .button-group { display: flex; gap: 8px; margin-top: 24px; }
    button { background: #238636; color: #fff; border: none; border-radius: 6px; padding: 8px 16px; font-size: 14px; cursor: pointer; }
    button:hover { background: #2ea043; }
    button.secondary { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; }
    button.secondary:hover { background: #30363d; }
    .status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #8b949e; margin-top: 16px; }
    .status .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; }
    nav { display: flex; gap: 16px; margin-bottom: 24px; border-bottom: 1px solid #30363d; padding-bottom: 12px; }
    nav a { color: #58a6ff; text-decoration: none; font-size: 14px; }
    nav a:hover { text-decoration: underline; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>Sample Application</h1>
  <p>This is a sample app for testing cmux-hub's preview inspector.</p>

  <nav>
    <a href="#">Dashboard</a>
    <a href="#">Settings</a>
    <a href="#">Profile</a>
    <a href="#">Help</a>
  </nav>

  <div class="grid">
    <div class="card" id="card-1">
      <h2>Feature A</h2>
      <p>This card demonstrates a feature component. Try selecting this element with the inspector.</p>
    </div>
    <div class="card" id="card-2">
      <h2>Feature B</h2>
      <p>Another feature card. The inspector should capture its selector, text content, and bounding box.</p>
    </div>
    <div class="card" id="card-3">
      <h2>Statistics</h2>
      <p>Active users: 1,234 | Requests today: 56,789</p>
    </div>
    <div class="card" id="card-4">
      <h2>Notifications</h2>
      <p>You have 3 unread notifications.</p>
    </div>
  </div>

  <div class="button-group">
    <button id="primary-btn">Save Changes</button>
    <button class="secondary" id="cancel-btn">Cancel</button>
    <button class="secondary" id="settings-btn">Settings</button>
  </div>

  <div class="status">
    <span class="dot"></span>
    Server running on port ${port}
  </div>
</body>
</html>`;

Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch() {
    return new Response(html, {
      headers: { "Content-Type": "text/html" },
    });
  },
});

console.log(`Sample server running at http://127.0.0.1:${port}`);
