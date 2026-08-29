(() => {
  "use strict";

  /*
   * n3xn DevTools — improved
   *
   * Client-side development overlay with:
   * - Interactive DOM tree + element picker/highlight
   * - Console with history + page log capture
   * - Live network (fetch + XHR intercept)
   * - Storage inspector
   * - Resizable / dockable panel
   * - Keyboard shortcuts
   *
   * Randomized internal identifiers to avoid collisions
   * with the proxied document.
   */

  const UUID = crypto.randomUUID().replaceAll("-", "");
  const NS = `__n3xn_${UUID}_`;

  const DB_NAME = `${NS}db`;
  const DB_STORE = `${NS}state`;

  const RAW_BASE =
    "https://raw.githubusercontent.com/kbsigmaboy67AtSchool/git/main/public/";

  const CSS_URL = `${RAW_BASE}devtools.css`;

  const MONACO_LOADER =
    "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs/loader.min.js";

  const state = {
    enabled: true,
    titleOverride: null,
    faviconOverride: null,
    cloakTitle: null,
    cloakFavicon: null,
    scripts: [],
    devAuthenticated: false,
    dock: "float", // float | bottom | right
    panelW: null,
    panelH: null,
    panelX: null,
    panelY: null,
  };

  let root = null;
  let launcher = null;
  let panel = null;
  let main = null;
  let sidebar = null;
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

  /* ────────────────────────────────────────────
   * INDEXEDDB
   * ──────────────────────────────────────────── */

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
    } catch {
      /* no persistence */
    }
  }

  async function saveState() {
    try {
      const db = await openDB();
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(structuredClone(state), "state");
    } catch {
      /* non-fatal */
    }
  }

  /* ────────────────────────────────────────────
   * CSS
   * ──────────────────────────────────────────── */

  function loadCSS() {
    if (document.getElementById(`${NS}css`)) return;
    const link = document.createElement("link");
    link.id = `${NS}css`;
    link.rel = "stylesheet";
    link.href = CSS_URL;
    document.head.appendChild(link);
  }

  /* ────────────────────────────────────────────
   * HELPERS
   * ──────────────────────────────────────────── */

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

  /* ────────────────────────────────────────────
   * AUTH
   * ──────────────────────────────────────────── */

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
    } catch {
      /* network */
    }
    window.alert("DevTools authentication failed.");
    return false;
  }

  /* ────────────────────────────────────────────
   * MONACO
   * ──────────────────────────────────────────── */

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
    try {
      const monaco = await loadMonaco();
      editor = monaco.editor.create(host, {
        value,
        language,
        theme: "vs-dark",
        automaticLayout: true,
        minimap: { enabled: true },
        fontSize: 13,
        lineNumbers: "on",
        roundedSelection: false,
        scrollBeyondLastLine: false,
        wordWrap: "off",
        padding: { top: 8 },
      });
      editorReady = true;
      return editor;
    } catch {
      editorReady = false;
      const fallback = el("textarea", { className: `${NS}fallback-editor` });
      fallback.value = value;
      main.appendChild(fallback);
      return fallback;
    }
  }

  /* ────────────────────────────────────────────
   * HIGHLIGHT
   * ──────────────────────────────────────────── */

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
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
  }

  function hideHighlight() {
    if (highlightEl) highlightEl.style.display = "none";
  }

  /* ────────────────────────────────────────────
   * ELEMENTS (DOM tree)
   * ──────────────────────────────────────────── */

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

    const row = el("div", {
      className: `${NS}tree-node`,
      dataset: { depth: String(depth) },
    });
    row._dom = domNode;

    const toggle = el("span", { className: `${NS}tree-toggle` }, " ");
    const label = el("span");

    if (info.kind === "element") {
      const kids = Array.from(domNode.childNodes).filter((n) => nodeLabel(n));
      if (kids.length) {
        toggle.textContent = "▸";
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
      updateElementSidebar(domNode);
      if (domNode.nodeType === 1) {
        showHighlight(domNode);
        try {
          domNode.scrollIntoView({ block: "nearest", behavior: "smooth" });
        } catch {}
      }
    });

    const wrap = document.createDocumentFragment();
    wrap.appendChild(row);

    if (info.kind === "element") {
      const kids = Array.from(domNode.childNodes).filter((n) => nodeLabel(n));
      if (kids.length) {
        const children = el("div", { className: `${NS}tree-children` });
        children.style.display = depth < 2 ? "block" : "none";
        if (depth < 2) toggle.textContent = "▾";
        for (const child of kids) {
          const built = buildTreeNode(child, depth + 1);
          if (built) children.appendChild(built);
        }
        wrap.appendChild(children);
      }
    }

    return wrap;
  }

  function updateElementSidebar(domNode) {
    clear(sidebar);
    if (!domNode || domNode.nodeType !== 1) {
      sidebar.appendChild(el("div", { className: `${NS}side-heading` }, "Element"));
      sidebar.appendChild(el("div", { className: `${NS}side-text` }, "Select a node in the tree."));
      return;
    }

    sidebar.appendChild(el("div", { className: `${NS}side-heading` }, `<${domNode.tagName.toLowerCase()}>`));

    const rect = domNode.getBoundingClientRect();
    sidebar.appendChild(
      el(
        "div",
        { className: `${NS}side-text` },
        `${Math.round(rect.width)}×${Math.round(rect.height)} · ${domNode.childNodes.length} children`
      )
    );

    sidebar.appendChild(el("div", { className: `${NS}side-heading` }, "Attributes"));
    if (domNode.attributes.length === 0) {
      sidebar.appendChild(el("div", { className: `${NS}side-text` }, "(none)"));
    } else {
      for (const attr of domNode.attributes) {
        const row = el("div", { className: `${NS}side-text` });
        row.innerHTML = `<strong style="color:#9cdcfe">${escapeHTML(attr.name)}</strong> = "${escapeHTML(attr.value.slice(0, 60))}"`;
        sidebar.appendChild(row);
      }
    }

    const styles = getComputedStyle(domNode);
    sidebar.appendChild(el("div", { className: `${NS}side-heading` }, "Key styles"));
    for (const prop of ["display", "position", "width", "height", "color", "background-color", "font-size", "margin", "padding"]) {
      const row = el("div", { className: `${NS}side-text` });
      row.textContent = `${prop}: ${styles.getPropertyValue(prop)}`;
      sidebar.appendChild(row);
    }

    const delBtn = el("button", { className: `${NS}action`, dataset: { danger: "1" } }, "Remove element");
    delBtn.onclick = async () => {
      if (!(await authenticate())) return;
      domNode.remove();
      hideHighlight();
      showElements();
    };
    sidebar.appendChild(delBtn);
  }

  function showElements() {
    currentTab = "Elements";
    clear(main);
    clear(sidebar);
    content.removeAttribute("data-no-sidebar");

    const toolbar = el("div", { className: `${NS}console-toolbar` });
    const search = el("input", {
      className: `${NS}search`,
      placeholder: "Filter nodes (tag, id, class)…",
      style: { margin: "0", flex: "1" },
    });
    const refresh = el("button", { className: `${NS}action`, style: { margin: "0" } }, "Refresh");
    toolbar.append(search, refresh);
    main.appendChild(toolbar);

    const tree = el("div", { className: `${NS}tree` });
    main.appendChild(tree);

    const render = (filter = "") => {
      clear(tree);
      const rootNode = document.documentElement;
      const built = buildTreeNode(rootNode, 0);
      if (built) tree.appendChild(built);

      if (filter) {
        const q = filter.toLowerCase();
        tree.querySelectorAll(`.${NS}tree-node`).forEach((row) => {
          const text = row.textContent.toLowerCase();
          row.style.display = text.includes(q) ? "" : "none";
        });
      }
    };

    render();
    search.addEventListener("input", () => render(search.value.trim()));
    refresh.onclick = () => render(search.value.trim());

    sidebar.appendChild(el("div", { className: `${NS}side-heading` }, "DOM Inspector"));
    sidebar.appendChild(
      el("div", { className: `${NS}side-text` }, "Hover to highlight · Click to inspect · Expand nodes with ▸")
    );
  }

  /* ────────────────────────────────────────────
   * CONSOLE
   * ──────────────────────────────────────────── */

  function showConsole() {
    currentTab = "Console";
    clear(main);
    clear(sidebar);
    content.removeAttribute("data-no-sidebar");

    const toolbar = el("div", { className: `${NS}console-toolbar` });
    const clearBtn = el("button", { className: `${NS}action`, style: { margin: "0" } }, "Clear");
    toolbar.appendChild(clearBtn);
    main.appendChild(toolbar);

    const output = el("div", { className: `${NS}console-output` });
    main.appendChild(output);

    const inputWrap = el("div", { className: `${NS}console-input-wrap` });
    const prompt = el("span", { className: `${NS}console-prompt` }, "›");
    const input = el("textarea", {
      className: `${NS}console-input`,
      placeholder: "Enter JS · Enter to run · Shift+Enter newline · ↑/↓ history",
      rows: 1,
    });
    inputWrap.append(prompt, input);
    main.appendChild(inputWrap);

    const write = (value, type = "result") => {
      const row = el("div", { className: `${NS}console-row ${NS}${type}` });
      if (typeof value === "string") {
        row.textContent = value;
      } else {
        try {
          row.textContent = JSON.stringify(value, null, 2);
        } catch {
          row.textContent = String(value);
        }
      }
      output.appendChild(row);
      output.scrollTop = output.scrollHeight;
    };

    clearBtn.onclick = () => clear(output);

    // Replay any buffered page logs if we captured them
    if (window[`${NS}logBuffer`]) {
      for (const entry of window[`${NS}logBuffer`]) {
        write(entry.args.map(String).join(" "), entry.level);
      }
    }

    input.addEventListener("keydown", async (event) => {
      if (event.key === "ArrowUp" && !event.shiftKey) {
        event.preventDefault();
        if (consoleHistory.length === 0) return;
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

    sidebar.appendChild(el("div", { className: `${NS}side-heading` }, "Console"));
    sidebar.appendChild(
      el("div", { className: `${NS}side-text` }, "JavaScript runs in the page context. Password required.")
    );
  }

  /* ────────────────────────────────────────────
   * SOURCES
   * ──────────────────────────────────────────── */

  async function showSources() {
    currentTab = "Sources";
    clear(main);
    clear(sidebar);
    content.removeAttribute("data-no-sidebar");

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

    sidebar.appendChild(el("div", { className: `${NS}side-heading` }, "Sources"));
    sidebar.appendChild(
      el("div", { className: `${NS}side-text` }, "Edit the live HTML. Applying requires DevTools password.")
    );
    sidebar.appendChild(apply);
  }

  /* ────────────────────────────────────────────
   * NETWORK
   * ──────────────────────────────────────────── */

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
        url,
        status: 0,
        type: "fetch",
        size: 0,
        time: 0,
        ok: false,
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
        method: meta.method,
        url: meta.url,
        status: 0,
        type: "xhr",
        size: 0,
        time: 0,
        ok: false,
      };
      networkLog.unshift(entry);
      if (networkLog.length > 200) networkLog.length = 200;

      this.addEventListener("loadend", () => {
        entry.status = this.status;
        entry.ok = this.status >= 200 && this.status < 400;
        entry.time = Math.round(performance.now() - meta.start);
        try {
          entry.size = (this.responseText && this.responseText.length) || 0;
        } catch {}
        if (currentTab === "Network") renderNetworkList();
      });

      return originalXHRSend.apply(this, args);
    };
  }

  let netListEl = null;
  let netFilter = "";

  function renderNetworkList() {
    if (!netListEl) return;
    clear(netListEl);

    const filtered = networkLog.filter((e) => {
      if (!netFilter) return true;
      const q = netFilter.toLowerCase();
      return (
        e.url.toLowerCase().includes(q) ||
        e.method.toLowerCase().includes(q) ||
        String(e.status).includes(q)
      );
    });

    if (!filtered.length) {
      netListEl.appendChild(el("div", { className: `${NS}empty` }, "No requests yet. Interact with the page."));
      return;
    }

    for (const entry of filtered) {
      const row = el("div", { className: `${NS}network-row` });
      const method = el("div", {
        className: `${NS}network-method`,
        dataset: { m: entry.method },
      }, entry.method);
      const name = el("div", { className: `${NS}network-name`, title: entry.url }, shortUrl(entry.url));
      const status = el("div", {
        className: `${NS}network-status`,
        dataset: { ok: entry.ok ? "1" : "0" },
      }, entry.status || "…");
      const size = el("div", { className: `${NS}network-meta` }, formatBytes(entry.size));
      const time = el("div", { className: `${NS}network-meta` }, entry.time ? entry.time + " ms" : "…");
      row.append(method, name, status, size, time);
      netListEl.appendChild(row);
    }
  }

  function showNetwork() {
    currentTab = "Network";
    clear(main);
    clear(sidebar);
    content.removeAttribute("data-no-sidebar");

    installNetworkIntercept();

    // Also seed with performance resource timings
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        if (networkLog.some((e) => e.url === entry.name)) continue;
        networkLog.push({
          id: crypto.randomUUID(),
          method: "GET",
          url: entry.name,
          status: 200,
          type: entry.initiatorType || "resource",
          size: entry.transferSize || 0,
          time: Math.round(entry.duration),
          ok: true,
        });
      }
    } catch {}

    const toolbar = el("div", { className: `${NS}net-toolbar` });
    const search = el("input", {
      className: `${NS}search`,
      placeholder: "Filter requests…",
      style: { margin: "0", flex: "1", maxWidth: "280px" },
    });
    const clearBtn = el("button", { className: `${NS}action`, style: { margin: "0" } }, "Clear");
    toolbar.append(search, clearBtn);
    main.appendChild(toolbar);

    netListEl = el("div", { className: `${NS}net-list` });
    main.appendChild(netListEl);

    search.addEventListener("input", () => {
      netFilter = search.value.trim();
      renderNetworkList();
    });
    clearBtn.onclick = () => {
      networkLog = [];
      renderNetworkList();
    };

    renderNetworkList();

    sidebar.appendChild(el("div", { className: `${NS}side-heading` }, "Network"));
    sidebar.appendChild(
      el("div", { className: `${NS}side-text` }, `${networkLog.length} requests · Live fetch + XHR intercept active`)
    );
  }

  /* ────────────────────────────────────────────
   * APPLICATION / STORAGE
   * ──────────────────────────────────────────── */

  function showApplication() {
    currentTab = "Application";
    clear(main);
    clear(sidebar);
    content.removeAttribute("data-no-sidebar");

    const toolbar = el("div", { className: `${NS}net-toolbar` });
    const select = el("select", { className: `${NS}select`, style: { margin: "0", width: "auto", minWidth: "140px" } });
    for (const opt of ["localStorage", "sessionStorage", "cookies"]) {
      select.appendChild(el("option", { value: opt }, opt));
    }
    const clearBtn = el("button", { className: `${NS}action`, style: { margin: "0" }, dataset: { danger: "1" } }, "Clear all");
    toolbar.append(select, clearBtn);
    main.appendChild(toolbar);

    const list = el("div", { className: `${NS}storage-list` });
    main.appendChild(list);

    const render = () => {
      clear(list);
      const kind = select.value;

      if (kind === "cookies") {
        const cookies = document.cookie ? document.cookie.split("; ") : [];
        if (!cookies.length) {
          list.appendChild(el("div", { className: `${NS}empty` }, "No cookies."));
          return;
        }
        for (const c of cookies) {
          const [k, ...rest] = c.split("=");
          const row = el("div", { className: `${NS}storage-row` });
          row.append(
            el("div", { className: `${NS}storage-key` }, k),
            el("div", { className: `${NS}storage-val` }, rest.join("=").slice(0, 120)),
            el("div", {}, "")
          );
          list.appendChild(row);
        }
        return;
      }

      const store = kind === "localStorage" ? localStorage : sessionStorage;
      const keys = Object.keys(store);
      if (!keys.length) {
        list.appendChild(el("div", { className: `${NS}empty` }, `No ${kind} entries.`));
        return;
      }
      for (const key of keys) {
        const row = el("div", { className: `${NS}storage-row` });
        const del = el("button", { className: `${NS}action`, style: { margin: "0", padding: "2px 8px" } }, "×");
        del.onclick = async () => {
          if (!(await authenticate())) return;
          store.removeItem(key);
          render();
        };
        row.append(
          el("div", { className: `${NS}storage-key`, title: key }, key),
          el("div", { className: `${NS}storage-val`, title: store.getItem(key) }, (store.getItem(key) || "").slice(0, 120)),
          del
        );
        list.appendChild(row);
      }
    };

    select.onchange = render;
    clearBtn.onclick = async () => {
      if (!(await authenticate())) return;
      const kind = select.value;
      if (kind === "localStorage") localStorage.clear();
      else if (kind === "sessionStorage") sessionStorage.clear();
      else {
        for (const c of document.cookie.split("; ")) {
          const name = c.split("=")[0];
          document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
        }
      }
      render();
    };

    render();

    sidebar.appendChild(el("div", { className: `${NS}side-heading` }, "Application"));
    sidebar.appendChild(
      el("div", { className: `${NS}side-text` }, "Inspect and clear storage. Destructive actions need the password.")
    );
    sidebar.appendChild(
      el("div", { className: `${NS}side-text` }, `DevTools DB: ${DB_NAME}`)
    );
  }

  /* ────────────────────────────────────────────
   * SETTINGS
   * ──────────────────────────────────────────── */

  function showSettings() {
    currentTab = "Settings";
    clear(main);
    clear(sidebar);
    content.setAttribute("data-no-sidebar", "");

    const container = el("div", { className: `${NS}settings` });

    const dockLabel = el("label", { className: `${NS}label` }, "Dock position");
    const dock = el("select", { className: `${NS}select` });
    for (const [v, t] of [["float", "Floating"], ["bottom", "Bottom"], ["right", "Right"]]) {
      const o = el("option", { value: v }, t);
      if (state.dock === v) o.selected = true;
      dock.appendChild(o);
    }

    const titleLabel = el("label", { className: `${NS}label` }, "Title override");
    const title = el("input", {
      className: `${NS}input`,
      value: state.titleOverride || "",
      placeholder: "Custom document title",
    });

    const faviconLabel = el("label", { className: `${NS}label` }, "Favicon URL");
    const favicon = el("input", {
      className: `${NS}input`,
      value: state.faviconOverride || "",
      placeholder: "https://example.com/favicon.ico",
    });

    const scriptLabel = el("label", { className: `${NS}label` }, "Auto script (URL or JS)");
    const script = el("textarea", {
      className: `${NS}textarea`,
      placeholder: "https://example.com/script.js\n\nor\n\nconsole.log('hello')",
    });

    const save = el("button", { className: `${NS}action`, dataset: { primary: "1" } }, "Save");
    save.onclick = async () => {
      state.dock = dock.value;
      state.titleOverride = title.value.trim() || null;
      state.faviconOverride = favicon.value.trim() || null;
      if (script.value.trim()) {
        addScript(script.value);
        script.value = "";
      }
      applyIdentity();
      applyDock();
      await saveState();
      save.textContent = "Saved ✓";
      setTimeout(() => (save.textContent = "Save"), 1200);
    };

    const cloakBtn = el("button", { className: `${NS}action` }, "Open about:blank cloak");
    cloakBtn.onclick = openCloak;

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

    const shortcutNote = el(
      "div",
      { className: `${NS}side-text`, style: { marginTop: "16px" } },
      "Shortcuts: F12 or Ctrl+Shift+I to toggle · Esc to close panel"
    );

    container.append(
      dockLabel, dock,
      titleLabel, title,
      faviconLabel, favicon,
      scriptLabel, script,
      save, cloakBtn, enabledLabel, shortcutNote
    );
    main.appendChild(container);
  }

  function addScript(source) {
    source = source.trim();
    if (!source) return;
    if (/^https?:\/\//i.test(source)) {
      const script = document.createElement("script");
      script.src = source;
      script.async = false;
      document.head.appendChild(script);
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

  /* ────────────────────────────────────────────
   * IDENTITY + CLOAK
   * ──────────────────────────────────────────── */

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

  function openCloak() {
    const popup = window.open("about:blank", "_blank");
    if (!popup) {
      window.alert("The browser blocked the popup.");
      return;
    }
    const title = state.cloakTitle || state.titleOverride || document.title;
    const favicon = state.cloakFavicon || state.faviconOverride || "";
    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHTML(title)}</title>
${favicon ? `<link rel="icon" href="${escapeHTML(favicon)}">` : ""}
</head>
<body style="margin:0;overflow:hidden;background:#000">
<iframe
  src="${escapeHTML(location.href)}"
  style="position:fixed;inset:0;width:100%;height:100%;border:0"
  allow="
    accelerometer; autoplay; camera; clipboard-read; clipboard-write;
    encrypted-media; fullscreen; geolocation; gyroscope;
    microphone; midi; payment; picture-in-picture;
    screen-wake-lock; web-share; xr-spatial-tracking
  "
  allowfullscreen
></iframe>
</body>
</html>`;
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
  }

  /* ────────────────────────────────────────────
   * TAB ROUTER
   * ──────────────────────────────────────────── */

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

  /* ────────────────────────────────────────────
   * PANEL OPEN / CLOSE / DOCK
   * ──────────────────────────────────────────── */

  function openPanel() {
    panel.classList.add(`${NS}open`);
    launcher.classList.add(`${NS}hidden`);
    activateTab(currentTab);
  }

  function closePanel() {
    panel.classList.remove(`${NS}open`);
    launcher.classList.remove(`${NS}hidden`);
    hideHighlight();
    if (editor) {
      try { editor.dispose(); } catch {}
      editor = null;
      editorReady = false;
    }
  }

  function togglePanel() {
    if (panel.classList.contains(`${NS}open`)) closePanel();
    else openPanel();
  }

  function applyDock() {
    panel.dataset.dock = state.dock === "float" ? "" : state.dock;
    if (state.dock === "float") {
      if (state.panelW) panel.style.width = state.panelW + "px";
      if (state.panelH) panel.style.height = state.panelH + "px";
      if (state.panelX != null) {
        panel.style.left = state.panelX + "px";
        panel.style.right = "auto";
      }
      if (state.panelY != null) {
        panel.style.top = state.panelY + "px";
        panel.style.bottom = "auto";
      }
    } else {
      panel.style.width = "";
      panel.style.height = "";
      panel.style.left = "";
      panel.style.top = "";
      panel.style.right = "";
      panel.style.bottom = "";
    }
  }

  /* ────────────────────────────────────────────
   * DRAGGING + RESIZE
   * ──────────────────────────────────────────── */

  function makeDraggable(node, onEnd) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    node.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest("button, input, select, textarea, a")) return;
      dragging = true;
      const rect = node.getBoundingClientRect();
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      node.setPointerCapture(event.pointerId);
      node.classList.add(`${NS}dragging`);
    });

    node.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const width = node.offsetWidth;
      const height = node.offsetHeight;
      const x = Math.max(4, Math.min(window.innerWidth - width - 4, event.clientX - offsetX));
      const y = Math.max(4, Math.min(window.innerHeight - height - 4, event.clientY - offsetY));
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
      node.style.right = "auto";
      node.style.bottom = "auto";
    });

    node.addEventListener("pointerup", (event) => {
      if (!dragging) return;
      dragging = false;
      node.classList.remove(`${NS}dragging`);
      try { node.releasePointerCapture(event.pointerId); } catch {}
      if (onEnd) onEnd();
    });
  }

  function makeResizable(panelEl) {
    const handles = [
      { cls: `${NS}resize-n`, edges: ["top"] },
      { cls: `${NS}resize-w`, edges: ["left"] },
      { cls: `${NS}resize-nw`, edges: ["top", "left"] },
    ];

    for (const h of handles) {
      const handle = el("div", { className: `${NS}resize ${h.cls}` });
      panelEl.appendChild(handle);

      let startX, startY, startW, startH, startL, startT;

      handle.addEventListener("pointerdown", (e) => {
        if (state.dock !== "float") return;
        e.preventDefault();
        e.stopPropagation();
        startX = e.clientX;
        startY = e.clientY;
        const r = panelEl.getBoundingClientRect();
        startW = r.width;
        startH = r.height;
        startL = r.left;
        startT = r.top;
        handle.setPointerCapture(e.pointerId);

        const onMove = (ev) => {
          let w = startW;
          let h = startH;
          let l = startL;
          let t = startT;
          if (h.edges.includes("left")) {
            const dx = ev.clientX - startX;
            w = Math.max(420, startW - dx);
            l = startL + (startW - w);
          }
          if (h.edges.includes("top")) {
            const dy = ev.clientY - startY;
            h = Math.max(280, startH - dy);
            t = startT + (startH - h);
          }
          panelEl.style.width = w + "px";
          panelEl.style.height = h + "px";
          panelEl.style.left = l + "px";
          panelEl.style.top = t + "px";
          panelEl.style.right = "auto";
          panelEl.style.bottom = "auto";
        };

        const onUp = () => {
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          state.panelW = panelEl.offsetWidth;
          state.panelH = panelEl.offsetHeight;
          state.panelX = parseInt(panelEl.style.left, 10) || null;
          state.panelY = parseInt(panelEl.style.top, 10) || null;
          saveState();
        };

        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
      });
    }
  }

  /* ────────────────────────────────────────────
   * BUILD UI
   * ──────────────────────────────────────────── */

  function build() {
    if (document.getElementById(`${NS}root`)) return;

    loadCSS();
    installNetworkIntercept();
    captureConsole();

    root = el("div", { id: `${NS}root`, className: `${NS}root` });

    launcher = el("button", {
      className: `${NS}launcher`,
      title: "Open n3xn DevTools (F12)",
      type: "button",
    }, "⚙");

    panel = el("section", { className: `${NS}panel` });

    const titlebar = el("div", { className: `${NS}titlebar` });
    const title = el("span", { className: `${NS}title` });
    title.innerHTML = `<span>n3xn</span> DevTools`;
    const dockBtn = el("button", {
      className: `${NS}title-button`,
      type: "button",
      title: "Cycle dock (float → bottom → right)",
    }, "⧉");
    const minimize = el("button", {
      className: `${NS}title-button`,
      type: "button",
      title: "Hide",
    }, "—");
    const close = el("button", {
      className: `${NS}title-button`,
      type: "button",
      title: "Close",
      dataset: { danger: "1" },
    }, "×");
    titlebar.append(title, dockBtn, minimize, close);

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

    content = el("div", { className: `${NS}content` });
    main = el("div", { className: `${NS}main` });
    sidebar = el("aside", { className: `${NS}sidebar` });
    content.append(main, sidebar);
    panel.append(titlebar, tabbar, content);
    root.append(launcher, panel);
    document.documentElement.appendChild(root);

    launcher.addEventListener("click", () => {
      if (launcher.classList.contains(`${NS}dragging`)) return;
      openPanel();
    });
    close.addEventListener("click", closePanel);
    minimize.addEventListener("click", closePanel);

    dockBtn.onclick = () => {
      const order = ["float", "bottom", "right"];
      const i = order.indexOf(state.dock);
      state.dock = order[(i + 1) % order.length];
      applyDock();
      saveState();
    };

    makeDraggable(launcher);
    makeDraggable(titlebar, () => {
      if (state.dock !== "float") return;
      state.panelX = parseInt(panel.style.left, 10) || null;
      state.panelY = parseInt(panel.style.top, 10) || null;
      saveState();
    });
    // Make the whole panel follow titlebar drag when floating
    titlebar.addEventListener("pointerdown", (e) => {
      if (state.dock !== "float") return;
      if (e.target.closest("button")) return;
      // reuse makeDraggable on panel via titlebar offsets
    });

    // Better: drag panel by titlebar
    (function enablePanelDrag() {
      let dragging = false, ox = 0, oy = 0;
      titlebar.addEventListener("pointerdown", (e) => {
        if (state.dock !== "float") return;
        if (e.target.closest("button")) return;
        dragging = true;
        const r = panel.getBoundingClientRect();
        ox = e.clientX - r.left;
        oy = e.clientY - r.top;
        titlebar.setPointerCapture(e.pointerId);
      });
      titlebar.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const x = Math.max(0, Math.min(window.innerWidth - 100, e.clientX - ox));
        const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - oy));
        panel.style.left = x + "px";
        panel.style.top = y + "px";
        panel.style.right = "auto";
        panel.style.bottom = "auto";
      });
      titlebar.addEventListener("pointerup", () => {
        if (!dragging) return;
        dragging = false;
        state.panelX = parseInt(panel.style.left, 10) || null;
        state.panelY = parseInt(panel.style.top, 10) || null;
        saveState();
      });
    })();

    makeResizable(panel);

    for (const item of tabbar.querySelectorAll(`.${NS}tab`)) {
      item.classList.toggle(`${NS}active`, item.dataset.tab === "Elements");
    }

    applyDock();

    if (!state.enabled) root.style.display = "none";

    // Keyboard
    window.addEventListener("keydown", (e) => {
      if (e.key === "F12" || (e.ctrlKey && e.shiftKey && (e.key === "I" || e.key === "i"))) {
        e.preventDefault();
        togglePanel();
      }
      if (e.key === "Escape" && panel.classList.contains(`${NS}open`)) {
        closePanel();
      }
    });
  }

  /* ────────────────────────────────────────────
   * CAPTURE PAGE CONSOLE
   * ──────────────────────────────────────────── */

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

  /* ────────────────────────────────────────────
   * START
   * ──────────────────────────────────────────── */

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
