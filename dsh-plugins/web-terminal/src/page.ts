/**
 * The console's static frontend: a single self-contained HTML page, no
 * bundler, no external script (xterm.js would be the obvious choice for a
 * raw byte-streaming PTY, but `ctx.terminals`' actual contract is
 * line-oriented — see `domain.ts`'s module doc — so a plain output pane plus
 * a line input is a more honest fit than a full terminal-emulator library
 * for what this protocol actually delivers). Matches the `dsh-plugins`
 * convention of preferring a small, auditable, hand-written implementation
 * over pulling in a library for a small job.
 * @module dsh-plugin-web-terminal/page
 */

/** Render the console page. `wsPath` is the same pathname this plugin registered its upgrade route on. */
export function renderPage(wsPath: string): string {
  const escapedPath = wsPath.replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>DSH Web Terminal</title>
<style>
  body { background: #111; color: #ddd; font-family: ui-monospace, monospace; margin: 0; padding: 1rem; }
  #output { white-space: pre-wrap; word-break: break-all; height: 70vh; overflow-y: auto; border: 1px solid #333; padding: 0.5rem; }
  #status { color: #888; font-size: 0.85em; margin: 0.5rem 0; }
  form { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  input { flex: 1; background: #000; color: #ddd; border: 1px solid #333; padding: 0.4rem; font-family: inherit; }
  button { background: #222; color: #ddd; border: 1px solid #333; padding: 0.4rem 0.8rem; cursor: pointer; }
</style>
</head>
<body>
<div id="status">Not connected. Paste the token printed in the server log and click Connect.</div>
<div id="output"></div>
<form id="connect-form">
  <input id="token" type="password" placeholder="token" autocomplete="off">
  <button id="connect" type="submit">Connect</button>
</form>
<form id="input-form" hidden>
  <input id="line" type="text" placeholder="command" autocomplete="off">
  <button type="submit">Send</button>
  <button id="sigint" type="button">Ctrl+C</button>
</form>
<script>
(function () {
  const output = document.getElementById('output');
  const status = document.getElementById('status');
  const connectForm = document.getElementById('connect-form');
  const inputForm = document.getElementById('input-form');
  const tokenInput = document.getElementById('token');
  const lineInput = document.getElementById('line');
  const sigintButton = document.getElementById('sigint');
  let ws;

  function append(text) {
    output.textContent += text;
    output.scrollTop = output.scrollHeight;
  }

  connectForm.addEventListener('submit', function (event) {
    event.preventDefault();
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(scheme + '//' + location.host + '${escapedPath}');
    ws.addEventListener('open', function () {
      ws.send(JSON.stringify({ type: 'hello', token: tokenInput.value }));
    });
    ws.addEventListener('message', function (event) {
      const message = JSON.parse(event.data);
      if (message.type === 'motd') {
        status.textContent = 'Connected.';
        connectForm.hidden = true;
        inputForm.hidden = false;
        append(message.text);
        lineInput.focus();
      } else if (message.type === 'output') {
        append(message.delta);
      } else if (message.type === 'settled') {
        append('\\n[' + message.waitReason + (message.exited ? ', exited' : '') + ']\\n');
      } else if (message.type === 'read_result') {
        append(message.text);
      } else if (message.type === 'signal_delivered') {
        append('\\n[signal delivered to pgid ' + message.targetPgid + ']\\n');
      } else if (message.type === 'error') {
        append('\\n[error: ' + message.code + ' ' + message.message + ']\\n');
      }
    });
    ws.addEventListener('close', function () {
      status.textContent = 'Disconnected.';
      connectForm.hidden = false;
      inputForm.hidden = true;
    });
  });

  inputForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'input', text: lineInput.value, submit: true }));
    append('\\n$ ' + lineInput.value + '\\n');
    lineInput.value = '';
  });

  sigintButton.addEventListener('click', function () {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'signal', signal: 'SIGINT' }));
  });
})();
</script>
</body>
</html>
`
}
