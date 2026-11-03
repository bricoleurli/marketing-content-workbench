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
    "/library": "素材总览",
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
    const aliases = { "/library.html": "/library", "/topics.html": "/topics", "/index.html": "/voiceover", "/clips.html": "/clips", "/overlays.html": "/overlays" };
    if (aliases[path]) return aliases[path];
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
  }

  function installEmbeddedNavigation() {
    installEmbeddedStyles();
    installPrefetchListeners();
    window.addEventListener("message", (event) => {
      if (event.origin !== window.location.origin || event.data?.type !== "workbench:visibility") return;
      document.documentElement.dataset.workbenchActive = event.data.active ? "true" : "false";
      if (!event.data.active) {
        document.querySelectorAll("audio, video").forEach((media) => media.pause());
        document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
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

  function hostNavMarkup(currentRoute) {
    const active = (route) => (route === currentRoute ? ' class="is-active" aria-current="page"' : "");
    return `
      <aside class="workbench-host-nav" aria-label="工作台功能">
        <a class="workbench-host-brand" href="/library" aria-label="营销工作台首页">
          <span class="workbench-host-brand-mark" aria-hidden="true"><i data-lucide="panels-top-left"></i></span>
          <span><strong>营销工作台</strong><small>内容创作与素材管理</small></span>
        </a>
        <nav>
          <span class="workbench-host-section-label">内容与素材</span>
          <a href="/library" title="素材总览"${active("/library")}><i data-lucide="library"></i><span>素材总览</span></a>
          <a href="/topics" title="选题库"${active("/topics")}><i data-lucide="lightbulb"></i><span>选题库</span></a>
          <span class="workbench-host-section-label">生产入口</span>
          <a href="/voiceover" title="口播配音"${active("/voiceover")}><i data-lucide="audio-lines"></i><span>口播配音</span></a>
          <a href="/clips" title="事件镜头"${active("/clips")}><i data-lucide="film"></i><span>事件镜头</span></a>
          <a href="/overlays" title="叠加模板"${active("/overlays")}><i data-lucide="layers-3"></i><span>叠加模板</span></a>
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

    const host = document.createElement("div");
    host.className = "workbench-host";
    host.innerHTML = `<a class="workbench-skip" href="#workbenchContent">跳到内容</a>${hostNavMarkup(initialRoute)}
      <header class="workbench-host-header"><h1 id="workbenchPageTitle"></h1><p id="workbenchPageDescription"></p></header>
      <dialog class="workbench-settings-dialog" aria-labelledby="workbenchSettingsTitle">
        <form id="workbenchSettingsForm">
          <div class="dialog-header"><h2 id="workbenchSettingsTitle">配音设置</h2><button class="icon-button" type="button" data-settings-close aria-label="关闭设置"><i data-lucide="x"></i></button></div>
          <p class="workbench-settings-status" role="status">正在读取配置…</p>
          <label class="field-label" for="workbenchApiKey">Fish Audio API Key</label>
          <div class="secret-input"><input id="workbenchApiKey" type="password" autocomplete="off" placeholder="粘贴密钥以新增或替换" /><button class="icon-button" id="workbenchKeyToggle" type="button" aria-label="显示密钥" aria-pressed="false"><i data-lucide="eye"></i></button></div>
          <p class="field-help">密钥保存在当前工作台的私有配置中，页面不会显示已存密钥。音色在口播配音页管理。</p>
          <p class="workbench-settings-error" role="alert"></p>
          <div class="dialog-actions"><button class="text-button" type="button" data-settings-close>取消</button><button class="primary-button" id="workbenchSaveSettings" type="submit">保存设置</button></div>
        </form>
      </dialog>
      <div class="workbench-settings-notice" role="status" hidden></div>`;
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
        frame.title = routeTitles[route] || "营销工作台";
        frame.tabIndex = 0;
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
      frame.id = "workbenchContent";
      frames.forEach(({ frame: other }) => { if (other !== frame) other.removeAttribute("id"); });
    }

    function updateActive(route) {
      const descriptions = {
        "/library": "搜索、挑选并打包可复用的创作素材",
        "/topics": "按分类和分组挑选选题，记录使用进度",
        "/voiceover": "编辑口播文案、选择音色并管理配音",
        "/clips": "按事件整理镜头，预览和管理素材",
        "/overlays": "排列图片、调整节奏并导出叠加素材",
      };
      host.querySelector("#workbenchPageTitle").textContent = routeTitles[route];
      host.querySelector("#workbenchPageDescription").textContent = descriptions[route];
      document.title = `${routeTitles[route]} · 营销工作台`;
      nav.querySelectorAll("nav a[href]").forEach((link) => {
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

    const settingsDialog = host.querySelector(".workbench-settings-dialog");
    const keyInput = host.querySelector("#workbenchApiKey");
    const settingsError = host.querySelector(".workbench-settings-error");
    const settingsStatus = host.querySelector(".workbench-settings-status");
    const saveSettingsButton = host.querySelector("#workbenchSaveSettings");
    const keyToggle = host.querySelector("#workbenchKeyToggle");
    let settingsEpoch = 0;
    let noticeTimer;
    async function settingsRequest(path, options) {
      const response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...options });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || (response.status === 403 ? "此站点限制修改配音设置，请使用本地工作台。" : `请求失败（${response.status}），请稍后重试。`));
      return data;
    }
    nav.querySelector(".workbench-host-settings").addEventListener("click", async () => {
      settingsError.textContent = "";
      settingsStatus.textContent = "正在读取配置…";
      settingsDialog.showModal();
      const epoch = ++settingsEpoch;
      try {
        const config = await settingsRequest("/api/config");
        if (epoch !== settingsEpoch) return;
        settingsStatus.textContent = config.keyConfigured ? "已配置密钥，可填写新密钥替换。" : "尚未配置密钥，生成配音前请先配置。";
      } catch (error) {
        if (epoch === settingsEpoch) settingsStatus.textContent = error.message;
      }
    });
    host.querySelectorAll("[data-settings-close]").forEach((button) => button.addEventListener("click", () => settingsDialog.close()));
    settingsDialog.addEventListener("close", () => {
      settingsEpoch += 1;
      keyInput.value = "";
      keyInput.type = "password";
      keyToggle.setAttribute("aria-pressed", "false");
      keyToggle.setAttribute("aria-label", "显示密钥");
    });
    keyToggle.addEventListener("click", () => {
      const visible = keyInput.type === "password";
      keyInput.type = visible ? "text" : "password";
      keyToggle.setAttribute("aria-pressed", String(visible));
      keyToggle.setAttribute("aria-label", visible ? "隐藏密钥" : "显示密钥");
    });
    host.querySelector("#workbenchSettingsForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const apiKey = keyInput.value.trim();
      if (apiKey.length < 20) {
        settingsError.textContent = "请填写有效的 Fish Audio API Key（至少20个字符）。";
        keyInput.focus();
        return;
      }
      saveSettingsButton.disabled = true;
      saveSettingsButton.textContent = "正在保存…";
      settingsError.textContent = "";
      try {
        await settingsRequest("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey }) });
        window.workbenchClearPrefetch();
        frames.forEach(({ frame }) => frame.contentWindow?.postMessage({ type: "workbench:config-changed" }, window.location.origin));
        settingsDialog.close();
        const notice = host.querySelector(".workbench-settings-notice");
        notice.textContent = "配音设置已保存";
        notice.hidden = false;
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => { notice.hidden = true; }, 3000);
      } catch (error) {
        settingsError.textContent = error.message;
      } finally {
        saveSettingsButton.disabled = false;
        saveSettingsButton.textContent = "保存设置";
      }
    });
    host.querySelector(".workbench-skip").addEventListener("click", (event) => { event.preventDefault(); activeFrame?.focus(); });

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
