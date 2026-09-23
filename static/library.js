if (!window.__workbenchHostPending) {
const state = {
  assets: [],
  filter: "all",
  query: "",
  selected: new Set(),
  current: null,
};

const elements = {
  assetGrid: document.querySelector("#assetGrid"),
  libraryEmpty: document.querySelector("#libraryEmpty"),
  assetSearch: document.querySelector("#assetSearch"),
  resultCount: document.querySelector("#resultCount"),
  voiceCount: document.querySelector("#voiceCount"),
  clipCount: document.querySelector("#clipCount"),
  overlayCount: document.querySelector("#overlayCount"),
  selectedCount: document.querySelector("#selectedCount"),
  selectVisibleButton: document.querySelector("#selectVisibleButton"),
  exportPackButton: document.querySelector("#exportPackButton"),
  libraryStatus: document.querySelector("#libraryStatus"),
  assetDialog: document.querySelector("#assetDialog"),
  assetDialogPreview: document.querySelector("#assetDialogPreview"),
  assetDialogType: document.querySelector("#assetDialogType"),
  assetDialogTitle: document.querySelector("#assetDialogTitle"),
  assetDialogDescription: document.querySelector("#assetDialogDescription"),
  assetDialogMeta: document.querySelector("#assetDialogMeta"),
  assetDialogDownload: document.querySelector("#assetDialogDownload"),
  assetDialogOpen: document.querySelector("#assetDialogOpen"),
  libraryAudio: document.querySelector("#libraryAudio"),
  toast: document.querySelector("#libraryToast"),
};

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  return `${minutes}:${(value - minutes * 60).toFixed(1).padStart(4, "0")}`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value > 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value > 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function showToast(message, type = "info") {
  elements.toast.textContent = message;
  elements.toast.className = `library-toast show${type === "error" ? " error" : ""}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.remove("show"), 3200);
}

async function requestJson(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  if (method === "GET") {
    const prefetched = window.workbenchReadPrefetch?.(path);
    if (prefetched) return prefetched;
  } else {
    window.workbenchClearPrefetch?.();
  }
  const response = await fetch(path, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function eventClips(events) {
  return (events || []).flatMap((event) => (event.clips || []).map((clip) => ({
    ...clip,
    type: "clip",
    key: `clip:${event.id}:${clip.file}`,
    eventId: event.id,
    eventTitle: event.title,
    title: clip.title || clip.file,
    description: clip.description || event.description || "",
    sourceLabel: clip.sourceLabel || event.title,
  })));
}

function overlayAssets(instances) {
  return (instances || []).map((instance) => {
    const image = (instance.images || []).find((item) => item.file) || null;
    const output = instance.outputs?.preview || instance.outputs?.webm || instance.outputs?.mov || null;
    return {
      ...instance,
      type: "overlay",
      key: `overlay:${instance.id}`,
      title: instance.title || instance.id,
      description: instance.hint || "可继续替换图片并导出不同版本",
      imageUrl: image?.url || "",
      outputUrl: output?.url || "",
      outputBytes: output?.bytes || 0,
      sourceLabel: instance.componentTitle || "叠加模板",
    };
  });
}

function normalizeAssets(voiceovers, clips, overlays) {
  const voices = (voiceovers.items || []).map((voice) => ({
    ...voice,
    type: "voice",
    key: `voice:${voice.id}`,
    title: voice.title || voice.id,
    description: voice.hasTranscript ? "已有自动字幕，可直接进入剪辑软件" : "口播音频素材",
    sourceLabel: "口播配音",
  }));
  return [...voices, ...eventClips(clips.events), ...overlayAssets(overlays.instances)];
}

function visibleAssets() {
  const needle = state.query.trim().toLocaleLowerCase("zh-CN");
  return state.assets.filter((asset) => {
    if (state.filter !== "all" && asset.type !== state.filter) return false;
    if (!needle) return true;
    return [asset.title, asset.description, asset.eventTitle, asset.sourceLabel, ...(asset.tags || [])]
      .join(" ").toLocaleLowerCase("zh-CN").includes(needle);
  });
}

function iconFor(type) {
  return type === "voice" ? "audio-lines" : type === "clip" ? "film" : "layers-3";
}

function labelFor(type) {
  return type === "voice" ? "口播配音" : type === "clip" ? "事件镜头" : "叠加模板";
}

function cardMedia(asset) {
  if (asset.type === "voice") {
    return `<div class="library-card-media audio" data-preview="${escapeHtml(asset.key)}"><span class="library-wave" aria-hidden="true">${Array.from({ length: 9 }, () => "<i></i>").join("")}</span><span class="library-card-badge"><i data-lucide="play"></i>试听</span></div>`;
  }
  if (asset.imageUrl || asset.poster) {
    return `<div class="library-card-media" data-preview="${escapeHtml(asset.key)}"><img src="${escapeHtml(asset.imageUrl || asset.poster)}" alt="" loading="lazy" /><span class="library-card-badge"><i data-lucide="${iconFor(asset.type)}"></i>${escapeHtml(labelFor(asset.type))}</span></div>`;
  }
  return `<div class="library-card-media placeholder" data-preview="${escapeHtml(asset.key)}"><i data-lucide="${iconFor(asset.type)}"></i><span class="library-card-badge">${escapeHtml(labelFor(asset.type))}</span></div>`;
}

function cardMarkup(asset) {
  const selected = state.selected.has(asset.key) ? " is-selected" : "";
  const duration = asset.duration ? formatTime(asset.duration) : asset.filled != null ? `${asset.filled}/${asset.slotCount} 张` : "";
  const tags = (asset.tags || []).slice(0, 3).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
  const downloadUrl = asset.type === "voice" ? asset.url : asset.type === "clip" ? asset.url : asset.outputUrl;
  const canDownload = Boolean(downloadUrl);
  return `<article class="library-card${selected}" data-asset-key="${escapeHtml(asset.key)}">
    <input class="library-card-check" type="checkbox" aria-label="选择${escapeHtml(asset.title)}" data-select-asset="${escapeHtml(asset.key)}"${selected ? " checked" : ""} />
    ${cardMedia(asset)}
    <div class="library-card-body">
      <div class="library-card-heading"><strong title="${escapeHtml(asset.title)}">${escapeHtml(asset.title)}</strong><small>${escapeHtml(duration)}</small></div>
      <div class="library-card-meta"><i data-lucide="${iconFor(asset.type)}"></i><span>${escapeHtml(asset.eventTitle || asset.sourceLabel)}</span></div>
      <div class="library-card-tags">${tags}</div>
      <div class="library-card-actions">
        <button class="library-button label-action" type="button" data-open-asset="${escapeHtml(asset.key)}"><i data-lucide="eye"></i><span>查看</span></button>
        ${canDownload ? `<a class="library-button icon-only" href="${escapeHtml(downloadUrl)}" download title="下载" aria-label="下载"><i data-lucide="download"></i></a>` : ""}
        ${asset.type === "overlay" ? `<a class="library-button icon-only" href="/overlays" title="编辑模板" aria-label="编辑模板"><i data-lucide="pencil"></i></a>` : ""}
      </div>
    </div>
  </article>`;
}

function renderStats() {
  elements.voiceCount.textContent = state.assets.filter((asset) => asset.type === "voice").length;
  elements.clipCount.textContent = state.assets.filter((asset) => asset.type === "clip").length;
  elements.overlayCount.textContent = state.assets.filter((asset) => asset.type === "overlay").length;
  elements.selectedCount.textContent = state.selected.size;
  elements.exportPackButton.disabled = !state.selected.size;
}

function renderGrid() {
  const assets = visibleAssets();
  elements.resultCount.textContent = `${assets.length} 条素材`;
  elements.assetGrid.innerHTML = assets.map(cardMarkup).join("");
  elements.assetGrid.hidden = !assets.length;
  elements.libraryEmpty.hidden = Boolean(assets.length);
  refreshIcons();
  renderStats();
}

function findAsset(key) {
  return state.assets.find((asset) => asset.key === key) || null;
}

function stopDialogMedia() {
  elements.assetDialogPreview.querySelectorAll("video, audio").forEach((media) => media.pause());
  elements.libraryAudio.pause();
}

function openAsset(asset) {
  if (!asset) return;
  state.current = asset;
  stopDialogMedia();
  elements.assetDialogType.textContent = labelFor(asset.type);
  elements.assetDialogTitle.textContent = asset.title;
  elements.assetDialogDescription.textContent = asset.description || "这是一条可复用的工作台素材。";
  elements.assetDialogMeta.innerHTML = [
    asset.duration ? `<span>时长 · ${escapeHtml(formatTime(asset.duration))}</span>` : "",
    asset.eventTitle ? `<span>事件 · ${escapeHtml(asset.eventTitle)}</span>` : "",
    asset.sourceLabel ? `<span>来源 · ${escapeHtml(asset.sourceLabel)}</span>` : "",
    asset.outputBytes ? `<span>文件 · ${escapeHtml(formatBytes(asset.outputBytes))}</span>` : "",
  ].filter(Boolean).join("");
  if (asset.type === "voice") {
    elements.assetDialogPreview.innerHTML = `<audio controls autoplay src="${escapeHtml(asset.url)}"></audio>`;
  } else if (asset.type === "clip") {
    elements.assetDialogPreview.innerHTML = `<video controls autoplay playsinline src="${escapeHtml(asset.url)}" poster="${escapeHtml(asset.poster || "")}"></video>`;
  } else if (asset.outputUrl) {
    elements.assetDialogPreview.innerHTML = `<video controls autoplay playsinline src="${escapeHtml(asset.outputUrl)}"></video>`;
  } else if (asset.imageUrl) {
    elements.assetDialogPreview.innerHTML = `<img src="${escapeHtml(asset.imageUrl)}" alt="" />`;
  } else {
    elements.assetDialogPreview.innerHTML = `<i data-lucide="layers-3"></i>`;
  }
  const downloadUrl = asset.type === "voice" ? asset.url : asset.type === "clip" ? asset.url : asset.outputUrl;
  elements.assetDialogDownload.hidden = !downloadUrl;
  elements.assetDialogDownload.href = downloadUrl || "#";
  elements.assetDialogDownload.download = asset.title;
  elements.assetDialogOpen.href = asset.type === "voice" ? "/voiceover" : asset.type === "clip" ? `/clips?event=${encodeURIComponent(asset.eventId)}&clip=${encodeURIComponent(asset.file)}` : "/overlays";
  if (!elements.assetDialog.open) elements.assetDialog.showModal();
  refreshIcons();
}

async function exportPack() {
  const selected = [...state.selected].map((key) => findAsset(key)).filter(Boolean).map((asset) => {
    if (asset.type === "voice") return { type: "voice", id: asset.id };
    if (asset.type === "clip") return { type: "clip", eventId: asset.eventId, file: asset.file };
    return { type: "overlay", id: asset.id, output: asset.outputs?.preview ? "preview" : "webm" };
  });
  if (!selected.length) return;
  elements.exportPackButton.disabled = true;
  elements.exportPackButton.querySelector("span").textContent = "正在打包";
  try {
    const data = await requestJson("/api/library/export", { method: "POST", body: JSON.stringify({ items: selected }) });
    const link = document.createElement("a");
    link.href = data.url;
    link.download = data.file;
    link.click();
    showToast(`已生成素材包 · ${data.count} 条素材`);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    elements.exportPackButton.disabled = !state.selected.size;
    elements.exportPackButton.querySelector("span").textContent = "导出素材包";
  }
}

function toggleSelection(key, checked) {
  if (checked) state.selected.add(key);
  else state.selected.delete(key);
  renderGrid();
}

function bindControls() {
  elements.assetSearch.addEventListener("input", () => {
    state.query = elements.assetSearch.value;
    renderGrid();
  });
  document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("is-active", item === button));
    renderGrid();
  }));
  elements.selectVisibleButton.addEventListener("click", () => {
    const visible = visibleAssets();
    const allSelected = visible.length && visible.every((asset) => state.selected.has(asset.key));
    visible.forEach((asset) => allSelected ? state.selected.delete(asset.key) : state.selected.add(asset.key));
    renderGrid();
  });
  elements.exportPackButton.addEventListener("click", exportPack);
  elements.assetGrid.addEventListener("change", (event) => {
    const input = event.target.closest("[data-select-asset]");
    if (input) toggleSelection(input.dataset.selectAsset, input.checked);
  });
  elements.assetGrid.addEventListener("click", (event) => {
    if (event.target.closest("[data-select-asset]")) return;
    const card = event.target.closest("[data-asset-key]");
    if (!card) return;
    const asset = findAsset(card.dataset.assetKey);
    if (event.target.closest("[data-preview]") && asset?.type === "voice") {
      if (elements.libraryAudio.src.endsWith(asset.url) && !elements.libraryAudio.paused) elements.libraryAudio.pause();
      else { elements.libraryAudio.src = asset.url; elements.libraryAudio.play().catch(() => {}); }
      return;
    }
    if (event.target.closest("[data-open-asset]") || event.target.closest("[data-preview]")) openAsset(asset);
  });
  elements.assetDialog.addEventListener("close", stopDialogMedia);
}

async function loadAssets() {
  if (loadAssets.pending) return;
  loadAssets.pending = true;
  try {
    window.workbenchClearPrefetch?.();
    const [voiceovers, clips, overlays] = await Promise.all([
      requestJson("/api/voiceovers"),
      requestJson("/api/clips"),
      requestJson("/api/overlays"),
    ]);
    state.assets = normalizeAssets(voiceovers, clips, overlays);
    elements.libraryStatus.classList.add("ready");
    elements.libraryStatus.querySelector("span").textContent = `工作台素材 · ${state.assets.length} 条`;
    renderGrid();
  } catch (error) {
    elements.libraryStatus.querySelector("span").textContent = "读取失败";
    showToast(error.message, "error");
  } finally {
    loadAssets.pending = false;
  }
}

// 外壳为每个页面保留常驻 iframe，重新切回时不会重新加载页面。
// 监听外壳的可见性通知，每次回到素材总览都重新拉取数据，让新口播/新镜头/新模板立刻出现。
window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin || event.data?.type !== "workbench:visibility") return;
  if (event.data.active) loadAssets();
});

bindControls();
refreshIcons();
loadAssets();
}
