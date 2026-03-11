/**
 * Inspector script to inject into preview browser pages.
 * Uses react-grab for element selection and context extraction.
 * On copy (Cmd+C), sends element context to cmux-hub server via fetch POST.
 */

// Static import so the script is embedded in compiled binaries
// @ts-expect-error -- text import has no type declaration
import reactGrabScript from "../node_modules/react-grab/dist/index.global.js" with { type: "text" };

export function generateInspectorScript(cmuxHubPort: number): string {
  const pluginScript = `(function() {
  if (window.__cmuxHubInspector) return;
  window.__cmuxHubInspector = true;
  var API = 'http://127.0.0.1:${cmuxHubPort}';
  var mod = globalThis.__REACT_GRAB_MODULE__;
  if (!mod) return;

  mod.registerPlugin({
    name: 'cmux-hub',
    hooks: {
      onCopySuccess: function(_elements, content) {
        fetch(API + '/api/preview-comment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            element: { selector: '', tagName: '', textContent: '', className: '', attributes: {}, boundingBox: { x: 0, y: 0, width: 0, height: 0 } },
            comment: content,
            url: window.location.href,
            includeScreenshot: true,
          }),
        }).then(function() {
          showNotification('Sent to Claude Code');
        }).catch(function(err) {
          showNotification('Failed to send: ' + err.message, true);
        });
      },
    },
  });

  function showNotification(msg, isError) {
    var n = document.createElement('div');
    n.style.cssText = 'position:fixed;top:16px;right:16px;padding:10px 16px;border-radius:6px;font-size:13px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,sans-serif;transition:opacity 0.3s;' +
      (isError ? 'background:#da3633;color:#fff;' : 'background:#238636;color:#fff;');
    n.textContent = msg;
    document.body.appendChild(n);
    setTimeout(function() { n.style.opacity = '0'; setTimeout(function() { n.remove(); }, 300); }, 2000);
  }
})();`;

  return reactGrabScript + "\n" + pluginScript;
}
