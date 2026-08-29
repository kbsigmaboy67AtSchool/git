(() => {
  "use strict";

  /*
   * n3xn DevTools — ChromeOS-style bottom dock
   * + blob URL cloaking
   * + reliable layout for Monaco
   */

  const UUID = crypto.randomUUID().replaceAll("-", "");
  const NS = `__n3xn_${UUID}_`;

  const DB_NAME = `${NS}db`;
  const DB_STORE = `${NS}state`;

  // Prefer same-origin proxy (correct MIME). Fall back to jsDelivr.
  // NEVER use raw.githubusercontent.com — it is text/plain + nosniff and will not run/load as assets.
  const CSS_URL = "/devtools.css";
  const CSS_FALLBACK =
    "https://cdn.jsdelivr.net/gh/kbsigmaboy67AtSchool/git@main/public/devtools.css";
  const MONACO_LOADER =
    "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs/loader.min.js";

  const DEFAULT_HEIGHT = Math.round(window.innerHeight * 0.4);

  const state = {
    enabled: true,
    titleOverride: null,
    faviconOverride: null,
    cloakTitle: null,
    cloakFavicon: null,
    scripts: [],
    devAuthenticated: false,
    dockHeight: null,
    open: false,
  };

  let root = null;
  let launcher = null;
  let panel = null;
  let main = null;
  let detail = null;
  let content = null;
  let editor = null;
  let editorReady = false;
  let currentTab = "Elements";
  let highlightEl = null;
  let selectedNode = null;
  let networkLog = [];
  let consoleHistory = [];
  let historyIndex = -1;
  let intercepted = false;
  let originalFetch = null;
  let originalXHROpen = null;
  let originalXHRSend = null;
  let originalConsole = {};
  let netListEl = null;
  let netFilter = "";

  /* ── IndexedDB ── */

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function loadState() {
    try {
      const db = await openDB();
      const value = await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, "readonly");
        const req = tx.objectStore(DB_STORE).get("state");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (value) Object.assign(state, value);
    } catch {}
  }

  async function saveState() {
    try {
      const db = await openDB();
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(structuredClone(state), "state");
    } catch {}
  }

  /* ── CSS ── */

  function loadCSS() {
    if (document.getElementById(`${NS}css`)) return;
    const link = document.createElement("link");
    link.id = `${NS}css`;
    link.rel = "stylesheet";
    link.href = CSS_URL;
    link.onerror = () => {
      link.onerror = null;
      link.href = CSS_FALLBACK;
    };
    document.head.appendChild(link);
  }

  /* ── Helpers ── */

  function el(tag, props = {}, text = "") {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "className") node.className = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
      else if (key in node) node[key] = value;
      else node.setAttribute(key, value);
    }
    if (text) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function escapeHTML(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatBytes(n) {
    if (n == null || isNaN(n)) return "—";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  function shortUrl(url) {
    try {
      const u = new URL(url, location.href);
      return u.pathname + u.search || u.href;
    } catch {
      return url;
    }
  }

  /* ── Auth ── */

  async function authenticate() {
    if (state.devAuthenticated) return true;
    const password = window.prompt("n3xn DevTools password:");
    if (password === null) return false;
    try {
      const response = await fetch("/devtools-auth", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const result = await response.json();
      if (response.ok && result.ok) {
        state.devAuthenticated = true;
        await saveState();
        return true;
      }
    } catch {}
    window.alert("DevTools authentication failed.");
    return false;
  }

  /* ── Monaco ── */

  function loadMonaco() {
    return new Promise((resolve, reject) => {
      if (window.monaco) {
        resolve(window.monaco);
        return;
      }
      if (window.require && window.require.config) {
        window.require(["vs/editor/editor.main"], (m) => resolve(m));
        return;
      }
      const script = document.createElement("script");
      script.src = MONACO_LOADER;
      script.async = true;
      script.onload = () => {
        if (!window.require) {
          reject(new Error("Monaco loader failed"));
          return;
        }
        window.require.config({
          paths: {
            vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs",
          },
        });
        window.require(["vs/editor/editor.main"], (m) => resolve(m));
      };
      script.onerror = () => reject(new Error("Unable to load Monaco"));
      document.head.appendChild(script);
    });
  }

  async function createMonaco(value, language = "html") {
    clear(main);
    const host = el("div", { className: `${NS}editor` });
    main.appendChild(host);

    // Force a layout pass so flex height is resolved before Monaco measures
    host.offsetHeight;

    try {
      const monaco = await loadMonaco();
      editor = monaco.editor.create(host, {
        value,
        language,
        theme: "vs-dark",
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        lineNumbers: "on",
        roundedSelection: false,
        scrollBeyondLastLine: false,
        wordWrap: "off",
        padding: { top: 8 },
      });
      editorReady = true;

      // ResizeObserver keeps Monaco correct when sidebar is resized
      const ro = new ResizeObserver(() => {
        try { editor.layout(); } catch {}
      });
      ro.observe(host);

      return editor;
    } catch {
      editorReady = false;
      const fallback = el("textarea", { className: `${NS}fallback-editor` });
      fallback.value = value;
      main.appendChild(fallback);
      return fallback;
    }
  }

  /* ── Highlight ── */

  function ensureHighlight() {
    if (highlightEl) return highlightEl;
    highlightEl = el("div", { className: `${NS}highlight` });
    highlightEl.style.display = "none";
    document.documentElement.appendChild(highlightEl);
    return highlightEl;
  }

  function showHighlight(target) {
    if (!target || !target.getBoundingClientRect) return;
    const box = ensureHighlight();
    const r = target.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = Math.max(0, r.width) + "px";
    box.style.height = Math.max(0, r.height) + "px";
  }

  function hideHighlight() {
    if (highlightEl) highlightEl.style.display = "none";
  }

  /* ── Elements ── */

  function nodeLabel(node) {
    if (node.nodeType === 3) {
      const t = node.textContent.trim();
      if (!t) return null;
      return { kind: "text", text: t.slice(0, 80) + (t.length > 80 ? "…" : "") };
    }
    if (node.nodeType === 8) {
      return { kind: "comment", text: `<!-- ${node.textContent.slice(0, 40)} -->` };
    }
    if (node.nodeType !== 1) return null;
    const tag = node.tagName.toLowerCase();
    let attrs = "";
    if (node.id) attrs += ` id="${node.id}"`;
    if (node.className && typeof node.className === "string") {
      const c = node.className.trim().split(/\s+/).slice(0, 3).join(" ");
      if (c) attrs += ` class="${c}"`;
    }
    return { kind: "element", tag, attrs };
  }

  function buildTreeNode(domNode, depth = 0) {
    const info = nodeLabel(domNode);
    if (!info) return null;

    const row = el("div", { className: `${NS}tree-node`, dataset: { depth: String(depth) } });
    row._dom = domNode;

    const toggle = el("span", { className: `${NS}tree-toggle` }, " ");
    const label = el("span");

    if (info.kind === "element") {
      const kids = Array.from(domNode.childNodes).filter((n) => nodeLabel(n));
      if (kids.length) {
        toggle.textContent = depth < 2 ? "▾" : "▸";
        toggle.onclick = (e) => {
          e.stopPropagation();
          const children = row.nextElementSibling;
          if (children && children.classList.contains(`${NS}tree-children`)) {
            const open = children.style.display !== "none";
            children.style.display = open ? "none" : "block";
            toggle.textContent = open ? "▸" : "▾";
          }
        };
      }
      label.innerHTML =
        `<span class="${NS}tree-tag">&lt;${escapeHTML(info.tag)}</span>` +
        (info.attrs
          ? info.attrs.replace(/(\w+)="([^"]*)"/g, (_, k, v) =>
              ` <span class="${NS}tree-attr">${escapeHTML(k)}</span>=<span class="${NS}tree-val">"${escapeHTML(v)}"</span>`
            )
          : "") +
        `<span class="${NS}tree-tag">&gt;</span>`;
    } else if (info.kind === "text") {
      label.innerHTML = `<span class="${NS}tree-text">"${escapeHTML(info.text)}"</span>`;
    } else {
      label.innerHTML = `<span class="${NS}tree-text">${escapeHTML(info.text)}</span>`;
    }

    row.append(toggle, label);

    row.addEventListener("mouseenter", () => {
      if (domNode.nodeType === 1) showHighlight(domNode);
    });
    row.addEventListener("mouseleave", hideHighlight);

    row.addEventListener("click", (e) => {
      e.stopPropagation();
      if (selectedNode) selectedNode.classList.remove(`${NS}selected`);
      row.classList.add(`${NS}selected`);
      selectedNode = row;
      updateElementDetail(domNode);
      if (domNode.nodeType === 1) {
        showHighlight(domNode);
        try { domNode.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch {}
      }
    });

    const wrap = document.createDocumentFragment();
    wrap.appendChild(row);

    if (info.kind === "element") {
      const kids = Array.from(domNode.childNodes).filter((n) => nodeLabel(n));
      if (kids.length) {
        const children = el("div", { className: `${NS}tree-children` });
        children.style.display = depth < 2 ? "block" : "none";
        for (const child of kids) {
          const built = buildTreeNode(child, depth + 1);
          if (built) children.appendChild(built);
        }
        wrap.appendChild(children);
      }
    }
    return wrap;
  }

  function updateElementDetail(domNode) {
    clear(detail);
    if (!domNode || domNode.nodeType !== 1) {
      detail.appendChild(el("div", { className: `${NS}side-heading` }, "Element"));
      detail.appendChild(el("div", { className: `${NS}side-text` }, "Select a node in the tree."));
      return;
    }

    detail.appendChild(el("div", { className: `${NS}side-heading` }, `<${domNode.tagName.toLowerCase()}>`));
    const rect = domNode.getBoundingClientRect();
    detail.appendChild(
      el("div", { className: `${NS}side-text` },
        `${Math.round(rect.width)}×${Math.round(rect.height)} · ${domNode.childNodes.length} children`)
    );

    detail.appendChild(el("div", { className: `${NS}side-heading` }, "Attributes"));
    if (!domNode.attributes.length) {
      detail.appendChild(el("div", { className: `${NS}side-text` }, "(none)"));
    } else {
      for (const attr of domNode.attributes) {
        const row = el("div", { className: `${NS}side-text` });
        row.innerHTML = `<strong style="color:#9cdcfe">${escapeHTML(attr.name)}</strong> = "${escapeHTML(attr.value.slice(0, 80))}"`;
        detail.appendChild(row);
      }
    }

    const styles = getComputedStyle(domNode);
    detail.appendChild(el("div", { className: `${NS}side-heading` }, "Key styles"));
    for (const prop of ["display", "position", "width", "height", "color", "background-color", "font-size"]) {
      detail.appendChild(el("div", { className: `${NS}side-text` }, `${prop}: ${styles.getPropertyValue(prop)}`));
    }

    const delBtn = el("button", { className: `${NS}action`, dataset: { danger: "1" } }, "Remove element");
    delBtn.onclick = async () => {
      if (!(await authenticate())) return;
      domNode.remove();
      hideHighlight();
      showElements();
    };
    detail.appendChild(delBtn);
  }

  function showElements() {
    currentTab = "Elements";
    clear(main);
    clear(detail);
    detail.style.display = "";

    const toolbar = el("div", { className: `${NS}toolbar` });
    const search = el("input", { className: `${NS}search`, placeholder: "Filter nodes…" });
    const refresh = el("button", { className: `${NS}action`, style: { margin: "0" } }, "Refresh");
    toolbar.append(search, refresh);
    main.appendChild(toolbar);

    const tree = el("div", { className: `${NS}tree` });
    main.appendChild(tree);

    const render = (filter = "") => {
      clear(tree);
      const built = buildTreeNode(document.documentElement, 0);
      if (built) tree.appendChild(built);
      if (filter) {
        const q = filter.toLowerCase();
        tree.querySelectorAll(`.${NS}tree-node`).forEach((row) => {
          row.style.display = row.textContent.toLowerCase().includes(q) ? "" : "none";
        });
      }
    };

    render();
    search.addEventListener("input", () => render(search.value.trim()));
    refresh.onclick = () => render(search.value.trim());

    detail.appendChild(el("div", { className: `${NS}side-heading` }, "DOM Inspector"));
    detail.appendChild(el("div", { className: `${NS}side-text` }, "Hover to highlight · Click to inspect"));
  }

  /* ── Console ── */

  function showConsole() {
    currentTab = "Console";
    clear(main);
    clear(detail);
    detail.style.display = "none";

    const toolbar = el("div", { className: `${NS}toolbar` });
    const clearBtn = el("button", { className: `${NS}action`, style: { margin: "0" } }, "Clear");
    toolbar.appendChild(clearBtn);
    main.appendChild(toolbar);

    const output = el("div", { className: `${NS}console-output` });
    main.appendChild(output);

    const inputWrap = el("div", { className: `${NS}console-input-wrap` });
    const prompt = el("span", { className: `${NS}console-prompt` }, "›");
    const input = el("textarea", {
      className: `${NS}console-input`,
      placeholder: "JS · Enter run · Shift+Enter newline · ↑/↓ history",
      rows: 1,
    });
    inputWrap.append(prompt, input);
    main.appendChild(inputWrap);

    const write = (value, type = "result") => {
      const row = el("div", { className: `${NS}console-row ${NS}${type}` });
      if (typeof value === "string") row.textContent = value;
      else {
        try { row.textContent = JSON.stringify(value, null, 2); }
        catch { row.textContent = String(value); }
      }
      output.appendChild(row);
      output.scrollTop = output.scrollHeight;
    };

    clearBtn.onclick = () => clear(output);

    if (window[`${NS}logBuffer`]) {
      for (const entry of window[`${NS}logBuffer`]) {
        write(entry.args.map(String).join(" "), entry.level);
      }
    }

    input.addEventListener("keydown", async (event) => {
      if (event.key === "ArrowUp" && !event.shiftKey) {
        event.preventDefault();
        if (!consoleHistory.length) return;
        if (historyIndex < 0) historyIndex = consoleHistory.length;
        historyIndex = Math.max(0, historyIndex - 1);
        input.value = consoleHistory[historyIndex] || "";
        return;
      }
      if (event.key === "ArrowDown" && !event.shiftKey) {
        event.preventDefault();
        if (historyIndex < 0) return;
        historyIndex = Math.min(consoleHistory.length, historyIndex + 1);
        input.value = historyIndex >= consoleHistory.length ? "" : consoleHistory[historyIndex] || "";
        return;
      }
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();

      const code = input.value.trim();
      if (!code) return;
      input.value = "";
      consoleHistory.push(code);
      historyIndex = -1;
      write(`› ${code}`, "command");

      if (!(await authenticate())) {
        write("Execution denied.", "error");
        return;
      }
      try {
        const result = (0, eval)(code);
        write(result === undefined ? "undefined" : result);
      } catch (error) {
        write(error?.stack || String(error), "error");
      }
    });
  }

  /* ── Sources ── */

  async function showSources() {
    currentTab = "Sources";
    clear(main);
    clear(detail);
    detail.style.display = "";

    const source = document.documentElement.outerHTML;
    const ed = await createMonaco(source, "html");

    const apply = el("button", { className: `${NS}action`, dataset: { primary: "1" } }, "Apply changes");
    apply.onclick = async () => {
      if (!(await authenticate())) return;
      const replacement = editorReady ? editor.getValue() : ed.value;
      document.open();
      document.write(replacement);
      document.close();
    };

    detail.appendChild(el("div", { className: `${NS}side-heading` }, "Sources"));
    detail.appendChild(el("div", { className: `${NS}side-text` }, "Edit live HTML. Apply requires password."));
    detail.appendChild(apply);
  }

  /* ── Network ── */

  function installNetworkIntercept() {
    if (intercepted) return;
    intercepted = true;

    originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const start = performance.now();
      let method = "GET";
      let url = "";
      try {
        if (typeof args[0] === "string") {
          url = args[0];
          method = (args[1] && args[1].method) || "GET";
        } else if (args[0] && args[0].url) {
          url = args[0].url;
          method = args[0].method || "GET";
        }
      } catch {}

      const entry = {
        id: crypto.randomUUID(),
        method: String(method).toUpperCase(),
        url, status: 0, type: "fetch", size: 0, time: 0, ok: false,
      };
      networkLog.unshift(entry);
      if (networkLog.length > 200) networkLog.length = 200;

      try {
        const res = await originalFetch.apply(this, args);
        entry.status = res.status;
        entry.ok = res.ok;
        entry.time = Math.round(performance.now() - start);
        try {
          const clone = res.clone();
          const buf = await clone.arrayBuffer();
          entry.size = buf.byteLength;
        } catch {}
        return res;
      } catch (err) {
        entry.status = 0;
        entry.ok = false;
        entry.time = Math.round(performance.now() - start);
        throw err;
      } finally {
        if (currentTab === "Network") renderNetworkList();
      }
    };

    originalXHROpen = XMLHttpRequest.prototype.open;
    originalXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__n3xn = { method: String(method).toUpperCase(), url: String(url), start: 0 };
      return originalXHROpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      const meta = this.__n3xn || { method: "GET", url: "" };
      meta.start = performance.now();
      const entry = {
        id: crypto.randomUUID(),
        method: meta.method, url: meta.url,
        status: 0, type: "xhr", size: 0, time: 0, ok: false,
      };
      networkLog.unshift(entry);
      if (networkLog.length > 200) networkLog.length = 200;

      this.addEventListener("loadend", () => {
        entry.status = this.status;
        entry.ok = this.status >= 200 && this.status < 400;
        entry.time = Math.round(performance.now() - meta.start);
        try { entry.size = (this.responseText && this.responseText.length) || 0; } catch {}
        if (currentTab === "Network") renderNetworkList();
      });
      return originalXHRSend.apply(this, args);
    };
  }

  function renderNetworkList() {
    if (!netListEl) return;
    clear(netListEl);
    const filtered = networkLog.filter((e) => {
      if (!netFilter) return true;
      const q = netFilter.toLowerCase();
      return e.url.toLowerCase().includes(q) || e.method.toLowerCase().includes(q) || String(e.status).includes(q);
    });
    if (!filtered.length) {
      netListEl.appendChild(el("div", { className: `${NS}empty` }, "No requests yet."));
      return;
    }
    for (const entry of filtered) {
      const row = el("div", { className: `${NS}network-row` });
      row.append(
        el("div", { className: `${NS}network-method`, dataset: { m: entry.method } }, entry.method),
        el("div", { className: `${NS}network-name`, title: entry.url }, shortUrl(entry.url)),
        el("div", { className: `${NS}network-status`, dataset: { ok: entry.ok ? "1" : "0" } }, entry.status || "…"),
        el("div", { className: `${NS}network-meta` }, formatBytes(entry.size)),
        el("div", { className: `${NS}network-meta` }, entry.time ? entry.time + " ms" : "…"),
      );
      netListEl.appendChild(row);
    }
  }

  function showNetwork() {
    currentTab = "Network";
    clear(main);
    clear(detail);
    detail.style.display = "";
    installNetworkIntercept();

    try {
      for (const entry of performance.getEntriesByType("resource")) {
        if (networkLog.some((e) => e.url === entry.name)) continue;
        networkLog.push({
          id: crypto.randomUUID(), method: "GET", url: entry.name,
          status: 200, type: entry.initiatorType || "resource",
          size: entry.transferSize || 0, time: Math.round(entry.duration), ok: true,
        });
      }
    } catch {}

    const toolbar = el("div", { className: `${NS}toolbar` });
    const search = el("input", { className: `${NS}search`, placeholder: "Filter…" });
    const clearBtn = el("button", { className: `${NS}action`, style: { margin: "0" } }, "Clear");
    toolbar.append(search, clearBtn);
    main.appendChild(toolbar);

    netListEl = el("div", { className: `${NS}net-list` });
    main.appendChild(netListEl);

    search.addEventListener("input", () => { netFilter = search.value.trim(); renderNetworkList(); });
    clearBtn.onclick = () => { networkLog = []; renderNetworkList(); };
    renderNetworkList();

    detail.appendChild(el("div", { className: `${NS}side-heading` }, "Network"));
    detail.appendChild(el("div", { className: `${NS}side-text` }, `${networkLog.length} requests · live intercept`));
  }

  /* ── Application ── */


  /* ── Storage write attribution ── */

  const storageAttribution = Object.create(null);
  // key: "localStorage:foo" | "sessionStorage:bar" | "cookie:name"
  // value: { stack, via, time, valuePreview }

  function recordAttr(kind, key, value, via) {
    let stack = "";
    try {
      const err = new Error();
      stack = (err.stack || "")
        .split("\n")
        .slice(3, 10)
        .map((l) => l.trim())
        .filter((l) => l && !l.includes("devtools.js") && !l.includes("__n3xn_"))
        .join("\n");
    } catch {}
    storageAttribution[`${kind}:${key}`] = {
      stack: stack || "(no stack)",
      via: via || kind,
      time: Date.now(),
      valuePreview: String(value).slice(0, 200),
    };
  }

  function installStorageHooks() {
    if (window[`${NS}storageHooks`]) return;
    window[`${NS}storageHooks`] = true;

    const wrapStore = (store, kind) => {
      const origSet = store.setItem.bind(store);
      const origRemove = store.removeItem.bind(store);
      const origClear = store.clear.bind(store);
      store.setItem = function (key, value) {
        recordAttr(kind, String(key), value, `${kind}.setItem`);
        return origSet(key, value);
      };
      store.removeItem = function (key) {
        delete storageAttribution[`${kind}:${key}`];
        return origRemove(key);
      };
      store.clear = function () {
        for (const k of Object.keys(storageAttribution)) {
          if (k.startsWith(kind + ":")) delete storageAttribution[k];
        }
        return origClear();
      };
    };

    try { wrapStore(localStorage, "localStorage"); } catch {}
    try { wrapStore(sessionStorage, "sessionStorage"); } catch {}

    // document.cookie setter
    try {
      const desc = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")
        || Object.getOwnPropertyDescriptor(HTMLDocument.prototype, "cookie");
      if (desc && desc.set) {
        const origSet = desc.set;
        const origGet = desc.get;
        Object.defineProperty(document, "cookie", {
          configurable: true,
          enumerable: true,
          get() {
            return origGet.call(this);
          },
          set(v) {
            try {
              const name = String(v).split("=")[0].trim();
              recordAttr("cookie", name, v, "document.cookie =");
            } catch {}
            return origSet.call(this, v);
          },
        });
      }
    } catch {}
  }


  function showApplication() {
    currentTab = "Application";
    clear(main);
    clear(detail);
    detail.style.display = "";
    installStorageHooks();

    const toolbar = el("div", { className: `${NS}toolbar` });
    const select = el("select", {
      className: `${NS}select`,
      style: { margin: "0", width: "auto", minWidth: "150px" },
    });
    for (const opt of [
      "localStorage",
      "sessionStorage",
      "cookies",
      "JS variables",
    ]) {
      select.appendChild(el("option", { value: opt }, opt));
    }

    const addBtn = el("button", { className: `${NS}action`, style: { margin: "0" } }, "Add / Set");
    const clearBtn = el(
      "button",
      { className: `${NS}action`, style: { margin: "0" }, dataset: { danger: "1" } },
      "Clear all",
    );
    const search = el("input", {
      className: `${NS}search`,
      placeholder: "Filter…",
      style: { maxWidth: "180px" },
    });
    toolbar.append(select, search, addBtn, clearBtn);
    main.appendChild(toolbar);

    const list = el("div", { className: `${NS}storage-list` });
    main.appendChild(list);

    function attrFor(kind, key) {
      return storageAttribution[`${kind}:${key}`] || null;
    }

    function showAttr(kind, key, value) {
      clear(detail);
      detail.appendChild(el("div", { className: `${NS}side-heading` }, `${kind} · ${key}`));
      detail.appendChild(
        el("div", { className: `${NS}side-text` }, String(value).slice(0, 500)),
      );

      const a = attrFor(kind, key);
      detail.appendChild(el("div", { className: `${NS}side-heading` }, "Written by"));
      if (a) {
        detail.appendChild(
          el(
            "div",
            { className: `${NS}side-text` },
            `${a.via}\n${new Date(a.time).toLocaleString()}\n\n${a.stack}`,
          ),
        );
      } else {
        detail.appendChild(
          el(
            "div",
            { className: `${NS}side-text` },
            "Unknown — set before DevTools hooks, by HTTP Set-Cookie, or outside this page.",
          ),
        );
      }

      const editLabel = el("div", { className: `${NS}side-heading` }, "Edit value");
      const edit = el("textarea", {
        className: `${NS}textarea`,
        style: { maxWidth: "100%", minHeight: "60px" },
      });
      edit.value = value == null ? "" : String(value);
      const save = el("button", { className: `${NS}action`, dataset: { primary: "1" } }, "Save");
      save.onclick = async () => {
        if (!(await authenticate())) return;
        const kind = select.value;
        try {
          if (kind === "localStorage") localStorage.setItem(key, edit.value);
          else if (kind === "sessionStorage") sessionStorage.setItem(key, edit.value);
          else if (kind === "cookies") {
            document.cookie = `${encodeURIComponent(key)}=${edit.value}; path=/`;
          }
          recordAttr(kind === "cookies" ? "cookie" : kind, key, edit.value, "DevTools edit");
          render();
          showAttr(kind === "cookies" ? "cookie" : kind, key, edit.value);
        } catch (err) {
          window.alert(String(err));
        }
      };
      const del = el("button", { className: `${NS}action`, dataset: { danger: "1" } }, "Delete");
      del.onclick = async () => {
        if (!(await authenticate())) return;
        const kind = select.value;
        if (kind === "localStorage") localStorage.removeItem(key);
        else if (kind === "sessionStorage") sessionStorage.removeItem(key);
        else if (kind === "cookies") {
          document.cookie = `${encodeURIComponent(key)}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
        }
        clear(detail);
        detail.appendChild(el("div", { className: `${NS}side-text` }, "Deleted."));
        render();
      };
      detail.append(editLabel, edit, save, del);
    }

    function typeName(v) {
      if (v === null) return "null";
      if (v === undefined) return "undefined";
      if (Array.isArray(v)) return "Array";
      if (v instanceof Element) return "Element";
      if (v instanceof Node) return "Node";
      if (typeof v === "function") return "function";
      if (typeof v === "object") {
        try {
          const n = v.constructor && v.constructor.name;
          return n || "Object";
        } catch {
          return "Object";
        }
      }
      return typeof v;
    }

    function previewValue(v) {
      try {
        if (v === null) return "null";
        if (v === undefined) return "undefined";
        if (typeof v === "function") {
          const name = v.name || "(anonymous)";
          return `ƒ ${name}`;
        }
        if (typeof v === "symbol") return v.toString();
        if (typeof v === "bigint") return v.toString() + "n";
        if (typeof v === "string") return JSON.stringify(v.slice(0, 120));
        if (typeof v === "number" || typeof v === "boolean") return String(v);
        if (Array.isArray(v)) return `Array(${v.length})`;
        if (v instanceof Element) return `<${v.tagName.toLowerCase()}>`;
        return typeName(v);
      } catch {
        return "(unreadable)";
      }
    }

    // Known browser / boring globals to de-prioritize
    const BORING = new Set([
      "window", "self", "document", "location", "navigator", "history", "screen",
      "localStorage", "sessionStorage", "caches", "indexedDB", "crypto", "performance",
      "console", "chrome", "webkitStorageInfo", "speechSynthesis", "trustedTypes",
      "customElements", "CSS", "StyleSheet", "HTMLElement", "Node", "Element",
      "Event", "MouseEvent", "KeyboardEvent", "Promise", "Proxy", "Reflect",
      "Array", "Object", "String", "Number", "Boolean", "Symbol", "Map", "Set",
      "WeakMap", "WeakSet", "JSON", "Math", "Date", "RegExp", "Error", "Function",
      "parseInt", "parseFloat", "isNaN", "isFinite", "eval", "alert", "confirm",
      "prompt", "fetch", "XMLHttpRequest", "WebSocket", "Worker", "Blob", "File",
      "FormData", "URL", "URLSearchParams", "Headers", "Request", "Response",
      "AbortController", "MutationObserver", "ResizeObserver", "IntersectionObserver",
      "requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "setInterval",
      "clearTimeout", "clearInterval", "queueMicrotask", "structuredClone",
      "atob", "btoa", "encodeURI", "decodeURI", "encodeURIComponent", "decodeURIComponent",
      "getComputedStyle", "matchMedia", "getSelection", "find", "focus", "blur",
      "open", "close", "print", "stop", "moveBy", "moveTo", "resizeBy", "resizeTo",
      "scroll", "scrollBy", "scrollTo", "postMessage", "reportError",
      "frames", "parent", "top", "opener", "closed", "length", "name", "status",
      "origin", "event", "undefined", "NaN", "Infinity", "globalThis",
    ]);

    function listGlobals(filter) {
      const out = [];
      const seen = new Set();
      let obj = window;
      let depth = 0;
      while (obj && depth < 3) {
        let names = [];
        try {
          names = Object.getOwnPropertyNames(obj);
        } catch {
          break;
        }
        for (const name of names) {
          if (seen.has(name)) continue;
          seen.add(name);
          if (name.startsWith("__n3xn_")) continue;
          if (filter && !name.toLowerCase().includes(filter) && !String(typeName(safeGet(name))).toLowerCase().includes(filter)) {
            // still allow if filter matches preview later
          }
          let value;
          let readable = true;
          try {
            value = obj[name];
          } catch {
            readable = false;
            value = undefined;
          }
          const t = readable ? typeName(value) : "(throw)";
          const boring = BORING.has(name) || (typeof value === "function" && /^[A-Z]/.test(name) && name.length > 2);
          out.push({ name, value, type: t, boring, readable });
        }
        try {
          obj = Object.getPrototypeOf(obj);
        } catch {
          break;
        }
        depth++;
      }
      // sort: non-boring first, then alpha
      out.sort((a, b) => {
        if (a.boring !== b.boring) return a.boring ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
      if (filter) {
        const q = filter.toLowerCase();
        return out.filter(
          (x) =>
            x.name.toLowerCase().includes(q) ||
            x.type.toLowerCase().includes(q) ||
            previewValue(x.value).toLowerCase().includes(q),
        );
      }
      return out;
    }

    function safeGet(name) {
      try {
        return window[name];
      } catch {
        return undefined;
      }
    }

    function showGlobal(entry) {
      clear(detail);
      detail.appendChild(el("div", { className: `${NS}side-heading` }, `window.${entry.name}`));
      detail.appendChild(el("div", { className: `${NS}side-text` }, `type: ${entry.type}`));
      let text = "";
      try {
        if (typeof entry.value === "function") {
          text = Function.prototype.toString.call(entry.value).slice(0, 2000);
        } else if (typeof entry.value === "object" && entry.value !== null) {
          text = JSON.stringify(entry.value, (k, v) => {
            if (typeof v === "function") return `ƒ ${v.name || ""}`;
            if (typeof v === "bigint") return v.toString() + "n";
            if (v instanceof Element) return `<${v.tagName.toLowerCase()}>`;
            return v;
          }, 2).slice(0, 4000);
        } else {
          text = String(entry.value);
        }
      } catch (err) {
        text = "(cannot serialize: " + err + ")";
      }
      const pre = el("div", { className: `${NS}side-text`, style: { whiteSpace: "pre-wrap", fontFamily: "Consolas,monospace" } });
      pre.textContent = text;
      detail.appendChild(pre);

      if (entry.readable && typeof entry.value !== "function") {
        const edit = el("textarea", { className: `${NS}textarea`, style: { maxWidth: "100%" } });
        try {
          edit.value =
            typeof entry.value === "string"
              ? entry.value
              : JSON.stringify(entry.value, null, 2);
        } catch {
          edit.value = String(entry.value);
        }
        const save = el("button", { className: `${NS}action`, dataset: { primary: "1" } }, "Set window." + entry.name);
        save.onclick = async () => {
          if (!(await authenticate())) return;
          try {
            let v = edit.value;
            try {
              v = JSON.parse(edit.value);
            } catch {
              /* keep string */
            }
            window[entry.name] = v;
            render();
            showGlobal({ ...entry, value: window[entry.name], type: typeName(window[entry.name]) });
          } catch (err) {
            window.alert(String(err));
          }
        };
        detail.append(el("div", { className: `${NS}side-heading` }, "Edit"), edit, save);
      }
    }

    function render() {
      clear(list);
      const kind = select.value;
      const filter = (search.value || "").trim().toLowerCase();

      if (kind === "JS variables") {
        const globals = listGlobals(filter);
        if (!globals.length) {
          list.appendChild(el("div", { className: `${NS}empty` }, "No matching globals."));
          return;
        }
        // header row
        const head = el("div", { className: `${NS}storage-row` });
        head.style.opacity = "0.6";
        head.append(
          el("div", { className: `${NS}storage-key` }, "name"),
          el("div", { className: `${NS}storage-val` }, "type / preview"),
          el("div", {}, ""),
        );
        list.appendChild(head);

        let shown = 0;
        for (const g of globals) {
          if (shown > 400) {
            list.appendChild(el("div", { className: `${NS}empty` }, "…truncated (filter to narrow)"));
            break;
          }
          // default hide boring unless filtering
          if (g.boring && !filter) continue;
          shown++;
          const row = el("div", { className: `${NS}storage-row` });
          row.style.cursor = "pointer";
          if (g.boring) row.style.opacity = "0.55";
          row.append(
            el("div", { className: `${NS}storage-key`, title: g.name }, g.name),
            el(
              "div",
              { className: `${NS}storage-val`, title: previewValue(g.value) },
              `${g.type}  ${previewValue(g.value)}`.slice(0, 100),
            ),
            el("div", {}, ""),
          );
          row.onclick = () => showGlobal(g);
          list.appendChild(row);
        }
        if (!shown) {
          list.appendChild(
            el("div", { className: `${NS}empty` }, "Only built-ins found — type a filter to show them."),
          );
        }
        return;
      }

      if (kind === "cookies") {
        const cookies = document.cookie ? document.cookie.split("; ") : [];
        const rows = cookies
          .map((c) => {
            const eq = c.indexOf("=");
            const k = eq === -1 ? c : c.slice(0, eq);
            const v = eq === -1 ? "" : c.slice(eq + 1);
            return { k: decodeURIComponent(k), v };
          })
          .filter((x) => !filter || x.k.toLowerCase().includes(filter) || x.v.toLowerCase().includes(filter));

        if (!rows.length) {
          list.appendChild(el("div", { className: `${NS}empty` }, "No cookies."));
          return;
        }
        for (const { k, v } of rows) {
          const row = el("div", { className: `${NS}storage-row` });
          row.style.cursor = "pointer";
          const a = attrFor("cookie", k);
          const src = a ? a.via : "?";
          row.append(
            el("div", { className: `${NS}storage-key`, title: k }, k),
            el("div", { className: `${NS}storage-val`, title: v }, v.slice(0, 80)),
            el("div", { className: `${NS}network-meta`, title: src }, src.slice(0, 8)),
          );
          row.onclick = () => showAttr("cookie", k, v);
          list.appendChild(row);
        }
        return;
      }

      const store = kind === "localStorage" ? localStorage : sessionStorage;
      const keys = Object.keys(store).filter(
        (k) =>
          !filter ||
          k.toLowerCase().includes(filter) ||
          String(store.getItem(k) || "").toLowerCase().includes(filter),
      );
      if (!keys.length) {
        list.appendChild(el("div", { className: `${NS}empty` }, `No ${kind} entries.`));
        return;
      }
      for (const key of keys) {
        const val = store.getItem(key) || "";
        const row = el("div", { className: `${NS}storage-row` });
        row.style.cursor = "pointer";
        const a = attrFor(kind, key);
        const src = a ? a.via : "?";
        row.append(
          el("div", { className: `${NS}storage-key`, title: key }, key),
          el("div", { className: `${NS}storage-val`, title: val }, val.slice(0, 80)),
          el("div", { className: `${NS}network-meta`, title: src }, src.slice(0, 10)),
        );
        row.onclick = () => showAttr(kind, key, val);
        list.appendChild(row);
      }
    }

    select.onchange = () => {
      clear(detail);
      detail.appendChild(
        el("div", { className: `${NS}side-text` }, "Select a row for details, source, and edit."),
      );
      render();
    };
    search.addEventListener("input", render);

    addBtn.onclick = async () => {
      if (!(await authenticate())) return;
      const kind = select.value;
      if (kind === "JS variables") {
        const name = window.prompt("Global property name (window.NAME):");
        if (!name) return;
        const raw = window.prompt("Value (JSON or plain string):", '""');
        if (raw === null) return;
        let v = raw;
        try {
          v = JSON.parse(raw);
        } catch {}
        try {
          window[name] = v;
          render();
        } catch (err) {
          window.alert(String(err));
        }
        return;
      }
      const key = window.prompt("Key / cookie name:");
      if (!key) return;
      const value = window.prompt("Value:", "") ?? "";
      try {
        if (kind === "localStorage") localStorage.setItem(key, value);
        else if (kind === "sessionStorage") sessionStorage.setItem(key, value);
        else if (kind === "cookies") {
          document.cookie = `${encodeURIComponent(key)}=${value}; path=/`;
        }
        recordAttr(kind === "cookies" ? "cookie" : kind, key, value, "DevTools add");
        render();
      } catch (err) {
        window.alert(String(err));
      }
    };

    clearBtn.onclick = async () => {
      if (!(await authenticate())) return;
      const kind = select.value;
      if (kind === "JS variables") {
        window.alert("Clear all is not available for JS variables (would break the page).");
        return;
      }
      if (!window.confirm(`Clear all ${kind}?`)) return;
      if (kind === "localStorage") localStorage.clear();
      else if (kind === "sessionStorage") sessionStorage.clear();
      else if (kind === "cookies") {
        for (const c of document.cookie.split("; ")) {
          const name = c.split("=")[0].trim();
          if (!name) continue;
          document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
        }
      }
      render();
    };

    detail.appendChild(el("div", { className: `${NS}side-heading` }, "Application"));
    detail.appendChild(
      el(
        "div",
        { className: `${NS}side-text` },
        "Storage edits need the DevTools password. “Written by” shows a stack when the write happened after DevTools loaded.",
      ),
    );
    render();
  }


  function showSettings() {
    currentTab = "Settings";
    clear(main);
    clear(detail);
    detail.style.display = "none";

    const container = el("div", { className: `${NS}settings` });

    const titleLabel = el("label", { className: `${NS}label` }, "Title override");
    const title = el("input", { className: `${NS}input`, value: state.titleOverride || "", placeholder: "Custom document title" });

    const faviconLabel = el("label", { className: `${NS}label` }, "Favicon URL");
    const favicon = el("input", { className: `${NS}input`, value: state.faviconOverride || "", placeholder: "https://example.com/favicon.ico" });

    const cloakTitleLabel = el("label", { className: `${NS}label` }, "Cloak title (for blob / about:blank)");
    const cloakTitle = el("input", { className: `${NS}input`, value: state.cloakTitle || "", placeholder: "Google" });

    const cloakFavLabel = el("label", { className: `${NS}label` }, "Cloak favicon URL");
    const cloakFav = el("input", { className: `${NS}input`, value: state.cloakFavicon || "", placeholder: "https://www.google.com/favicon.ico" });

    const scriptLabel = el("label", { className: `${NS}label` }, "Auto script (URL or JS)");
    const script = el("textarea", { className: `${NS}textarea`, placeholder: "https://…/script.js  or  console.log('hi')" });

    const save = el("button", { className: `${NS}action`, dataset: { primary: "1" } }, "Save");
    save.onclick = async () => {
      state.titleOverride = title.value.trim() || null;
      state.faviconOverride = favicon.value.trim() || null;
      state.cloakTitle = cloakTitle.value.trim() || null;
      state.cloakFavicon = cloakFav.value.trim() || null;
      if (script.value.trim()) {
        addScript(script.value);
        script.value = "";
      }
      applyIdentity();
      await saveState();
      save.textContent = "Saved ✓";
      setTimeout(() => (save.textContent = "Save"), 1200);
    };

    const blobBtn = el("button", { className: `${NS}action` }, "Open blob cloaked");
    blobBtn.onclick = openBlobCloak;

    const aboutBtn = el("button", { className: `${NS}action` }, "Open about:blank cloaked");
    aboutBtn.onclick = openAboutCloak;

    const enabledLabel = el("label", { className: `${NS}toggle` });
    const enabled = el("input", { type: "checkbox" });
    enabled.checked = state.enabled;
    enabled.addEventListener("change", async () => {
      state.enabled = enabled.checked;
      await saveState();
      root.style.display = state.enabled ? "" : "none";
      if (!state.enabled) closePanel();
    });
    enabledLabel.append(enabled, document.createTextNode(" Enable n3xn DevTools"));

    const note = el("div", { className: `${NS}side-text`, style: { marginTop: "12px" } },
      "Shortcuts: F12 / Ctrl+Shift+I toggle · Esc close · Drag left edge to resize");

    container.append(
      titleLabel, title,
      faviconLabel, favicon,
      cloakTitleLabel, cloakTitle,
      cloakFavLabel, cloakFav,
      scriptLabel, script,
      save, blobBtn, aboutBtn, enabledLabel, note,
    );
    main.appendChild(container);
  }

  function addScript(source) {
    source = source.trim();
    if (!source) return;
    if (/^https?:\/\//i.test(source)) {
      const s = document.createElement("script");
      s.src = source;
      s.async = false;
      document.head.appendChild(s);
      state.scripts.push({ type: "url", value: source });
      return;
    }
    try {
      (0, eval)(source);
      state.scripts.push({ type: "code", value: source });
    } catch (error) {
      console.error("n3xn DevTools script:", error);
    }
  }

  function applyIdentity() {
    if (state.titleOverride !== null) document.title = state.titleOverride;
    if (state.faviconOverride !== null) {
      let icon = document.querySelector('link[rel~="icon"]');
      if (!icon) {
        icon = document.createElement("link");
        icon.rel = "icon";
        document.head.appendChild(icon);
      }
      icon.href = state.faviconOverride;
    }
  }

  /** Build cloaked shell HTML */
  function buildCloakHtml(targetUrl) {
    const title = state.cloakTitle || state.titleOverride || document.title || "New Tab";
    const favicon = state.cloakFavicon || state.faviconOverride || "";
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(title)}</title>
${favicon ? `<link rel="icon" href="${escapeHTML(favicon)}">` : ""}
<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}iframe{border:0;position:fixed;inset:0;width:100%;height:100%}</style>
</head>
<body>
<iframe src="${escapeHTML(targetUrl)}" allow="accelerometer;autoplay;camera;clipboard-read;clipboard-write;encrypted-media;fullscreen;geolocation;gyroscope;microphone;midi;payment;picture-in-picture;screen-wake-lock;web-share;xr-spatial-tracking" allowfullscreen></iframe>
</body>
</html>`;
  }

  /** about:blank cloak (popup) */
  function openAboutCloak() {
    const popup = window.open("about:blank", "_blank");
    if (!popup) {
      window.alert("Popup blocked.");
      return;
    }
    const html = buildCloakHtml(location.href);
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
  }

  /** blob: URL cloak — navigates current tab or opens new */
  function openBlobCloak() {
    const html = buildCloakHtml(location.href);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    // Prefer new tab so the original session stays
    const w = window.open(url, "_blank");
    if (!w) {
      // Fallback: navigate this tab
      location.href = url;
    }
  }

  /* ── Tabs ── */

  function activateTab(tab) {
    switch (tab) {
      case "Elements": showElements(); break;
      case "Console": showConsole(); break;
      case "Sources": showSources(); break;
      case "Network": showNetwork(); break;
      case "Application": showApplication(); break;
      case "Settings": showSettings(); break;
      default: showElements();
    }
  }

  /* ── Open / close sidebar (pushes page) ── */

  function setDockHeight(px) {
    const h = Math.max(160, Math.min(window.innerHeight * 0.9, px));
    state.dockHeight = h;
    document.documentElement.style.setProperty("--n3xn-dt-height", h + "px");
    if (root) root.style.height = h + "px";
  }

  function openPanel() {
    state.open = true;
    root.setAttribute("data-open", "");
    document.documentElement.classList.add("n3xn-dt-open");
    setDockHeight(state.dockHeight || DEFAULT_HEIGHT);
    activateTab(currentTab);
    saveState();
  }

  function closePanel() {
    state.open = false;
    root.removeAttribute("data-open");
    document.documentElement.classList.remove("n3xn-dt-open");
    hideHighlight();
    if (editor) {
      try { editor.dispose(); } catch {}
      editor = null;
      editorReady = false;
    }
    saveState();
  }

  function togglePanel() {
    if (state.open) closePanel();
    else openPanel();
  }

  /* ── Resize handle ── */

  function setupResize(handle) {
    let startY = 0;
    let startH = 0;

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      startY = e.clientY;
      startH = state.dockHeight || DEFAULT_HEIGHT;
      handle.setAttribute("data-active", "");
      handle.setPointerCapture(e.pointerId);

      const onMove = (ev) => {
        // Drag top edge: moving up increases height
        const dy = startY - ev.clientY;
        setDockHeight(startH + dy);
        if (editor && editorReady) {
          try { editor.layout(); } catch {}
        }
      };
      const onUp = () => {
        handle.removeAttribute("data-active");
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        saveState();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
  }

  /* ── Capture console ── */

  function captureConsole() {
    const buffer = (window[`${NS}logBuffer`] = []);
    for (const level of ["log", "info", "warn", "error", "debug"]) {
      originalConsole[level] = console[level];
      console[level] = function (...args) {
        buffer.push({ level, args, time: Date.now() });
        if (buffer.length > 300) buffer.shift();
        return originalConsole[level].apply(console, args);
      };
    }
  }

  /* ── Build UI ── */

  function build() {
    if (document.getElementById(`${NS}root`)) return;

    loadCSS();
    installNetworkIntercept();
    installStorageHooks();
    captureConsole();

    // CSS variable for page push
    document.documentElement.style.setProperty(
      "--n3xn-dt-height",
      (state.dockHeight || DEFAULT_HEIGHT) + "px",
    );

    root = el("div", { id: `${NS}root`, className: `${NS}root` });

    launcher = el("button", {
      className: `${NS}launcher`,
      title: "Open n3xn DevTools (F12)",
      type: "button",
    }, "⚙");

    panel = el("section", { className: `${NS}panel` });

    const resizeHandle = el("div", { className: `${NS}resize-handle` });
    panel.appendChild(resizeHandle);
    setupResize(resizeHandle);

    const titlebar = el("div", { className: `${NS}titlebar` });

    const tabbar = el("div", { className: `${NS}tabs` });
    const tabNames = ["Elements", "Console", "Sources", "Network", "Application", "Settings"];
    for (const tabName of tabNames) {
      const button = el("button", { className: `${NS}tab`, type: "button" }, tabName);
      button.dataset.tab = tabName;
      button.onclick = () => {
        currentTab = tabName;
        for (const item of tabbar.querySelectorAll(`.${NS}tab`)) {
          item.classList.toggle(`${NS}active`, item.dataset.tab === tabName);
        }
        activateTab(tabName);
      };
      tabbar.appendChild(button);
    }

    const actions = el("div", { className: `${NS}title-actions` });
    const cloakBtn = el("button", {
      className: `${NS}title-button`,
      type: "button",
      title: "Open blob cloaked",
    }, "⧉");
    const close = el("button", {
      className: `${NS}title-button`,
      type: "button",
      title: "Close DevTools",
    }, "×");
    actions.append(cloakBtn, close);
    titlebar.append(tabbar, actions);

    content = el("div", { className: `${NS}content` });
    main = el("div", { className: `${NS}main` });
    detail = el("div", { className: `${NS}detail` });
    content.append(main, detail);
    panel.append(titlebar, content);
    root.append(launcher, panel);
    document.documentElement.appendChild(root);

    launcher.addEventListener("click", openPanel);
    close.addEventListener("click", closePanel);
    cloakBtn.addEventListener("click", openBlobCloak);

    for (const item of tabbar.querySelectorAll(`.${NS}tab`)) {
      item.classList.toggle(`${NS}active`, item.dataset.tab === "Elements");
    }

    if (!state.enabled) root.style.display = "none";

    // Restore open state
    if (state.open) openPanel();

    window.addEventListener("keydown", (e) => {
      if (e.key === "F12" || (e.ctrlKey && e.shiftKey && (e.key === "I" || e.key === "i"))) {
        e.preventDefault();
        togglePanel();
      }
      if (e.key === "Escape" && state.open) closePanel();
    });
  }

  /* ── Start ── */

  async function start() {
    await loadState();
    applyIdentity();
    for (const s of state.scripts || []) {
      try {
        if (s.type === "url") addScript(s.value);
        else if (s.type === "code") (0, eval)(s.value);
      } catch {}
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", build, { once: true });
    } else {
      build();
    }
  }

  start();
})();
