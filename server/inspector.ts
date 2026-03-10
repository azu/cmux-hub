/**
 * Inspector script to inject into preview browser pages.
 * Provides element selection + comment functionality.
 * Communicates back to cmux-hub server via fetch POST.
 */

export function generateInspectorScript(cmuxHubPort: number): string {
  return `(function() {
  if (window.__cmuxHubInspector) return;
  window.__cmuxHubInspector = true;

  const API_BASE = 'http://127.0.0.1:${cmuxHubPort}';
  let active = false;
  let selectedEl = null;
  let highlightOverlay = null;
  let commentPanel = null;

  // Create highlight overlay
  function createOverlay() {
    const el = document.createElement('div');
    el.id = '__cmux-hub-overlay';
    el.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #58a6ff;background:rgba(88,166,255,0.1);z-index:2147483646;display:none;transition:all 0.05s ease;';
    document.body.appendChild(el);
    return el;
  }

  // Create comment panel
  function createCommentPanel() {
    const panel = document.createElement('div');
    panel.id = '__cmux-hub-comment-panel';
    panel.style.cssText = 'position:fixed;bottom:16px;right:16px;width:360px;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;z-index:2147483647;display:none;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#c9d1d9;box-shadow:0 8px 24px rgba(0,0,0,0.4);';
    panel.innerHTML = \`
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <span style="font-size:14px;font-weight:600;">Comment on Element</span>
        <button id="__cmux-close" style="background:none;border:none;color:#8b949e;cursor:pointer;font-size:18px;padding:0 4px;">&times;</button>
      </div>
      <div id="__cmux-element-info" style="font-size:12px;color:#8b949e;margin-bottom:8px;padding:8px;background:#0d1117;border-radius:4px;font-family:monospace;word-break:break-all;max-height:80px;overflow-y:auto;"></div>
      <textarea id="__cmux-comment-input" placeholder="Enter your comment..." style="width:100%;height:80px;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;padding:8px;font-size:13px;resize:vertical;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,sans-serif;"></textarea>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:#8b949e;cursor:pointer;">
          <input type="checkbox" id="__cmux-screenshot-check" checked style="accent-color:#58a6ff;">
          Include screenshot
        </label>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button id="__cmux-send" style="flex:1;background:#238636;color:#fff;border:none;border-radius:4px;padding:8px 12px;font-size:13px;cursor:pointer;font-weight:500;">Send to Claude Code</button>
        <button id="__cmux-cancel" style="background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:8px 12px;font-size:13px;cursor:pointer;">Cancel</button>
      </div>
    \`;
    document.body.appendChild(panel);

    panel.querySelector('#__cmux-close').addEventListener('click', hideCommentPanel);
    panel.querySelector('#__cmux-cancel').addEventListener('click', hideCommentPanel);
    panel.querySelector('#__cmux-send').addEventListener('click', sendComment);

    return panel;
  }

  function getUniqueSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        selector = '#' + CSS.escape(current.id);
        parts.unshift(selector);
        break;
      }
      if (current.className && typeof current.className === 'string') {
        const classes = current.className.trim().split(/\\s+/).filter(c => !c.startsWith('__cmux'));
        if (classes.length > 0) {
          selector += '.' + classes.map(c => CSS.escape(c)).join('.');
        }
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          selector += ':nth-of-type(' + index + ')';
        }
      }
      parts.unshift(selector);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function getElementInfo(el) {
    const rect = el.getBoundingClientRect();
    return {
      selector: getUniqueSelector(el),
      tagName: el.tagName.toLowerCase(),
      textContent: (el.textContent || '').trim().substring(0, 200),
      className: el.className && typeof el.className === 'string' ? el.className : '',
      attributes: Array.from(el.attributes || [])
        .filter(a => !a.name.startsWith('__cmux'))
        .reduce((acc, a) => { acc[a.name] = a.value; return acc; }, {}),
      boundingBox: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    };
  }

  function showCommentPanel(el) {
    selectedEl = el;
    if (!commentPanel) commentPanel = createCommentPanel();
    const info = getElementInfo(el);
    commentPanel.querySelector('#__cmux-element-info').textContent = info.selector;
    commentPanel.querySelector('#__cmux-comment-input').value = '';
    commentPanel.style.display = 'block';
    commentPanel.querySelector('#__cmux-comment-input').focus();
  }

  function hideCommentPanel() {
    if (commentPanel) commentPanel.style.display = 'none';
    selectedEl = null;
  }

  async function sendComment() {
    if (!selectedEl) return;
    const info = getElementInfo(selectedEl);
    const comment = commentPanel.querySelector('#__cmux-comment-input').value.trim();
    if (!comment) return;
    const includeScreenshot = commentPanel.querySelector('#__cmux-screenshot-check').checked;

    const sendBtn = commentPanel.querySelector('#__cmux-send');
    sendBtn.textContent = 'Sending...';
    sendBtn.disabled = true;

    try {
      await fetch(API_BASE + '/api/preview-comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          element: info,
          comment: comment,
          url: window.location.href,
          includeScreenshot: includeScreenshot,
        }),
      });
      hideCommentPanel();
      // Brief success indicator
      showNotification('Comment sent to Claude Code');
    } catch (err) {
      showNotification('Failed to send: ' + err.message, true);
    } finally {
      sendBtn.textContent = 'Send to Claude Code';
      sendBtn.disabled = false;
    }
  }

  function showNotification(msg, isError) {
    const n = document.createElement('div');
    n.style.cssText = 'position:fixed;top:16px;right:16px;padding:10px 16px;border-radius:6px;font-size:13px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,sans-serif;transition:opacity 0.3s;' +
      (isError ? 'background:#da3633;color:#fff;' : 'background:#238636;color:#fff;');
    n.textContent = msg;
    document.body.appendChild(n);
    setTimeout(() => { n.style.opacity = '0'; setTimeout(() => n.remove(), 300); }, 2000);
  }

  // Toggle button
  const toggleBtn = document.createElement('button');
  toggleBtn.id = '__cmux-hub-toggle';
  toggleBtn.textContent = 'Inspect';
  toggleBtn.style.cssText = 'position:fixed;bottom:16px;left:16px;background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,sans-serif;';
  document.body.appendChild(toggleBtn);

  toggleBtn.addEventListener('click', () => {
    active = !active;
    toggleBtn.style.background = active ? '#58a6ff' : '#21262d';
    toggleBtn.style.color = active ? '#0d1117' : '#c9d1d9';
    toggleBtn.textContent = active ? 'Inspecting...' : 'Inspect';
    if (!active && highlightOverlay) {
      highlightOverlay.style.display = 'none';
    }
  });

  // Mouse handlers
  document.addEventListener('mousemove', (e) => {
    if (!active) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el.id?.startsWith('__cmux')) return;
    if (!highlightOverlay) highlightOverlay = createOverlay();
    const rect = el.getBoundingClientRect();
    highlightOverlay.style.display = 'block';
    highlightOverlay.style.left = rect.left + 'px';
    highlightOverlay.style.top = rect.top + 'px';
    highlightOverlay.style.width = rect.width + 'px';
    highlightOverlay.style.height = rect.height + 'px';
  }, true);

  document.addEventListener('click', (e) => {
    if (!active) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el.id?.startsWith('__cmux')) return;
    e.preventDefault();
    e.stopPropagation();
    active = false;
    toggleBtn.style.background = '#21262d';
    toggleBtn.style.color = '#c9d1d9';
    toggleBtn.textContent = 'Inspect';
    if (highlightOverlay) highlightOverlay.style.display = 'none';
    showCommentPanel(el);
  }, true);

  // Keyboard shortcut: Escape to cancel
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (commentPanel && commentPanel.style.display !== 'none') {
        hideCommentPanel();
      } else if (active) {
        active = false;
        toggleBtn.style.background = '#21262d';
        toggleBtn.style.color = '#c9d1d9';
        toggleBtn.textContent = 'Inspect';
        if (highlightOverlay) highlightOverlay.style.display = 'none';
      }
    }
  });
})();`;
}
