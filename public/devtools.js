(() => {
  "use strict";

  /*
   * ============================================================
   * RANDOM NAMESPACE
   * ============================================================
   *
   * Nothing here uses generic IDs such as "devtools".
   */

  const random =
    crypto.randomUUID()
      .replaceAll("-", "");

  const NS =
    `__n3xn_dt_${random}_`;

  const DB_NAME =
    `${NS}indexeddb`;

  const DB_STORE =
    `${NS}settings`;

  const STYLE_ID =
    `${NS}style`;

  /*
   * ============================================================
   * STATE
   * ============================================================
   */

  const state = {
    enabled: true,

    titleOverride: null,

    faviconOverride: null,

    scripts: [],

    cloakTitle: null,

    cloakFavicon: null,

    devAuthenticated: false,
  };

  /*
   * ============================================================
   * INDEXEDDB
   * ============================================================
   */

  function openDB() {
    return new Promise(
      (resolve, reject) => {
        const request =
          indexedDB.open(
            DB_NAME,
            1,
          );

        request.onupgradeneeded =
          () => {
            if (
              !request.result.objectStoreNames.contains(
                DB_STORE,
              )
            ) {
              request.result.createObjectStore(
                DB_STORE,
              );
            }
          };

        request.onsuccess =
          () => resolve(request.result);

        request.onerror =
          () => reject(request.error);
      },
    );
  }

  async function loadState() {
    try {
      const db =
        await openDB();

      const value =
        await new Promise(
          (resolve, reject) => {
            const tx =
              db.transaction(
                DB_STORE,
                "readonly",
              );

            const request =
              tx.objectStore(
                DB_STORE,
              ).get("state");

            request.onsuccess =
              () => resolve(request.result);

            request.onerror =
              () => reject(request.error);
          },
        );

      if (value) {
        Object.assign(
          state,
          value,
        );
      }
    } catch {
      /*
       * IndexedDB may be disabled by the
       * embedding environment.
       */
    }
  }

  async function saveState() {
    try {
      const db =
        await openDB();

      const tx =
        db.transaction(
          DB_STORE,
          "readwrite",
        );

      tx.objectStore(
        DB_STORE,
      ).put(
        structuredClone(state),
        "state",
      );
    } catch {
      /*
       * Non-fatal.
       */
    }
  }

  /*
   * ============================================================
   * HELPERS
   * ============================================================
   */

  function create(
    tag,
    options = {},
    text = "",
  ) {
    const element =
      document.createElement(tag);

    for (
      const [key, value]
      of Object.entries(options)
    ) {
      if (key === "className") {
        element.className = value;
      } else if (
        key === "textContent"
      ) {
        element.textContent = value;
      } else if (
        key in element
      ) {
        element[key] = value;
      } else {
        element.setAttribute(
          key,
          value,
        );
      }
    }

    if (text) {
      element.textContent = text;
    }

    return element;
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
   * ============================================================
   * TITLE / FAVICON
   * ============================================================
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
      let favicon =
        document.querySelector(
          'link[rel~="icon"]',
        );

      if (!favicon) {
        favicon =
          document.createElement(
            "link",
          );

        favicon.rel = "icon";

        document.head.appendChild(
          favicon,
        );
      }

      favicon.href =
        state.faviconOverride;
    }
  }

  /*
   * ============================================================
   * DEVTOOLS AUTH
   * ============================================================
   */

  async function authenticateDevTools() {
    if (
      state.devAuthenticated
    ) {
      return true;
    }

    const password =
      window.prompt(
        "n3xn DevTools password:",
      );

    if (password === null) {
      return false;
    }

    try {
      const response =
        await fetch(
          "/devtools-auth",
          {
            method: "POST",

            credentials: "same-origin",

            headers: {
              "Content-Type":
                "application/json",
            },

            body: JSON.stringify({
              password,
            }),
          },
        );

      const result =
        await response.json();

      if (
        response.ok &&
        result.ok
      ) {
        state.devAuthenticated =
          true;

        await saveState();

        return true;
      }
    } catch {
      /*
       * Network failure.
       */
    }

    window.alert(
      "DevTools authentication failed.",
    );

    return false;
  }

  /*
   * ============================================================
   * MAIN WINDOW
   * ============================================================
   */

  let root;
  let launcher;
  let windowPanel;

  let mainArea;
  let sideArea;
  let tabs;

  function openPanel() {
    windowPanel.classList.add(
      "n3xn-open",
    );
  }

  function closePanel() {
    windowPanel.classList.remove(
      "n3xn-open",
    );
  }

  /*
   * ============================================================
   * DOM INSPECTOR
   * ============================================================
   */

  function showElements() {
    mainArea.innerHTML = "";

    sideArea.innerHTML = "";

    const pre =
      create(
        "pre",
        {
          className:
            "n3xn-devtools-pre",
        },
      );

    pre.textContent =
      document.documentElement
        .outerHTML;

    mainArea.appendChild(pre);

    const info =
      create("div");

    info.innerHTML =
      `<strong>DOM</strong>
       <p>Live document structure.</p>`;

    sideArea.appendChild(info);
  }

  /*
   * ============================================================
   * CONSOLE
   * ============================================================
   */

  function showConsole() {
    mainArea.innerHTML = "";

    sideArea.innerHTML = "";

    const wrapper =
      create(
        "div",
        {
          className:
            "n3xn-devtools-console",
        },
      );

    const output =
      create(
        "div",
        {
          className:
            "n3xn-devtools-console-output",
        },
      );

    const input =
      create(
        "textarea",
        {
          className:
            "n3xn-devtools-console-input",
          placeholder:
            "JavaScript — DevTools password required",
        },
      );

    wrapper.append(
      output,
      input,
    );

    mainArea.appendChild(
      wrapper,
    );

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

        if (
          !(await authenticateDevTools())
        ) {
          return;
        }

        const source =
          input.value;

        input.value = "";

        const line =
          create(
            "div",
            {
              className:
                "n3xn-devtools-console-line",
            },
          );

        try {
          /*
           * Explicitly use the page's global
           * execution environment.
           */

          const result =
            (0, eval)(source);

          line.textContent =
            result === undefined
              ? "undefined"
              : String(result);
        } catch (error) {
          line.textContent =
            String(error);
        }

        output.appendChild(line);

        output.scrollTop =
          output.scrollHeight;
      },
    );

    sideArea.innerHTML =
      `<strong>Console</strong>
       <p>Execution is locked until DevTools authentication succeeds.</p>`;
  }

  /*
   * ============================================================
   * SOURCES
   * ============================================================
   */

  function showSources() {
    mainArea.innerHTML = "";

    sideArea.innerHTML = "";

    const editor =
      create(
        "textarea",
        {
          className:
            "n3xn-devtools-field",
          style:
            "height:100%;resize:none;font-family:monospace;background:#1e1e1e;color:#ddd;border:0;border-radius:0",
        },
      );

    editor.value =
      document.documentElement
        .outerHTML;

    mainArea.appendChild(
      editor,
    );

    const button =
      create(
        "button",
        {
          className:
            "n3xn-devtools-action",
        },
        "Apply source",
      );

    button.onclick =
      async () => {
        if (
          !(await authenticateDevTools())
        ) {
          return;
        }

        /*
         * This deliberately requires the
         * privileged DevTools password.
         */

        const replacement =
          editor.value;

        document.open();

        document.write(
          replacement,
        );

        document.close();
      };

    sideArea.appendChild(
      button,
    );
  }

  /*
   * ============================================================
   * NETWORK
   * ============================================================
   */

  function showNetwork() {
    mainArea.innerHTML = "";

    sideArea.innerHTML = "";

    const entries =
      performance.getEntriesByType(
        "resource",
      );

    if (!entries.length) {
      mainArea.appendChild(
        create(
          "pre",
          {
            className:
              "n3xn-devtools-pre",
          },
          "No resource entries available.",
        ),
      );

      return;
    }

    for (
      const entry of entries
    ) {
      const row =
        create(
          "div",
          {
            className:
              "n3xn-devtools-network-row",
          },
          entry.name,
        );

      mainArea.appendChild(
        row,
      );
    }
  }

  /*
   * ============================================================
   * APPLICATION
   * ============================================================
   */

  function showApplication() {
    mainArea.innerHTML = "";

    sideArea.innerHTML = "";

    const pre =
      create(
        "pre",
        {
          className:
            "n3xn-devtools-pre",
        },
      );

    pre.textContent =
      [
        "IndexedDB",
        "",
        `Database: ${DB_NAME}`,
        `Store: ${DB_STORE}`,
        "",
        "Persistent n3xn DevTools settings are stored locally.",
      ].join("\n");

    mainArea.appendChild(
      pre,
    );
  }

  /*
   * ============================================================
   * SCRIPT INJECTOR
   * ============================================================
   */

  function addScript(script) {
    if (
      script.startsWith(
        "http://",
      ) ||
      script.startsWith(
        "https://",
      )
    ) {
      const element =
        document.createElement(
          "script",
        );

      element.src = script;

      element.async = false;

      document.head.appendChild(
        element,
      );

      state.scripts.push({
        type: "url",
        value: script,
      });

      return;
    }

    /*
     * User-entered inline JS.
     *
     * This is a user-authorized feature of
     * this local DevTools layer.
     */

    try {
      (0, eval)(script);

      state.scripts.push({
        type: "code",
        value: script,
      });
    } catch (error) {
      console.error(
        "n3xn script error:",
        error,
      );
    }
  }

  /*
   * ============================================================
   * CLOAK WINDOW
   * ============================================================
   */

  function openCloak() {
    const popup =
      window.open(
        "about:blank",
        "_blank",
      );

    if (!popup) {
      window.alert(
        "Popup blocked by the browser.",
      );

      return;
    }

    const title =
      state.cloakTitle ??
      state.titleOverride ??
      document.title;

    const favicon =
      state.cloakFavicon ??
      state.faviconOverride ??
      "";

    const currentURL =
      location.href;

    const html =
      `<!doctype html>
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
  src="${escapeHTML(currentURL)}"
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

    popup.document.write(
      html,
    );

    popup.document.close();

    /*
     * Keep the requested xd:// representation as
     * a local/history identifier only.
     *
     * Browsers do not allow a normal webpage to
     * turn itself into an arbitrary protocol handler.
     */

    try {
      history.replaceState(
        null,
        "",
        `xd://${location.host}${location.pathname}`,
      );
    } catch {}
  }

  /*
   * ============================================================
   * SETTINGS
   * ============================================================
   */

  function showSettings() {
    mainArea.innerHTML = "";

    sideArea.innerHTML = "";

    const titleLabel =
      create(
        "label",
        {},
        "Page title",
      );

    const title =
      create(
        "input",
        {
          className:
            "n3xn-devtools-field",
          value:
            state.titleOverride ||
            "",
          placeholder:
            "Custom title",
        },
      );

    const faviconLabel =
      create(
        "label",
        {},
        "Favicon URL",
      );

    const favicon =
      create(
        "input",
        {
          className:
            "n3xn-devtools-field",
          value:
            state.faviconOverride ||
            "",
          placeholder:
            "https://example.com/icon.png",
        },
      );

    const scriptLabel =
      create(
        "label",
        {},
        "Automatic script URL or JavaScript",
      );

    const script =
      create(
        "textarea",
        {
          className:
            "n3xn-devtools-field",
          placeholder:
            "https://example.com/script.js\nor\nconsole.log('hello')",
          style:
            "min-height:100px",
        },
      );

    const save =
      create(
        "button",
        {
          className:
            "n3xn-devtools-action",
        },
        "Save",
      );

    save.onclick =
      async () => {
        state.titleOverride =
          title.value || null;

        state.faviconOverride =
          favicon.value || null;

        applyIdentity();

        if (
          script.value.trim()
        ) {
          addScript(
            script.value.trim(),
          );

          script.value = "";
        }

        await saveState();
      };

    const cloakTitleLabel =
      create(
        "label",
        {},
        "Cloak title",
      );

    const cloakTitle =
      create(
        "input",
        {
          className:
            "n3xn-devtools-field",
          value:
            state.cloakTitle || "",
        },
      );

    const cloakFaviconLabel =
      create(
        "label",
        {},
        "Cloak favicon",
      );

    const cloakFavicon =
      create(
        "input",
        {
          className:
            "n3xn-devtools-field",
          value:
            state.cloakFavicon || "",
        },
      );

    const cloak =
      create(
        "button",
        {
          className:
            "n3xn-devtools-action",
        },
        "Open in about:blank",
      );

    cloak.onclick =
      async () => {
        state.cloakTitle =
          cloakTitle.value ||
          null;

        state.cloakFavicon =
          cloakFavicon.value ||
          null;

        await saveState();

        openCloak();
      };

    const enabled =
      create(
        "input",
        {
          type: "checkbox",
        },
      );

    enabled.checked =
      state.enabled;

    enabled.onchange =
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
      };

    sideArea.append(
      titleLabel,
      title,
      faviconLabel,
      favicon,
      scriptLabel,
      script,
      save,

      create("hr"),

      cloakTitleLabel,
      cloakTitle,
      cloakFaviconLabel,
      cloakFavicon,
      cloak,

      create("hr"),

      create(
        "label",
        {},
        "Enable n3xn DevTools ",
      ),
      enabled,
    );

    mainArea.appendChild(
      create(
        "pre",
        {
          className:
            "n3xn-devtools-pre",
        },
        [
          "n3xn DevTools settings",
          "",
          "Settings are stored in IndexedDB.",
          "",
          `Namespace: ${NS}`,
          `Database: ${DB_NAME}`,
        ].join("\n"),
      ),
    );
  }

  /*
   * ============================================================
   * TABS
   * ============================================================
   */

  function switchTab(name) {
    tabs
      .querySelectorAll(
        "button",
      )
      .forEach(button => {
        button.classList.toggle(
          "n3xn-active",
          button.dataset.tab ===
            name,
        );
      });

    switch (name) {
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
    }
  }

  /*
   * ============================================================
   * BUILD UI
   * ============================================================
   */

  function build() {
    if (
      document.getElementById(
        STYLE_ID,
      )
    ) {
      return;
    }

    const style =
      create("style", {
        id: STYLE_ID,
      });

    /*
     * Load the stylesheet relative to
     * this page.
     */

    const link =
      document.createElement(
        "link",
      );

    link.rel = "stylesheet";

    link.href =
      "https://raw.githubusercontent.com/kbsigmaboy67AtSchool/git/main/public/devtools.css";

    document.head.appendChild(
      link,
    );

    /*
     * Root
     */

    root =
      create(
        "div",
        {
          className:
            "n3xn-devtools-root",
        },
      );

    /*
     * Launcher
     */

    launcher =
      create(
        "button",
        {
          className:
            "n3xn-devtools-launcher",
          title:
            "n3xn DevTools",
        },
        "⚙",
      );

    root.appendChild(
      launcher,
    );

    /*
     * Window
     */

    windowPanel =
      create(
        "section",
        {
          className:
            "n3xn-devtools-window",
        },
      );

    /*
     * Title bar
     */

    const titlebar =
      create(
        "div",
        {
          className:
            "n3xn-devtools-titlebar",
        },
      );

    const title =
      create(
        "span",
        {
          className:
            "n3xn-devtools-title",
        },
        "n3xn DevTools",
      );

    const close =
      create(
        "button",
        {
          className:
            "n3xn-devtools-button",
        },
        "×",
      );

    close.onclick =
      closePanel;

    titlebar.append(
      title,
      close,
    );

    /*
     * Tabs
     */

    tabs =
      create(
        "nav",
        {
          className:
            "n3xn-devtools-tabs",
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

    for (
      const name
      of tabNames
    ) {
      const button =
        create(
          "button",
          {
            className:
              "n3xn-devtools-tab",
          },
          name,
        );

      button.dataset.tab =
        name;

      button.onclick =
        () =>
          switchTab(name);

      tabs.appendChild(
        button,
      );
    }

    /*
     * Content
     */

    const content =
      create(
        "div",
        {
          className:
            "n3xn-devtools-content",
        },
      );

    mainArea =
      create(
        "main",
        {
          className:
            "n3xn-devtools-main",
        },
      );

    sideArea =
      create(
        "aside",
        {
          className:
            "n3xn-devtools-sidebar",
        },
      );

    content.append(
      mainArea,
      sideArea,
    );

    windowPanel.append(
      titlebar,
      tabs,
      content,
    );

    document.documentElement.append(
      root,
      windowPanel,
    );

    /*
     * Launcher
     */

    launcher.onclick =
      openPanel;

    /*
     * Dragging
     */

    let dragging = false;

    let offsetX = 0;
    let offsetY = 0;

    launcher.addEventListener(
      "pointerdown",
      event => {
        dragging = true;

        const rect =
          root.getBoundingClientRect();

        offsetX =
          event.clientX -
          rect.left;

        offsetY =
          event.clientY -
          rect.top;

        launcher.setPointerCapture(
          event.pointerId,
        );
      },
    );

    launcher.addEventListener(
      "pointermove",
      event => {
        if (!dragging) return;

        root.style.left =
          `${Math.max(
            0,
            Math.min(
              window.innerWidth -
                44,
              event.clientX -
                offsetX,
            ),
          )}px`;

        root.style.top =
          `${Math.max(
            0,
            Math.min(
              window.innerHeight -
                44,
              event.clientY -
                offsetY,
            ),
          )}px`;

        root.style.right =
          "auto";

        root.style.bottom =
          "auto";
      },
    );

    launcher.addEventListener(
      "pointerup",
      () => {
        dragging = false;
      },
    );

    /*
     * Start with Elements.
     */

    switchTab(
      "Elements",
    );
  }

  /*
   * ============================================================
   * INIT
   * ============================================================
   */

  async function init() {
    await loadState();

    if (!state.enabled) {
      return;
    }

    applyIdentity();

    build();
  }

  init();
})();

