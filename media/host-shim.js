/* GliderUI Designer for VS Code - host shim.
 * Injected by the extension after the upstream GUI Creator scripts. Replaces the
 * browser/local-server seams (localStorage, file downloads, window.open, the
 * Start-GuiCreator.ps1 HTTP runner) with postMessage calls to the extension host.
 *
 * Depends only on upstream's public surface: window.GC (GC.runner), the output
 * panel DOM ids (#outLines, #outStatus, #outStop, #outputPanel, #fileInput), and
 * the gc-runner CustomEvent. If upstream renames any of these, this shim must be
 * updated. */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const GC = (window.GC = window.GC || {});
  const $ = (s) => document.querySelector(s);

  const state = { info: null, running: false, script: '', onLink: null };
  /* The webview is sandboxed without allow-modals: confirm()/alert()/prompt()
   * are ignored, which silently cancels upstream actions that guard on them
   * (open example, new form, delete form). State persists via workspaceState
   * autosave, so auto-accepting matches desktop-app behavior. */
  window.confirm = () => true;
  window.alert = () => undefined;
  window.prompt = () => null;
  let pending = 0;
  const waiters = new Map();

  function send(msg) {
    vscode.postMessage(msg);
  }

  function request(type, extra) {
    const id = ++pending;
    return new Promise((resolve) => {
      waiters.set(id, resolve);
      send(Object.assign({ type, _req: id }, extra));
    });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg._req && waiters.has(msg._req)) {
      waiters.get(msg._req)(msg);
      waiters.delete(msg._req);
    }
    switch (msg.type) {
      case 'ping':
        state.info = msg.info;
        document.dispatchEvent(new CustomEvent('gc-runner', { detail: { running: state.running } }));
        break;
      case 'runOutput':
        String(msg.text || '')
          .split(/\r?\n/)
          .filter((l) => l.length)
          .forEach((l) => addLine(msg.stream, l));
        break;
      case 'runExited':
        state.running = false;
        setStatus(`Exited with code ${msg.exitCode}`, msg.exitCode === 0 ? 'ok' : 'bad');
        break;
      case 'runError':
        state.running = false;
        setStatus('Could not start: ' + msg.message, 'bad');
        break;
      case 'openProjectResult':
        openProjectFromText(msg.text, msg.name);
        break;
      case 'state':
        applyPersistedState(msg.state);
        break;
    }
  });

  /* --- Output panel helpers (mirror upstream runner.js rendering) --- */

  function setStatus(text, cls) {
    const el = $('#outStatus');
    if (el) {
      el.textContent = text;
      el.className = cls || '';
    }
    const stop = $('#outStop');
    if (stop) stop.disabled = !state.running;
    document.dispatchEvent(new CustomEvent('gc-runner', { detail: { running: state.running } }));
  }

  function addLine(stream, text) {
    const box = $('#outLines');
    if (!box) return;
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
    const row = document.createElement('div');
    row.className = 'ol-' + stream;
    // Match upstream: turn "run-xxxxxxxx.ps1:123" into a clickable link.
    const re = /[^\s]*run-[0-9a-z]+\.ps1:(\d+)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      row.append(text.slice(last, m.index));
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = 'line ' + m[1];
      a.title = 'Go to this line';
      const line = +m[1];
      a.addEventListener('click', (e) => {
        e.preventDefault();
        send({ type: 'openLink', line });
      });
      row.append(a);
      last = m.index + m[0].length;
    }
    row.append(text.slice(last));
    box.append(row);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  /* --- Runner: replaces GC.runner so upstream app.js drives VS Code instead
         of the Start-GuiCreator.ps1 HTTP API. Same properties/methods. --- */

  GC.runner = {
    get available() {
      return true;
    },
    get info() {
      return state.info;
    },
    get running() {
      return state.running;
    },
    get ready() {
      return !!(state.info && state.info.ready);
    },
    get problem() {
      return state.info && !state.info.ready ? state.info.problem || 'GliderUI is not ready.' : '';
    },
    async refresh() {
      await request('refresh');
      return this.ready;
    },
    set onLink(fn) {
      state.onLink = fn;
    },
    async init() {
      await request('ping');
      return true;
    },
    show() {
      const p = $('#outputPanel');
      if (p) p.hidden = false;
    },
    hide() {
      const p = $('#outputPanel');
      if (p) p.hidden = true;
    },
    clear() {
      const box = $('#outLines');
      if (box) box.replaceChildren();
    },
    async run(script) {
      state.script = script;
      this.show();
      this.clear();
      const info = state.info || {};
      addLine('sys', `Running with PowerShell ${info.pwsh || '?'}${info.gliderui ? ', GliderUI ' + info.gliderui : ''} ...`);
      if (!info.gliderui) addLine('err', 'GliderUI is not installed. Run: Install-PSResource -Name GliderUI; Install-GLIServer');
      state.running = true;
      setStatus('Running...', 'run');
      send({ type: 'run', script });
    },
    async stop() {
      if (!state.running) return;
      send({ type: 'stop' });
    },
  };

  /* --- Persistence: mirror upstream's localStorage keys into workspaceState --- */

  // Upstream keys (js/app.js, js/tour.js): guiCreator.project.v1, guiCreator.prefs.v1,
  // guiCreator.tourSeen, guiCreator.tourBackup. Prefix-match covers all of them.
  const isGcKey = (k) => String(k).startsWith('guiCreator.');

  let persisted = {};
  function applyPersistedState(stateObj) {
    persisted = stateObj || {};
    for (const key of Object.keys(persisted)) {
      try {
        localStorage.setItem(key, persisted[key]);
      } catch (e) {
        /* storage may be unavailable; ignore */
      }
    }
  }

  const originalSetItem = Storage.prototype.setItem;
  const originalRemoveItem = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (key, value) {
    originalSetItem.call(this, key, value);
    if (isGcKey(key)) {
      persisted[key] = value;
      send({ type: 'setState', state: persisted });
    }
  };
  Storage.prototype.removeItem = function (key) {
    originalRemoveItem.call(this, key);
    if (isGcKey(key) && persisted[key] != null) {
      delete persisted[key];
      send({ type: 'setState', state: persisted });
    }
  };
  send({ type: 'getState' });

  /* --- File seams: upstream clicks a hidden #fileInput for Open and uses
         anchor-download for Save/Export. Redirect both to VS Code dialogs. --- */

  function interceptFileInput() {
    const input = document.querySelector('#fileInput');
    if (!input) return;
    // Clicking Open sends the pick to the extension instead of the OS dialog.
    input.click = function () {
      send({ type: 'openProject' });
    };
  }

  function openProjectFromText(text, name) {
    const input = document.querySelector('#fileInput');
    if (!input) return;
    // Upstream's change handler reads e.target.files[0], then f.name and
    // f.text(). A real File gives us both; overriding target.files avoids
    // DataTransfer/input.files assignment, which Chromium webviews can
    // refuse on hidden inputs.
    const file = new File([text], name || 'project.guiproj.json');
    Object.defineProperty(input, 'files', {
      configurable: true,
      get: () => [file],
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', interceptFileInput);
  } else {
    interceptFileInput();
  }

  // Ctrl+O is upstream's Open shortcut; the input.click override handles the menu
  // item, this covers the keyboard path in case upstream binds it elsewhere.
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      send({ type: 'openProject' });
    }
  });

  const originalCreateElement = document.createElement.bind(document);
  document.createElement = function (tag, options) {
    const el = originalCreateElement(tag, options);
    if (String(tag).toLowerCase() === 'a') {
      const originalClick = el.click.bind(el);
      el.click = function () {
        if (el.download) {
          const href = el.href;
          if (href && href.startsWith('blob:')) {
            fetch(href)
              .then((r) => r.text())
              .then((text) => {
                const name = el.download || 'file';
                send(name.endsWith('.ps1') ? { type: 'exportScript', text } : { type: 'saveProject', text });
              });
            return;
          }
        }
        originalClick();
      };
    }
    return el;
  };

  const originalOpen = window.open.bind(window);
  window.open = function (url, target, features) {
    if (typeof url === 'string' && /^https?:/i.test(url)) {
      send({ type: 'openExternal', url });
      return null;
    }
    return originalOpen(url, target, features);
  };
})();
