if (!window.__workbenchHostPending) {
const state = {
  events: [],
  selectedEventId: "all",
  selected: null,
  query: "",
  sourceFilter: "all",
  sort: "recent",
  hoverTimer: 0,
};

const elements = {
  newGroupButton: document.querySelector("#newGroupButton"),
  newGroupDialog: document.querySelector("#newGroupDialog"),
  newGroupForm: document.querySelector("#newGroupForm"),
  newGroupTitle: document.querySelector("#newGroupTitle"),
  closeGroupDialogButton: document.querySelector("#closeGroupDialogButton"),
  cancelGroupButton: document.querySelector("#cancelGroupButton"),
  importCapButton: document.querySelector("#importCapButton"),
  capFileInput: document.querySelector("#capFileInput"),
  importCapDialog: document.querySelector("#importCapDialog"),
  importCapForm: document.querySelector("#importCapForm"),
  importEventSelect: document.querySelector("#importEventSelect"),
  importTitlePrefix: document.querySelector("#importTitlePrefix"),
  importFileList: document.querySelector("#importFileList"),
  importProgress: document.querySelector("#importProgress"),
  chooseCapFilesButton: document.querySelector("#chooseCapFilesButton"),
  closeImportDialogButton: document.querySelector("#closeImportDialogButton"),
  cancelImportButton: document.querySelector("#cancelImportButton"),
  eventWorkspaceGrid: document.querySelector("#eventWorkspaceGrid"),
  clipGrid: document.querySelector("#clipGrid"),
  clipCount: document.querySelector("#clipCount"),
  boardTitle: document.querySelector("#boardTitle"),
  boardDescription: document.querySelector("#boardDescription"),
  contextEventId: document.querySelector("#contextEventId"),
  backToEventsButton: document.querySelector("#backToEventsButton"),
  libraryTitle: document.querySelector("#libraryTitle"),
  libraryHint: document.querySelector("#libraryHint"),
  clipStatus: document.querySelector("#clipStatus"),
  clipSearch: document.querySelector("#clipSearch"),
  clipSort: document.querySelector("#clipSort"),
  browser: document.querySelector(".clips-browser"),
  detailPanel: document.querySelector("#detailPanel"),
  detailEmpty: document.querySelector("#detailEmpty"),
  detailContent: document.querySelector("#detailContent"),
  detailTitle: document.querySelector("#detailTitle"),
  detailVideo: document.querySelector("#detailVideo"),
  detailEvent: document.querySelector("#detailEvent"),
  detailDuration: document.querySelector("#detailDuration"),
  detailSource: document.querySelector("#detailSource"),
  detailFile: document.querySelector("#detailFile"),
  detailDescription: document.querySelector("#detailDescription"),
  detailTags: document.querySelector("#detailTags"),
  closeDetailButton: document.querySelector("#closeDetailButton"),
  useInStudioButton: document.querySelector("#useInStudioButton"),
  downloadClipButton: document.querySelector("#downloadClipButton"),
  renameClipButton: document.querySelector("#renameClipButton"),
  deleteClipButton: document.querySelector("#deleteClipButton"),
  detailEditForm: document.querySelector("#detailEditForm"),
  detailTitleInput: document.querySelector("#detailTitleInput"),
  detailGroupSelect: document.querySelector("#detailGroupSelect"),
  detailDescriptionInput: document.querySelector("#detailDescriptionInput"),
  detailTagsInput: document.querySelector("#detailTagsInput"),
  cancelEditButton: document.querySelector("#cancelEditButton"),
  toast: document.querySelector("#toast"),
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

function formatDuration(seconds, detailed = false) {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return "未知";
  if (detailed) return `${Number(seconds).toFixed(1)} 秒`;
  const whole = Math.round(Number(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function showToast(message, type = "info") {
  elements.toast.textContent = message;
  elements.toast.className = `toast show ${type === "error" ? "error" : ""}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.remove("show"), 3000);
}

async function requestJson(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  if (method === "GET") {
    const prefetched = window.workbenchReadPrefetch?.(path);
    if (prefetched) return prefetched;
  } else {
    window.workbenchClearPrefetch?.();
  }
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function setStatus(text, ready) {
  elements.clipStatus.className = `connection-status ${ready ? "ready" : "missing"}`;
  elements.clipStatus.querySelector("span").textContent = text;
}

function eventById(identifier) {
  return state.events.find((event) => event.id === identifier) || null;
}

function allClips() {
  return state.events.flatMap((event) =>
    event.clips.map((clip) => ({
      ...clip,
      eventId: event.id,
      eventTitle: event.title,
      eventDescription: event.description || "",
    })),
  );
}

function findClip(eventId, filename) {
  return allClips().find((clip) => clip.eventId === eventId && clip.file === filename) || null;
}

function queryText() {
  return state.query.trim().toLocaleLowerCase("zh-CN");
}

function clipMatchesQuery(clip, needle) {
  if (!needle) return true;
  return [clip.title, clip.file, clip.description, ...(clip.tags || [])]
    .join(" ")
    .toLocaleLowerCase("zh-CN")
    .includes(needle);
}

function clipsForEvent(event) {
  const needle = queryText();
  const eventMatches = [event.title, event.id, event.description]
    .join(" ")
    .toLocaleLowerCase("zh-CN")
    .includes(needle);
  return event.clips.filter((clip) => {
    if (state.sourceFilter !== "all" && clip.sourceType !== state.sourceFilter) return false;
    return eventMatches || clipMatchesQuery(clip, needle);
  });
}

function eventUpdatedAt(event) {
  return event.clips.reduce((latest, clip) => String(clip.updatedAt || "") > latest ? String(clip.updatedAt || "") : latest, "");
}

function visibleEvents() {
  const needle = queryText();
  const events = state.events
    .map((event) => ({ ...event, visibleClips: clipsForEvent(event) }))
    .filter((event) => {
      if (event.visibleClips.length) return true;
      if (state.sourceFilter !== "all") return false;
      if (!needle) return true;
      return [event.title, event.id, event.description].join(" ").toLocaleLowerCase("zh-CN").includes(needle);
    });
  events.sort((left, right) => {
    if (state.sort === "title") return String(left.title).localeCompare(String(right.title), "zh-CN");
    if (state.sort === "count") return right.visibleClips.length - left.visibleClips.length;
    return eventUpdatedAt(right).localeCompare(eventUpdatedAt(left));
  });
  return events;
}

function visibleClips() {
  const event = eventById(state.selectedEventId);
  if (!event) return [];
  const clips = clipsForEvent(event)
    .map((clip) => ({ ...clip, eventId: event.id, eventTitle: event.title, eventDescription: event.description || "" }));
  clips.sort((left, right) => {
    if (state.sort === "title") return String(left.title).localeCompare(String(right.title), "zh-CN");
    return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
  });
  return clips;
}

function eventPreviewMarkup(event) {
  const clips = event.visibleClips.slice(0, 3);
  if (!clips.length) {
    return `<span class="event-workspace-empty"><i data-lucide="folder"></i></span>`;
  }
  return clips
    .map((clip) => `<img src="${escapeHtml(clip.poster)}" alt="" loading="lazy" />`)
    .join("");
}

function renderEventWorkspaces() {
  const events = visibleEvents();
  const totalClips = events.reduce((sum, event) => sum + event.visibleClips.length, 0);
  elements.clipCount.textContent = `${events.length} 个事件 · ${totalClips} 条素材`;
  if (!events.length) {
    elements.eventWorkspaceGrid.innerHTML = `<div class="clips-empty-state"><i data-lucide="search-x"></i><strong>没有找到事件</strong><span>换个关键词或来源筛选试试</span></div>`;
    refreshIcons();
    return;
  }
  elements.eventWorkspaceGrid.innerHTML = events
    .map((event) => {
      const overlayCount = event.visibleClips.filter((clip) => clip.sourceType === "overlay-template").length;
      return `<button class="event-workspace-card" type="button" data-event-open="${escapeHtml(event.id)}">
        <span class="event-workspace-preview has-${Math.min(3, event.visibleClips.length)}">${eventPreviewMarkup(event)}</span>
        <span class="event-workspace-copy">
          <span class="event-workspace-heading"><strong>${escapeHtml(event.title)}</strong><b>${event.visibleClips.length}</b></span>
          <code>${escapeHtml(event.id)}</code>
          <small>${escapeHtml(event.description || "还没有补充分组说明")}</small>
          <span class="event-workspace-meta"><span><i data-lucide="video"></i>${event.visibleClips.length} 条镜头</span>${overlayCount ? `<span><i data-lucide="layers-3"></i>${overlayCount} 条叠加素材</span>` : ""}</span>
        </span>
      </button>`;
    })
    .join("");
  refreshIcons();
}

function renderContext() {
  const event = eventById(state.selectedEventId);
  const inEvent = Boolean(event);
  elements.backToEventsButton.hidden = !inEvent;
  elements.contextEventId.hidden = !inEvent;
  elements.contextEventId.textContent = inEvent ? `ID: ${event.id}` : "";
  elements.boardTitle.textContent = event?.title || "全部事件";
  elements.boardDescription.textContent = event?.description || "按事件组织可复用的真实画面和叠加素材";
  elements.libraryTitle.textContent = event ? `${event.title}的素材` : "事件工作区";
  elements.libraryHint.textContent = event ? "悬浮预览 · 点击查看详情" : "每个事件只展示一次";
}

function renderClipGrid() {
  const clips = visibleClips();
  elements.clipCount.textContent = `${clips.length} 条素材`;
  if (!clips.length) {
    elements.clipGrid.innerHTML = `<div class="clips-empty-state"><i data-lucide="search-x"></i><strong>这个事件没有匹配的素材</strong><span>换个关键词或来源筛选试试</span></div>`;
    refreshIcons();
    return;
  }
  elements.clipGrid.innerHTML = clips
    .map((clip) => {
      const current = state.selected?.eventId === clip.eventId && state.selected?.file === clip.file ? " is-current" : "";
      const sourceIcon = clip.sourceType === "overlay-template" ? "layers-3" : "video";
      return `<article class="clip-card${current}" data-event="${escapeHtml(clip.eventId)}" data-file="${escapeHtml(clip.file)}" tabindex="0">
        <div class="clip-thumb">
          <img src="${escapeHtml(clip.poster)}" alt="" loading="lazy" />
          <video data-src="${escapeHtml(clip.url)}" poster="${escapeHtml(clip.poster)}" muted playsinline preload="none"></video>
          <span class="clip-source-badge"><i data-lucide="${sourceIcon}"></i>${escapeHtml(clip.sourceLabel)}</span>
          <span class="clip-duration">${formatDuration(clip.duration)}</span>
          <span class="clip-hover-hint"><i data-lucide="play"></i>预览</span>
        </div>
        <div class="clip-copy">
          <strong title="${escapeHtml(clip.title)}">${escapeHtml(clip.title)}</strong>
          <span><i data-lucide="${sourceIcon}"></i>${escapeHtml(clip.sourceLabel)}</span>
        </div>
      </article>`;
    })
    .join("");
  refreshIcons();
}

function renderDetail() {
  const clip = state.selected ? findClip(state.selected.eventId, state.selected.file) : null;
  const hasDetail = Boolean(clip && state.selectedEventId !== "all");
  elements.browser.classList.toggle("has-detail", hasDetail);
  elements.detailPanel.classList.toggle("has-selection", hasDetail);
  elements.detailPanel.hidden = !hasDetail;
  elements.detailEmpty.hidden = hasDetail;
  elements.detailContent.hidden = !hasDetail;
  elements.detailEditForm.hidden = true;
  if (!hasDetail) {
    elements.detailVideo.pause();
    elements.detailVideo.removeAttribute("src");
    elements.detailVideo.load();
    return;
  }
  elements.detailTitle.textContent = clip.title;
  elements.detailEvent.textContent = clip.eventTitle;
  elements.detailDuration.textContent = formatDuration(clip.duration, true);
  elements.detailSource.textContent = clip.sourceLabel;
  elements.detailFile.textContent = clip.file;
  elements.detailDescription.textContent = clip.description || "还没有补充素材说明。";
  elements.detailDescription.classList.toggle("is-empty", !clip.description);
  elements.detailTags.innerHTML = (clip.tags || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
  if (elements.detailVideo.getAttribute("src") !== clip.url) {
    elements.detailVideo.src = clip.url;
    elements.detailVideo.poster = clip.poster;
    elements.detailVideo.load();
  }
  elements.downloadClipButton.href = clip.url;
  elements.downloadClipButton.download = clip.file;
  elements.useInStudioButton.href = "/library";
  elements.detailTitleInput.value = clip.title;
  elements.detailDescriptionInput.value = clip.description || "";
  elements.detailTagsInput.value = (clip.tags || []).join("，");
  elements.detailGroupSelect.innerHTML = state.events
    .map((event) => `<option value="${escapeHtml(event.id)}"${event.id === clip.eventId ? " selected" : ""}>${escapeHtml(event.title)}（${event.clipCount}）</option>`)
    .join("");
  refreshIcons();
}

function renderLibrary({ autoSelect = false } = {}) {
  const inEvent = state.selectedEventId !== "all" && Boolean(eventById(state.selectedEventId));
  elements.eventWorkspaceGrid.hidden = inEvent;
  elements.clipGrid.hidden = !inEvent;
  if (!inEvent) {
    state.selected = null;
    renderEventWorkspaces();
    renderDetail();
    return;
  }
  const clips = visibleClips();
  const selectedVisible = state.selected && clips.some((clip) => clip.eventId === state.selected.eventId && clip.file === state.selected.file);
  if (!selectedVisible) state.selected = autoSelect && clips[0] ? { eventId: clips[0].eventId, file: clips[0].file } : null;
  renderClipGrid();
  renderDetail();
}

function renderAll(options = {}) {
  renderContext();
  renderLibrary(options);
}

function openEvent(eventId) {
  if (!eventById(eventId)) return;
  state.selectedEventId = eventId;
  state.selected = null;
  renderAll({ autoSelect: true });
}

function returnToEvents() {
  state.selectedEventId = "all";
  state.selected = null;
  renderAll();
}

function selectClip(eventId, filename, play = false) {
  const clip = findClip(eventId, filename);
  if (!clip) return;
  state.selected = { eventId, file: filename };
  renderClipGrid();
  renderDetail();
  if (play) elements.detailVideo.play().catch(() => {});
}

function stopCardPreview(card) {
  clearTimeout(state.hoverTimer);
  const video = card?.querySelector("video");
  if (!video) return;
  video.pause();
  video.currentTime = 0;
  card.classList.remove("is-previewing");
}

function startCardPreview(card) {
  clearTimeout(state.hoverTimer);
  state.hoverTimer = setTimeout(() => {
    const video = card.querySelector("video");
    if (!video.src) {
      video.src = video.dataset.src;
      video.load();
    }
    card.classList.add("is-previewing");
    video.currentTime = 0;
    video.play().catch(() => card.classList.remove("is-previewing"));
  }, 220);
}

function applyLibrary(data, selected = null) {
  state.events = data?.events || [];
  if (state.selectedEventId !== "all" && !eventById(state.selectedEventId)) state.selectedEventId = "all";
  if (selected) {
    state.selected = selected;
    state.selectedEventId = selected.eventId;
  }
  if (state.selected && !findClip(state.selected.eventId, state.selected.file)) state.selected = null;
  setStatus(`${data?.clipCount || 0} 条素材`, Boolean(data?.clipCount));
  renderAll({ autoSelect: state.selectedEventId !== "all" && !state.selected });
}

function formatImportSize(bytes) {
  const value = Number(bytes) || 0;
  if (value > 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function populateImportGroups() {
  elements.importEventSelect.innerHTML = state.events
    .map((event) => `<option value="${escapeHtml(event.id)}">${escapeHtml(event.title)}（${event.clipCount}）</option>`)
    .join("");
  if (state.selectedEventId !== "all" && eventById(state.selectedEventId)) {
    elements.importEventSelect.value = state.selectedEventId;
  }
}

function renderImportFiles() {
  const files = [...(elements.capFileInput.files || [])];
  elements.importFileList.innerHTML = files.length
    ? files.map((file) => `<span><i data-lucide="file-video"></i>${escapeHtml(file.name)} · ${formatImportSize(file.size)}</span>`).join("")
    : `<span class="is-empty">还没有选择文件</span>`;
  refreshIcons();
}

function openImportDialog() {
  if (!state.events.length) {
    showToast("请先新建一个事件分组", "error");
    return;
  }
  populateImportGroups();
  elements.importTitlePrefix.value = "";
  elements.importProgress.textContent = "";
  renderImportFiles();
  elements.importCapDialog.showModal();
}

async function uploadCapFile(file, eventId, titlePrefix) {
  const params = new URLSearchParams({
    eventId,
    filename: file.name,
    title: `${titlePrefix}${file.name.replace(/\.mp4$/i, "")}`,
  });
  const response = await fetch(`/api/clips/import?${params}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "video/mp4" },
    body: file,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `导入失败（${response.status}）`);
  return data;
}

async function importCapFiles(event) {
  event.preventDefault();
  const files = [...(elements.capFileInput.files || [])];
  const eventId = elements.importEventSelect.value;
  if (!files.length || !eventId) {
    elements.importProgress.textContent = "请选择 mp4 文件和事件分组";
    return;
  }
  const titlePrefix = elements.importTitlePrefix.value.trim();
  const submitButton = elements.importCapForm.querySelector("button[type=submit]");
  submitButton.disabled = true;
  let latest = null;
  try {
    for (let index = 0; index < files.length; index += 1) {
      elements.importProgress.textContent = `正在导入 ${index + 1}/${files.length} · ${files[index].name}`;
      latest = await uploadCapFile(files[index], eventId, titlePrefix);
    }
    elements.importCapDialog.close();
    elements.capFileInput.value = "";
    state.selectedEventId = eventId;
    applyLibrary(latest?.clips, latest ? { eventId: latest.eventId, file: latest.file } : null);
    showToast(`已导入 ${files.length} 条 Cap 镜头`);
  } catch (error) {
    elements.importProgress.textContent = error.message;
    showToast(error.message, "error");
  } finally {
    submitButton.disabled = false;
  }
}

async function loadClips() {
  const data = await requestJson("/api/clips");
  const params = new URLSearchParams(window.location.search);
  const eventId = params.get("event");
  const file = params.get("clip");
  applyLibrary(data, eventId && file ? { eventId, file } : null);
}

elements.eventWorkspaceGrid.addEventListener("click", (event) => {
  const card = event.target.closest("[data-event-open]");
  if (card) openEvent(card.dataset.eventOpen);
});

elements.backToEventsButton.addEventListener("click", returnToEvents);

elements.clipGrid.addEventListener("click", (event) => {
  const card = event.target.closest(".clip-card");
  if (card) selectClip(card.dataset.event, card.dataset.file, false);
});

elements.clipGrid.addEventListener("keydown", (event) => {
  const card = event.target.closest(".clip-card");
  if (!card || !["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  selectClip(card.dataset.event, card.dataset.file, event.key === " ");
});

elements.clipGrid.addEventListener("pointerover", (event) => {
  const card = event.target.closest(".clip-card");
  if (card && event.pointerType !== "touch") startCardPreview(card);
});

elements.clipGrid.addEventListener("pointerout", (event) => {
  const card = event.target.closest(".clip-card");
  if (card && !card.contains(event.relatedTarget)) stopCardPreview(card);
});

elements.clipSearch.addEventListener("input", () => {
  state.query = elements.clipSearch.value;
  renderAll({ autoSelect: state.selectedEventId !== "all" });
});

elements.clipSort.addEventListener("change", () => {
  state.sort = elements.clipSort.value;
  renderAll({ autoSelect: state.selectedEventId !== "all" });
});

document.querySelectorAll("[data-source-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    state.sourceFilter = button.dataset.sourceFilter;
    document.querySelectorAll("[data-source-filter]").forEach((item) => item.classList.toggle("is-active", item === button));
    renderAll({ autoSelect: state.selectedEventId !== "all" });
  });
});

elements.closeDetailButton.addEventListener("click", () => {
  state.selected = null;
  renderClipGrid();
  renderDetail();
});

elements.renameClipButton.addEventListener("click", () => {
  elements.detailEditForm.hidden = false;
  elements.detailTitleInput.focus();
});

elements.cancelEditButton.addEventListener("click", () => {
  elements.detailEditForm.hidden = true;
});

elements.detailEditForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const clip = state.selected ? findClip(state.selected.eventId, state.selected.file) : null;
  if (!clip) return;
  const tags = elements.detailTagsInput.value.split(/[，,]/).map((item) => item.trim()).filter(Boolean);
  try {
    const data = await requestJson("/api/clips/manage", {
      method: "POST",
      body: JSON.stringify({
        action: "update",
        eventId: clip.eventId,
        file: clip.file,
        title: elements.detailTitleInput.value,
        targetEventId: elements.detailGroupSelect.value,
        description: elements.detailDescriptionInput.value,
        tags,
      }),
    });
    applyLibrary(data.clips, data.selected);
    showToast(data.selected?.eventId === clip.eventId ? "素材信息已保存" : "素材已移动到新分组");
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.deleteClipButton.addEventListener("click", async () => {
  const clip = state.selected ? findClip(state.selected.eventId, state.selected.file) : null;
  if (!clip || !window.confirm(`删除素材“${clip.title}”？这个操作会删除本机视频文件。`)) return;
  try {
    const data = await requestJson("/api/clips/manage", {
      method: "POST",
      body: JSON.stringify({ action: "delete", eventId: clip.eventId, file: clip.file }),
    });
    state.selected = null;
    applyLibrary(data.clips);
    showToast("素材已删除");
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.newGroupButton.addEventListener("click", () => {
  elements.newGroupTitle.value = "";
  elements.newGroupDialog.showModal();
  requestAnimationFrame(() => elements.newGroupTitle.focus());
});

elements.closeGroupDialogButton.addEventListener("click", () => elements.newGroupDialog.close());
elements.cancelGroupButton.addEventListener("click", () => elements.newGroupDialog.close());

elements.newGroupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = elements.newGroupTitle.value.trim();
  if (!title) return;
  try {
    const data = await requestJson("/api/clips/manage", {
      method: "POST",
      body: JSON.stringify({ action: "create-group", title }),
    });
    elements.newGroupDialog.close();
    state.selectedEventId = data.group.id;
    applyLibrary(data.clips);
    showToast(`已新建分组“${data.group.title}”`);
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.importCapButton.addEventListener("click", openImportDialog);
elements.chooseCapFilesButton.addEventListener("click", () => elements.capFileInput.click());
elements.capFileInput.addEventListener("change", renderImportFiles);
elements.closeImportDialogButton.addEventListener("click", () => elements.importCapDialog.close());
elements.cancelImportButton.addEventListener("click", () => elements.importCapDialog.close());
elements.importCapForm.addEventListener("submit", importCapFiles);

document.addEventListener("keydown", (event) => {
  const editing = event.target.matches("input, textarea, select") || event.target.isContentEditable;
  if (editing || event.key !== " ") return;
  if (!state.selected || elements.detailContent.hidden) return;
  event.preventDefault();
  if (elements.detailVideo.paused) elements.detailVideo.play().catch(() => {});
  else elements.detailVideo.pause();
});

loadClips().catch((error) => {
  setStatus("读取失败", false);
  elements.eventWorkspaceGrid.innerHTML = `<div class="clips-empty-state"><strong>${escapeHtml(error.message)}</strong></div>`;
});
refreshIcons();
}
