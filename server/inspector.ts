/**
 * Inspector script to inject into preview browser pages.
 * Uses react-grab for element selection and context extraction.
 * Adds a "Send to Claude Code" context menu action that POSTs
 * the grabbed context to the cmux-hub server (prompt mode).
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

  function showNotification(msg, isError) {
    var n = document.createElement('div');
    n.style.cssText = 'position:fixed;top:16px;right:16px;padding:10px 16px;border-radius:6px;font-size:13px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,sans-serif;transition:opacity 0.3s;' +
      (isError ? 'background:#da3633;color:#fff;' : 'background:#238636;color:#fff;');
    n.textContent = msg;
    document.body.appendChild(n);
    setTimeout(function() { n.style.opacity = '0'; setTimeout(function() { n.remove(); }, 300); }, 2000);
  }

  function sendToClaudeCode(context) {
    return fetch(API + '/api/preview-comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        element: { selector: '', tagName: '', textContent: '', className: '', attributes: {}, boundingBox: { x: 0, y: 0, width: 0, height: 0 } },
        comment: context.comment,
        url: window.location.href,
        includeScreenshot: true,
      }),
    }).then(function() {
      showNotification('Sent to Claude Code');
    }).catch(function(err) {
      showNotification('Failed to send: ' + err.message, true);
    });
  }

  var cmuxHubProvider = {
    send: function(context) {
      return (async function*() {
        try {
          await sendToClaudeCode({ comment: context.prompt });
          yield 'Sent to Claude Code';
        } catch(e) {
          yield 'Failed: ' + (e && e.message || e);
        }
      })();
    },
    dismissButtonText: 'Close',
    getCompletionMessage: function() { return undefined; },
  };

  mod.registerPlugin({
    name: 'cmux-hub',
    actions: [
      {
        id: 'send-to-claude-code',
        label: 'Send to Claude Code',
        target: 'context-menu',
        shortcut: 'Shift+Enter',
        agent: {
          provider: cmuxHubProvider,
        },
        onAction: function(context) {
          if (context.enterPromptMode) {
            context.enterPromptMode({
              provider: cmuxHubProvider,
            });
          }
        },
      },
    ],
  });
})();`;

  return reactGrabScript + "\n" + pluginScript;
}
