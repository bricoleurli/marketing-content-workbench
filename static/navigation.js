/* Keep one workbench shell alive while each page runs in an isolated document. */
(() => {
  const routeApis = {
    "/library": ["/api/voiceovers", "/api/clips", "/api/overlays"],
    "/topics": [],
    "/voiceover": ["/api/config", "/api/voiceovers"],
    "/clips": ["/api/clips"],
    "/overlays": ["/api/overlays"],
  };
  const routeTitles = {
    "/library": "素材库",
    "/topics": "选题库",
    "/voiceover": "口播配音",
    "/clips": "事件镜头",
    "/overlays": "叠加模板",
  };
  const routes = new Set(Object.keys(routeApis));
  const embedded = new URLSearchParams(window.location.search).get("embedded") === "1";
  const pending = new Map();
  const prefetchedPages = new Set();
  const storagePrefix = "workbench-prefetch:";
  const cacheTtl = 30_000;
  let cacheEpoch = 0;

  function normalizePath(value = window.location.href) {
    const url = new URL(value, window.location.origin);
    const path = url.pathname.replace(/\/$/, "") || "/";
    if (path === "/") return "/library";
    return routes.has(path) ? path : null;
  }

  function routeHref(value = window.location.href) {
    const url = new URL(value, window.location.origin);
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function storageKey(path) {
    return `${storagePrefix}${path}`;
  }

  function readStored(path) {
    try {
      const raw = sessionStorage.getItem(storageKey(path));
      if (!raw) return null;
      const value = JSON.parse(raw);
      if (!value || Date.now() - Number(value.at) > cacheTtl) {
        sessionStorage.removeItem(storageKey(path));
        return null;
      }
      return value.data;
    } catch (_error) {
      return null;
    }
  }

  function writeStored(path, data) {
    try {
      sessionStorage.setItem(storageKey(path), JSON.stringify({ at: Date.now(), data }));
    } catch (_error) {
      // A full or disabled sessionStorage should not affect navigation.
    }
  }

  function prefetchJson(path) {
    if (pending.has(path)) return pending.get(path);
    const stored = readStored(path);
    if (stored !== null) return Promise.resolve(stored);

    const requestEpoch = cacheEpoch;
    const request = fetch(path, { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
        if (requestEpoch === cacheEpoch) writeStored(path, data);
        return data;
      })
      .finally(() => {
        if (pending.get(path) === request) pending.delete(path);
      });
    pending.set(path, request);
    return request;
  }

  // Page-specific scripts use this promise when a navigation prefetch is ready.
  window.workbenchReadPrefetch = (path) => {
    if (pending.has(path)) return pending.get(path);
    const stored = readStored(path);
    return stored === null ? null : Promise.resolve(stored);
  };

  window.workbenchClearPrefetch = () => {
    cacheEpoch += 1;
    pending.clear();
    try {
      for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
        const key = sessionStorage.key(index);
        if (key?.startsWith(storagePrefix)) sessionStorage.removeItem(key);
      }
    } catch (_error) {
      // Ignore storage cleanup failures; the server remains the source of truth.
    }
  };

  function warmRoute(route) {
    if (!routeApis[route]) return;
    if (!prefetchedPages.has(route)) {
      prefetchedPages.add(route);
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.href = route;
      document.head.appendChild(link);
    }
    routeApis[route].forEach((path) => prefetchJson(path).catch(() => {}));
  }

  function isModifiedClick(event) {
    return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
  }

  function isDownloadLink(link) {
    return link.hasAttribute("download") || link.target === "_blank" || link.target === "_parent";
  }

  function isWorkbenchLink(link) {
    if (!link?.href || isDownloadLink(link)) return null;
    let url;
    try {
      url = new URL(link.href, window.location.origin);
    } catch (_error) {
      return null;
    }
    if (url.origin !== window.location.origin) return null;
    const route = normalizePath(url.href);
    return route ? { route, href: routeHref(url) } : null;
  }

  function installPrefetchListeners() {
    document.querySelectorAll("a[href]").forEach((link) => {
      const target = isWorkbenchLink(link);
      if (!target) return;
      ["pointerenter", "focus", "touchstart"].forEach((eventName) => {
        link.addEventListener(eventName, () => warmRoute(target.route), { once: true, passive: true });
      });
    });
  }

  function installEmbeddedStyles() {
    document.documentElement.dataset.workbenchEmbedded = "true";
    const style = document.createElement("style");
    style.dataset.workbenchEmbedded = "true";
    style.textContent = `
      html, body { width: 100%; height: 100%; }
      body { overflow: hidden !important; }
      /* 素材总览和选题库是文档流长页面，靠整页滚动；其余工作台页面在面板内滚动。 */
      body.library-page, body.topics-page { overflow-y: auto !important; }
      .studio-nav, .app-sidebar-nav { display: none !important; }
      .studio-shell { grid-template-columns: minmax(0, 1fr) !important; }
      .topbar { justify-content: flex-end; }
      .topbar .brand-lockup, .topbar .page-nav { display: none !important; }
      .studio-main { min-width: 0; }
      @media (max-width: 720px) {
        body { overflow-y: auto !important; }
      }
      @media (max-width: 1050px) {
        .app-shell { grid-template-columns: minmax(0, 1fr) !important; }
      }
    `;
    document.head.appendChild(style);
  }

  function installEmbeddedNavigation() {
    installEmbeddedStyles();
    installPrefetchListeners();
    window.addEventListener("message", (event) => {
      if (event.origin !== window.location.origin || event.data?.type !== "workbench:visibility") return;
      document.documentElement.dataset.workbenchActive = event.data.active ? "true" : "false";
      if (!event.data.active) {
        document.querySelectorAll("audio, video").forEach((media) => media.pause());
      }
    });
    document.addEventListener("click", (event) => {
      if (isModifiedClick(event)) return;
      const link = event.target.closest("a[href]");
      const target = isWorkbenchLink(link);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      window.parent.postMessage({ type: "workbench:navigate", href: target.href }, window.location.origin);
    });
  }

  function hostStyles() {
    const style = document.createElement("style");
    style.dataset.workbenchHost = "true";
    style.textContent = `
      html.workbench-host-document, html.workbench-host-document body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: #0d0e10;
      }
      .workbench-host {
        display: grid;
        grid-template-columns: 184px minmax(0, 1fr);
        width: 100%;
        height: 100dvh;
        background: #0d0e10;
      }
      .workbench-host-nav {
        display: flex;
        min-height: 0;
        flex-direction: column;
        border-right: 1px solid #25282c;
        background: #101113;
        color: #f3f4f4;
        font-family: "DM Sans", "Noto Sans SC", sans-serif;
      }
      .workbench-host-brand {
        display: flex;
        align-items: center;
        gap: 10px;
        height: 64px;
        padding: 0 16px;
        color: #f3f4f4;
        text-decoration: none;
      }
      .workbench-host-brand-mark {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 2px;
        width: 30px;
        height: 30px;
        flex: 0 0 auto;
        border-radius: 5px;
        background: #f3f4f4;
      }
      .workbench-host-brand-mark i {
        display: block;
        width: 2px;
        border-radius: 2px;
        background: #f05252;
      }
      .workbench-host-brand-mark i:nth-child(1), .workbench-host-brand-mark i:nth-child(5) { height: 7px; }
      .workbench-host-brand-mark i:nth-child(2), .workbench-host-brand-mark i:nth-child(4) { height: 14px; }
      .workbench-host-brand-mark i:nth-child(3) { height: 20px; }
      .workbench-host-brand strong, .workbench-host-brand small { display: block; letter-spacing: 0; }
      .workbench-host-brand strong { font-size: 14px; font-weight: 700; }
      .workbench-host-brand small { margin-top: 1px; color: #8b9097; font-size: 10px; }
      .workbench-host-nav nav {
        display: flex;
        min-height: 0;
        flex: 1;
        flex-direction: column;
        gap: 3px;
        padding: 18px 10px;
        overflow-y: auto;
      }
      .workbench-host-section-label {
        display: block;
        margin: 10px 12px 4px;
        color: #555a61;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: .08em;
        line-height: 16px;
        text-transform: uppercase;
      }
      .workbench-host-section-label:first-child { margin-top: 0; }
      .workbench-host-nav a, .workbench-host-settings {
        display: flex;
        align-items: center;
        gap: 11px;
        min-height: 42px;
        padding: 0 12px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: #a8abb0;
        font: inherit;
        font-size: 13px;
        font-weight: 600;
        text-decoration: none;
        cursor: pointer;
        transition: background 140ms ease, color 140ms ease;
      }
      .workbench-host-nav a svg, .workbench-host-settings svg { width: 17px; height: 17px; flex: 0 0 auto; }
      .workbench-host-nav a:hover, .workbench-host-settings:hover { background: #1d2023; color: #f3f4f4; }
      .workbench-host-nav a.is-active { background: #2b1d20; color: #ff6863; }
      .workbench-host-nav a.is-active svg { color: #f05252; }
      .workbench-host-settings {
        margin: auto 10px 14px;
        border-top: 1px solid #25282c;
        border-radius: 0;
        color: #777d86;
      }
      .workbench-host-frame {
        grid-column: 2;
        grid-row: 1;
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: #0d0e10;
      }
      /* Author display:block overrides the browser default for [hidden]. */
      .workbench-host-frame[hidden] { display: none !important; }
      .workbench-host-nav :focus-visible { outline: 2px solid #f05252; outline-offset: 2px; }
      @media (max-width: 720px) {
        .workbench-host { grid-template-columns: 64px minmax(0, 1fr); }
        .workbench-host-brand { justify-content: center; padding: 0; }
        .workbench-host-brand > span:last-child, .workbench-host-section-label, .workbench-host-nav a span { display: none; }
        .workbench-host-nav nav { padding: 14px 8px; }
        .workbench-host-nav a, .workbench-host-settings { justify-content: center; padding: 0; }
        .workbench-host-settings { margin: auto 8px 10px; }
      }
    `;
    document.head.appendChild(style);
  }

  function hostNavMarkup(currentRoute) {
    const active = (route) => (route === currentRoute ? ' class="is-active" aria-current="page"' : "");
    return `
      <aside class="workbench-host-nav" aria-label="工作台功能">
        <a class="workbench-host-brand" href="/library" aria-label="素材库">
          <span class="workbench-host-brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
          <span><strong>素材库</strong><small>营销内容</small></span>
        </a>
        <nav>
          <span class="workbench-host-section-label">素材库</span>
          <a href="/library"${active("/library")}><i data-lucide="library"></i><span>素材总览</span></a>
          <a href="/topics"${active("/topics")}><i data-lucide="lightbulb"></i><span>选题库</span></a>
          <span class="workbench-host-section-label">生产入口</span>
          <a href="/voiceover"${active("/voiceover")}><i data-lucide="audio-lines"></i><span>口播配音</span></a>
          <a href="/clips"${active("/clips")}><i data-lucide="film"></i><span>事件镜头</span></a>
          <a href="/overlays"${active("/overlays")}><i data-lucide="layers-3"></i><span>叠加模板</span></a>
        </nav>
        <button class="workbench-host-settings" type="button" title="设置" aria-label="设置">
          <i data-lucide="settings-2"></i><span>设置</span>
        </button>
      </aside>
    `;
  }

  function refreshHostIcons() {
    if (window.lucide) window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } });
  }

  function loadHostIcons() {
    if (window.lucide) {
      refreshHostIcons();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://unpkg.com/lucide@0.468.0/dist/umd/lucide.min.js";
    script.onload = refreshHostIcons;
    document.head.appendChild(script);
  }

  function mountHost() {
    if (window.__workbenchHostMounted) return;
    window.__workbenchHostMounted = true;
    const initialRoute = normalizePath(window.location.href) || "/library";
    if (!normalizePath(window.location.href)) window.history.replaceState({}, "", "/library");

    hostStyles();
    const host = document.createElement("div");
    host.className = "workbench-host";
    host.innerHTML = hostNavMarkup(initialRoute);
    document.body.replaceChildren(host);
    document.documentElement.classList.add("workbench-host-document");
    document.body.style.visibility = "visible";

    const nav = host.querySelector(".workbench-host-nav");
    const frames = new Map();
    let activeFrame = null;

    function ensureFrame(route, url) {
      const embeddedHref = embeddedFrameUrl(url);
      let record = frames.get(route);
      if (!record) {
        const frame = document.createElement("iframe");
        frame.className = "workbench-host-frame";
        frame.title = routeTitles[route] || "营销内容工作台";
        frame.referrerPolicy = "same-origin";
        frame.hidden = true;
        frame.setAttribute("aria-hidden", "true");
        host.appendChild(frame);
        record = { frame, href: "" };
        frames.set(route, record);
      }
      if (record.href !== embeddedHref) {
        record.href = embeddedHref;
        record.frame.src = embeddedHref;
      }
      return record.frame;
    }

    function showFrame(frame) {
      if (activeFrame === frame) return;
      frames.forEach(({ frame: candidate }) => {
        const active = candidate === frame;
        candidate.hidden = !active;
        candidate.setAttribute("aria-hidden", String(!active));
        candidate.contentWindow?.postMessage({ type: "workbench:visibility", active }, window.location.origin);
      });
      activeFrame = frame;
    }

    function updateActive(route) {
      nav.querySelectorAll("a[href]").forEach((link) => {
        const isActive = normalizePath(link.href) === route;
        link.classList.toggle("is-active", isActive);
        if (isActive) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      });
    }

    function embeddedFrameUrl(value) {
      const url = new URL(value, window.location.origin);
      url.searchParams.set("embedded", "1");
      return routeHref(url);
    }

    function navigate(value, { push = true } = {}) {
      const url = new URL(value, window.location.origin);
      const route = normalizePath(url.href);
      if (!route) return;
      const href = routeHref(url);
      if (push && href !== routeHref(window.location.href)) window.history.pushState({}, "", href);
      updateActive(route);
      warmRoute(route);
      showFrame(ensureFrame(route, url));
    }

    document.addEventListener("click", (event) => {
      if (event.defaultPrevented || isModifiedClick(event)) return;
      const link = event.target.closest("a[href]");
      if (!link || !nav.contains(link)) return;
      const target = isWorkbenchLink(link);
      if (!target) return;
      event.preventDefault();
      navigate(target.href);
    });

    // Switch on pointerdown so a slow-loading iframe can never delay the
    // navigation click that follows it.
    nav.querySelectorAll("a[href]").forEach((link) => {
      link.addEventListener("pointerdown", (event) => {
        if (isModifiedClick(event)) return;
        const target = isWorkbenchLink(link);
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        navigate(target.href);
      });
    });

    window.addEventListener("message", (event) => {
      if (event.origin !== window.location.origin || event.data?.type !== "workbench:navigate") return;
      navigate(event.data.href);
    });

    window.addEventListener("popstate", () => {
      const route = normalizePath(window.location.href);
      if (route) navigate(routeHref(window.location.href), { push: false });
    });

    nav.querySelectorAll("a[href]").forEach((link) => {
      const target = isWorkbenchLink(link);
      if (!target) return;
      ["pointerenter", "focus", "touchstart"].forEach((eventName) => {
        link.addEventListener(eventName, () => warmRoute(target.route), { once: true, passive: true });
      });
    });

    updateActive(initialRoute);
    navigate(routeHref(window.location.href), { push: false });
    loadHostIcons();
  }

  if (embedded) {
    installEmbeddedNavigation();
    return;
  }

  installPrefetchListeners();
  document.documentElement.classList.add("workbench-host-document");
  window.__workbenchHostPending = true;
  if (document.body) {
    document.body.style.visibility = "hidden";
    window.setTimeout(mountHost, 0);
  }
})();
