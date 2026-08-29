(() => {
  "use strict";

  /*
   * n3xn DevTools
   *
   * Client-side development overlay.
   * The script intentionally uses randomized internal identifiers
   * so it is unlikely to collide with the proxied document.
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
  };

  let root = null;
  let launcher = null;
  let panel = null;
  let main = null;
  let sidebar = null;
  let editor = null;
  let editorReady = false;
  let currentTab = "Elements";

  /*
   * ------------------------------------------------------------
   * INDEXEDDB
   * ------------------------------------------------------------
   */

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

      if (value) {
        Object.assign(state, value);
      }
    } catch {
      // IndexedDB unavailable; continue without persistence.
    }
  }

  async function saveState() {
    try {
      const db = await openDB();

      const tx = db.transaction(DB_STORE, "readwrite");

      tx.objectStore(DB_STORE).put(
        structuredClone(state),
        "state",
      );
    } catch {
      // Persistence failure is non-fatal.
    }
  }

  /*
   * ------------------------------------------------------------
   * CSS
   * ------------------------------------------------------------
   */

  function loadCSS() {
    if (document.getElementById(`${NS}css`)) {
      return;
    }

    const link = document.createElement("link");

    link.id = `${NS}css`;
    link.rel = "stylesheet";
    link.href = CSS_URL;

    document.head.appendChild(link);
  }

  /*
   * ------------------------------------------------------------
   * HELPERS
   * ------------------------------------------------------------
   */

  function el(tag, props = {}, text = "") {
    const node = document.createElement(tag);

    for (const [key, value] of Object.entries(props)) {
      if (key === "className") {
        node.className = value;
      } else if (key === "dataset") {
        Object.assign(node.dataset, value);
      } else if (key in node) {
        node[key] = value;
      } else {
        node.setAttribute(key, value);
      }
    }

    if (text) {
      node.textContent = text;
    }

    return node;
  }

  function clear(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function escapeHTML(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  /*
   * ------------------------------------------------------------
   * DEVTOOLS AUTH
   * ------------------------------------------------------------
   */

  async function authenticate() {
    if (state.devAuthenticated) {
      return true;
    }

    const password = window.prompt(
      "n3xn DevTools password:",
    );

    if (password === null) {
      return false;
    }

    try {
      const response = await fetch(
        "/devtools-auth",
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            password,
          }),
        },
      );

      const result = await response.json();

      if (response.ok && result.ok) {
        state.devAuthenticated = true;
        await saveState();
        return true;
      }
    } catch {
      // Network failure.
    }

    window.alert(
      "DevTools authentication failed.",
    );

    return false;
  }

  /*
   * ------------------------------------------------------------
   * MONACO
   * ------------------------------------------------------------
   */

  function loadMonaco() {
    return new Promise((resolve, reject) => {
      if (window.monaco) {
        resolve(window.monaco);
        return;
      }

      if (window.require && window.require.config) {
        window.require(
          ["vs/editor/editor.main"],
          monaco => resolve(monaco),
        );

        return;
      }

      const script = document.createElement("script");

      script.src = MONACO_LOADER;
      script.async = true;

      script.onload = () => {
        if (!window.require) {
          reject(
            new Error(
              "Monaco loader did not initialize.",
            ),
          );

          return;
        }

        window.require.config({
          paths: {
            vs:
              "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs",
          },
        });

        window.require(
          ["vs/editor/editor.main"],
          monaco => resolve(monaco),
        );
      };

      script.onerror = () => {
        reject(
          new Error(
            "Unable to load Monaco.",
          ),
        );
      };

      document.head.appendChild(script);
    });
  }

  async function createMonaco(value, language = "html") {
    clear(main);

    const host = el(
      "div",
      {
        className: `${NS}editor`,
      },
    );

    main.appendChild(host);

    try {
      const monaco = await loadMonaco();

      editor = monaco.editor.create(
        host,
        {
          value,
          language,
          theme: "vs-dark",

          automaticLayout: true,

          minimap: {
            enabled: true,
          },

          fontSize: 13,

          lineNumbers: "on",

          roundedSelection: false,

          scrollBeyondLastLine: false,

          wordWrap: "off",

          padding: {
            top: 8,
          },
        },
      );

      editorReady = true;

      return editor;
    } catch (error) {
      editorReady = false;

      const fallback = el(
        "textarea",
        {
          className: `${NS}fallback-editor`,
        },
      );

      fallback.value = value;

      main.appendChild(fallback);

      return fallback;
    }
  }

  /*
   * ------------------------------------------------------------
   * ELEMENTS
   * ------------------------------------------------------------
   */

  async function showElements() {
    currentTab = "Elements";

    clear(main);
    clear(sidebar);

    const source =
      document.documentElement.outerHTML;

    await createMonaco(
      source,
      "html",
    );

    sidebar.appendChild(
      el(
        "div",
        {
          className: `${NS}side-heading`,
        },
        "DOM Inspector",
      ),
    );

    sidebar.appendChild(
      el(
        "div",
        {
          className: `${NS}side-text`,
        },
        `${document.documentElement.children.length} top-level HTML nodes`,
      ),
    );
  }

  /*
   * ------------------------------------------------------------
   * CONSOLE
   * ------------------------------------------------------------
   */

  function showConsole() {
    currentTab = "Console";

    clear(main);
    clear(sidebar);

    const output = el(
      "div",
      {
        className: `${NS}console-output`,
      },
    );

    const input = el(
      "textarea",
      {
        className: `${NS}console-input`,
        placeholder:
          "Enter JavaScript. Press Enter to run; Shift+Enter for newline.",
      },
    );

    main.appendChild(output);
    main.appendChild(input);

    const write = (value, type = "result") => {
      const row = el(
        "div",
        {
          className: `${NS}console-row ${NS}${type}`,
        },
      );

      row.textContent =
        typeof value === "string"
          ? value
          : (() => {
              try {
                return JSON.stringify(
                  value,
                  null,
                  2,
                );
              } catch {
                return String(value);
              }
            })();

      output.appendChild(row);

      output.scrollTop =
        output.scrollHeight;
    };

    input.addEventListener(
      "keydown",
      async event => {
        if (
          event.key !== "Enter" ||
          event.shiftKey
        ) {
          return;
        }

        event.preventDefault();

        const code = input.value.trim();

        if (!code) {
          return;
        }

        input.value = "";

        write(
          `> ${code}`,
          "command",
        );

        if (!(await authenticate())) {
          write(
            "Execution denied.",
            "error",
          );

          return;
        }

        try {
          /*
           * Execute against the page's global
           * environment.
           */
          const result =
            (0, eval)(code);

          write(
            result === undefined
              ? "undefined"
              : result,
          );
        } catch (error) {
          write(
            error?.stack ||
              String(error),
            "error",
          );
        }
      },
    );

    sidebar.appendChild(
      el(
        "div",
        {
          className: `${NS}side-heading`,
        },
        "Console",
      ),
    );

    sidebar.appendChild(
      el(
        "div",
        {
          className: `${NS}side-text`,
        },
        "JavaScript execution requires the DevTools password.",
      ),
    );
  }

  /*
   * ------------------------------------------------------------
   * SOURCES
   * ------------------------------------------------------------
   */

  async function showSources() {
    currentTab = "Sources";

    clear(main);
    clear(sidebar);

    const source =
      document.documentElement.outerHTML;

    const ed = await createMonaco(
      source,
      "html",
    );

    const apply = el(
      "button",
      {
        className: `${NS}action`,
      },
      "Apply changes",
    );

    apply.onclick = async () => {
      if (!(await authenticate())) {
        return;
      }

      const replacement =
        editorReady
          ? editor.getValue()
          : ed.value;

      document.open();
      document.write(replacement);
      document.close();
    };

    sidebar.appendChild(
      el(
        "div",
        {
          className: `${NS}side-heading`,
        },
        "Sources",
      ),
    );

    sidebar.appendChild(
      el(
        "div",
        {
          className: `${NS}side-text`,
        },
        "Edit the current HTML document. Applying changes requires DevTools authentication.",
      ),
    );

    sidebar.appendChild(apply);
  }

  /*
   * ------------------------------------------------------------
   * NETWORK
   * ------------------------------------------------------------
   */

  function showNetwork() {
    currentTab = "Network";

    clear(main);
    clear(sidebar);

    const entries =
      performance.getEntriesByType(
        "resource",
      );

    const fragment =
      document.createDocumentFragment();

    for (const entry of entries) {
      const row = el(
        "div",
        {
          className: `${NS}network-row`,
        },
      );

      const name = el(
        "div",
        {
          className: `${NS}network-name`,
        },
        entry.name,
      );

      const meta = el(
        "div",
        {
          className: `${NS}network-meta`,
        },
        `${Math.round(entry.duration)} ms`,
      );

      row.append(name, meta);

      fragment.appendChild(row);
    }

    if (!entries.length) {
      fragment.appendChild(
        el(
          "div",
          {
            className: `${NS}empty`,
          },
          "No resource entries.",
        ),
      );
    }

    main.appendChild(fragment);

    sidebar.appendChild(
      el(
        "div",
        {
          className: `${NS}side-heading`,
        },
        "Network",
      ),
    );

    sidebar.appendChild(
      el(
        "div",
        {
          className: `${NS}side-text`,
        },
        `${entries.length} resource entries`,
      ),
    );
  }

  /*
   * ------------------------------------------------------------
   * APPLICATION
   * ------------------------------------------------------------
   */

  async function showApplication() {
    currentTab = "Application";

    clear(main);
    clear(sidebar);

    const pre = el(
      "pre",
      {
        className: `${NS}info`,
      },
    );

    pre.textContent = [
      "IndexedDB",
      "",
      `Database: ${DB_NAME}`,
      `Store: ${DB_STORE}`,
      "",
      "Persistent DevTools settings are stored locally.",
      "",
      "Saved scripts:",
      ...state.scripts.map(
        script =>
          `• ${script.type}: ${script.value}`,
      ),
    ].join("\n");

    main.appendChild(pre);

    sidebar.appendChild(
      el(
        "div",
        {
          className: `${NS}side-heading`,
        },
        "Application",
      ),
    );

    sidebar.appendChild(
      el(
        "div",
        {
          className: `${NS}side-text`,
        },
        "Local persistent settings and automatic scripts.",
      ),
    );
  }

  /*
   * ------------------------------------------------------------
   * SCRIPT INJECTOR
   * ------------------------------------------------------------
   */

  function addScript(value) {
    const source = value.trim();

    if (!source) {
      return;
    }

    if (
      /^https?:\/\//i.test(source)
    ) {
      const script =
        document.createElement(
          "script",
        );

      script.src = source;
      script.async = false;

      document.head.appendChild(
        script,
      );

      state.scripts.push({
        type: "url",
        value: source,
      });

      return;
    }

    try {
      (0, eval)(source);

      state.scripts.push({
        type: "code",
        value: source,
      });
    } catch (error) {
      console.error(
        "n3xn DevTools script:",
        error,
      );
    }
  }

  /*
   * ------------------------------------------------------------
   * SETTINGS
   * ------------------------------------------------------------
   */

  function showSettings() {
    currentTab = "Settings";

    clear(main);
    clear(sidebar);

    const container = el(
      "div",
      {
        className: `${NS}settings`,
      },
    );

    const titleLabel = el(
      "label",
      {
        className: `${NS}label`,
      },
      "Title override",
    );

    const title = el(
      "input",
      {
        className: `${NS}input`,
        value:
          state.titleOverride || "",
        placeholder:
          "Custom document title",
      },
    );

    const faviconLabel = el(
      "label",
      {
        className: `${NS}label`,
      },
      "Favicon URL",
    );

    const favicon = el(
      "input",
      {
        className: `${NS}input`,
        value:
          state.faviconOverride || "",
        placeholder:
          "https://example.com/favicon.ico",
      },
    );

    const scriptLabel = el(
      "label",
      {
        className: `${NS}label`,
      },
      "Automatic script URL or JavaScript",
    );

    const script = el(
      "textarea",
      {
        className: `${NS}textarea`,
        placeholder:
          "https://example.com/script.js\n\nor\n\nconsole.log('hello')",
      },
    );

    const save = el(
      "button",
      {
        className: `${NS}action`,
      },
      "Save",
    );

    save.onclick = async () => {
      state.titleOverride =
        title.value.trim() ||
        null;

      state.faviconOverride =
        favicon.value.trim() ||
        null;

      if (script.value.trim()) {
        addScript(script.value);
        script.value = "";
      }

      applyIdentity();

      await saveState();

      save.textContent = "Saved";

      setTimeout(() => {
        save.textContent = "Save";
      }, 1000);
    };

    const enabledLabel = el(
      "label",
      {
        className: `${NS}toggle`,
      },
    );

    const enabled = el(
      "input",
      {
        type: "checkbox",
      },
    );

    enabled.checked =
      state.enabled;

    enabled.addEventListener(
      "change",
      async () => {
        state.enabled =
          enabled.checked;

        await saveState();

        root.style.display =
          state.enabled
            ? ""
            : "none";

        if (!state.enabled) {
          closePanel();
        }
      },
    );

    enabledLabel.append(
      enabled,
      document.createTextNode(
        " Enable n3xn DevTools",
      ),
    );

    container.append(
      titleLabel,
      title,
      faviconLabel,
      favicon,
      scriptLabel,
      script,
      save,
      enabledLabel,
    );

    main.appendChild(container);

    sidebar.appendChild(
      el(
        "div",
        {
          className: `${NS}side-heading`,
        },
        "Settings",
      ),
    );
  }

  /*
   * ------------------------------------------------------------
   * IDENTITY
   * ------------------------------------------------------------
   */

  function applyIdentity() {
    if (
      state.titleOverride !== null
    ) {
      document.title =
        state.titleOverride;
    }

    if (
      state.faviconOverride !== null
    ) {
      let icon =
        document.querySelector(
          'link[rel~="icon"]',
        );

      if (!icon) {
        icon =
          document.createElement(
            "link",
          );

        icon.rel = "icon";

        document.head.appendChild(
          icon,
        );
      }

      icon.href =
        state.faviconOverride;
    }
  }

  /*
   * ------------------------------------------------------------
   * ABOUT:BLANK CLOAK
   * ------------------------------------------------------------
   */

  function openCloak() {
    const popup =
      window.open(
        "about:blank",
        "_blank",
      );

    if (!popup) {
      window.alert(
        "The browser blocked the popup.",
      );

      return;
    }

    const title =
      state.cloakTitle ||
      state.titleOverride ||
      document.title;

    const favicon =
      state.cloakFavicon ||
      state.faviconOverride ||
      "";

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHTML(title)}</title>
${
  favicon
    ? `<link rel="icon" href="${escapeHTML(favicon)}">`
    : ""
}
</head>
<body style="margin:0;overflow:hidden;background:#000">
<iframe
  src="${escapeHTML(location.href)}"
  style="position:fixed;inset:0;width:100%;height:100%;border:0"
  allow="
    accelerometer;
    autoplay;
    camera;
    clipboard-read;
    clipboard-write;
    display-capture;
    encrypted-media;
    fullscreen;
    gamepad;
    geolocation;
    gyroscope;
    microphone;
    midi;
    payment;
    picture-in-picture;
    screen-wake-lock;
    web-share;
    xr-spatial-tracking
  "
  allowfullscreen
></iframe>
</body>
</html>`;

    popup.document.open();
    popup.document.write(html);
    popup.document.close();
  }

  /*
   * ------------------------------------------------------------
   * TAB ROUTER
   * ------------------------------------------------------------
   */

  function activateTab(tab) {
    switch (tab) {
      case "Elements":
        showElements();
        break;

      case "Console":
        showConsole();
        break;

      case "Sources":
        showSources();
        break;

      case "Network":
        showNetwork();
        break;

      case "Application":
        showApplication();
        break;

      case "Settings":
        showSettings();
        break;

      default:
        showElements();
    }
  }

  /*
   * ------------------------------------------------------------
   * PANEL
   * ------------------------------------------------------------
   */

  function openPanel() {
    panel.classList.add(
      `${NS}open`,
    );

    launcher.classList.add(
      `${NS}hidden`,
    );

    activateTab(currentTab);
  }

  function closePanel() {
    panel.classList.remove(
      `${NS}open`,
    );

    launcher.classList.remove(
      `${NS}hidden`,
    );

    if (editor) {
      try {
        editor.dispose();
      } catch {}

      editor = null;
      editorReady = false;
    }
  }

  /*
   * ------------------------------------------------------------
   * DRAGGING
   * ------------------------------------------------------------
   */

  function makeDraggable(node) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    node.addEventListener(
      "pointerdown",
      event => {
        if (event.button !== 0) {
          return;
        }

        dragging = true;

        const rect =
          node.getBoundingClientRect();

        offsetX =
          event.clientX -
          rect.left;

        offsetY =
          event.clientY -
          rect.top;

        node.setPointerCapture(
          event.pointerId,
        );

        node.classList.add(
          `${NS}dragging`,
        );
      },
    );

    node.addEventListener(
      "pointermove",
      event => {
        if (!dragging) {
          return;
        }

        const width =
          node.offsetWidth;

        const height =
          node.offsetHeight;

        const x = Math.max(
          4,
          Math.min(
            window.innerWidth -
              width -
              4,
            event.clientX -
              offsetX,
          ),
        );

        const y = Math.max(
          4,
          Math.min(
            window.innerHeight -
              height -
              4,
            event.clientY -
              offsetY,
          ),
        );

        node.style.left = `${x}px`;
        node.style.top = `${y}px`;
        node.style.right = "auto";
        node.style.bottom = "auto";
      },
    );

    node.addEventListener(
      "pointerup",
      event => {
        dragging = false;

        node.classList.remove(
          `${NS}dragging`,
        );

        try {
          node.releasePointerCapture(
            event.pointerId,
          );
        } catch {}
      },
    );
  }

  /*
   * ------------------------------------------------------------
   * BUILD UI
   * ------------------------------------------------------------
   */

  function build() {
    if (
      document.getElementById(
        `${NS}root`,
      )
    ) {
      return;
    }

    loadCSS();

    root = el(
      "div",
      {
        id: `${NS}root`,
        className: `${NS}root`,
      },
    );

    /*
     * Launcher
     */

    launcher = el(
      "button",
      {
        className: `${NS}launcher`,
        title: "Open n3xn DevTools",
        type: "button",
      },
      "⚙",
    );

    /*
     * Panel
     */

    panel = el(
      "section",
      {
        className: `${NS}panel`,
      },
    );

    const titlebar = el(
      "div",
      {
        className: `${NS}titlebar`,
      },
    );

    const title = el(
      "span",
      {
        className: `${NS}title`,
      },
      "n3xn DevTools",
    );

    const minimize = el(
      "button",
      {
        className: `${NS}title-button`,
        type: "button",
        title: "Hide DevTools",
      },
      "—",
    );

    const close = el(
      "button",
      {
        className: `${NS}title-button`,
        type: "button",
        title: "Close DevTools",
      },
      "×",
    );

    titlebar.append(
      title,
      minimize,
      close,
    );

    const tabbar = el(
      "div",
      {
        className: `${NS}tabs`,
      },
    );

    const tabNames = [
      "Elements",
      "Console",
      "Sources",
      "Network",
      "Application",
      "Settings",
    ];

    for (const tabName of tabNames) {
      const button = el(
        "button",
        {
          className: `${NS}tab`,
          type: "button",
        },
        tabName,
      );

      button.dataset.tab =
        tabName;

      button.onclick = () => {
        currentTab =
          tabName;

        for (
          const item of
            tabbar.querySelectorAll(
              `.${NS}tab`,
            )
        ) {
          item.classList.toggle(
            `${NS}active`,
            item.dataset.tab ===
              tabName,
          );
        }

        activateTab(tabName);
      };

      tabbar.appendChild(
        button,
      );
    }

    const content = el(
      "div",
      {
        className: `${NS}content`,
      },
    );

    main = el(
      "div",
      {
        className: `${NS}main`,
      },
    );

    sidebar = el(
      "aside",
      {
        className: `${NS}sidebar`,
      },
    );

    content.append(
      main,
      sidebar,
    );

    panel.append(
      titlebar,
      tabbar,
      content,
    );

    root.append(
      launcher,
      panel,
    );

    document.documentElement.appendChild(
      root,
    );

    /*
     * Events
     */

    launcher.addEventListener(
      "click",
      () => {
        if (
          launcher.classList.contains(
            `${NS}dragging`,
          )
        ) {
          return;
        }

        openPanel();
      },
    );

    close.addEventListener(
      "click",
      closePanel,
    );

    minimize.addEventListener(
      "click",
      closePanel,
    );

    makeDraggable(launcher);

    /*
     * First tab
     */

    for (
      const item of
        tabbar.querySelectorAll(
          `.${NS}tab`,
        )
    ) {
      item.classList.toggle(
        `${NS}active`,
        item.dataset.tab ===
          "Elements",
      );
    }

    if (!state.enabled) {
      root.style.display = "none";
    }
  }

  /*
   * ------------------------------------------------------------
   * START
   * ------------------------------------------------------------
   */

  async function start() {
    await loadState();

    applyIdentity();

    /*
     * Wait until the document has a head/body.
     */

    if (
      document.readyState ===
      "loading"
    ) {
      document.addEventListener(
        "DOMContentLoaded",
        build,
        {
          once: true,
        },
      );
    } else {
      build();
    }
  }

  start();
})();
