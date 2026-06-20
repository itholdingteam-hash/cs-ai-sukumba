var systemAiSelectedCustomer = "";
var systemAiRefreshTimer = null;
var systemAiLastTab = "memory-per-customer";
var systemAiMemoryCache = [];
var systemAiSelectedMemory = null;
var systemAiSelectedHistory = [];

function showSystemAiTab(tabName, tabEl) {
  systemAiLastTab = tabName;
  document.querySelectorAll("#section-system-ai .system-ai-tab-card").forEach(function (tab) {
    tab.classList.remove("active");
  });

  if (tabEl) tabEl.classList.add("active");

  document.querySelectorAll("#section-system-ai .system-ai-panel").forEach(function (panel) {
    panel.classList.toggle("active", panel.getAttribute("data-system-ai-tab") === tabName);
  });

  if (tabName === "conversation-scoring") loadSystemAiScoring();
  if (tabName === "learning-bank") loadSystemAiItems("learning");
  if (tabName === "memory-per-customer") loadSystemAiMemory();
  if (tabName === "review-approval") loadSystemAiItems("review");
  if (tabName === "skill-system") loadSystemAiItems("skill");
  if (tabName === "training-inbox") loadSystemAiItems("training");
  if (tabName === "human-chat") loadSystemAiRecentChats(true);
  if (tabName === "human-handoff") loadSystemAiHandoffs();
}

function normalizeSystemAiWaNumber(value) {
  var number = String(value || "").replace(/\D/g, "");
  if (number.startsWith("0")) return "62" + number.slice(1);
  if (number.startsWith("8")) return "62" + number;
  return number;
}

function systemAiIsVisible() {
  var section = document.getElementById("section-system-ai");
  return !!(section && section.classList.contains("active"));
}

function renderSystemAiMessage(content) {
  return escHtml(content || "-").replace(/\n/g, "<br>");
}

function systemAiItemTypeLabel(type) {
  return {
    learning: "Learning Bank",
    review: "Review Approval",
    skill: "Skill System",
    training: "Training Inbox",
  }[type] || type;
}

function systemAiProfileValue(profile, keys) {
  profile = profile || {};
  for (var i = 0; i < keys.length; i++) {
    var value = profile[keys[i]];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

function systemAiStatusBadge(status) {
  var value = status || "draft";
  var cls = value === "approved" || value === "active" ? "badge-green"
    : value === "archived" || value === "rejected" || value === "inactive" ? "badge-red"
    : value === "review" || value === "pending" ? "badge-amber"
    : "badge-blue";
  return '<span class="badge ' + cls + '">' + escHtml(value) + '</span>';
}

async function loadSystemAiScoring() {
  var list = document.getElementById("system-ai-scoring-list");
  if (!list) return;
  list.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:12px 0">Menghitung skor percakapan...</div>';
  try {
    var data = await api.get("/api/system-ai/scoring?limit=30");
    var items = Array.isArray(data.items) ? data.items : [];
    document.getElementById("system-ai-score-average").textContent = data.average_score || 0;
    document.getElementById("system-ai-score-count").textContent = items.length;
    document.getElementById("system-ai-score-review").textContent = data.needs_review || 0;
    if (!items.length) {
      list.innerHTML = '<div class="empty"><div class="empty-icon">&#x1F4AF;</div><div class="empty-text">Belum ada log percakapan untuk dinilai.</div></div>';
      return;
    }
    list.innerHTML = items.map(function (item) {
      var reasons = (item.reasons || []).map(function (r) { return '<li>' + escHtml(r) + '</li>'; }).join("");
      return '<div class="log-card system-ai-score-card">'
        + '<div class="log-header"><span class="log-number">' + escHtml(item.user_number || "-") + '</span><span class="log-time">' + escHtml(item.timestamp || "") + '</span></div>'
        + '<div class="system-ai-row-meta">' + systemAiStatusBadge(item.score_status) + '<span>Skor ' + escHtml(item.score) + '/100</span></div>'
        + '<div class="log-message log-user">' + renderSystemAiMessage(item.user_message) + '</div>'
        + '<div class="log-message log-ai">' + renderSystemAiMessage(item.ai_response) + '</div>'
        + '<div class="system-ai-reasons"><ul>' + reasons + '</ul></div>'
        + '<div class="system-ai-log-actions">'
        + '<button class="btn btn-ghost btn-sm" type="button" onclick="createTrainingFromScore(' + escHtml(item.id) + ')">Kirim ke Training Inbox</button>'
        + '</div>'
        + '</div>';
    }).join("");
    window.systemAiScoringCache = items;
  } catch (e) {
    list.innerHTML = '<div class="system-ai-error">Gagal memuat scoring percakapan.</div>';
  }
}

async function createTrainingFromScore(logId) {
  var items = window.systemAiScoringCache || [];
  var item = items.find(function (row) { return String(row.id) === String(logId); });
  if (!item) return;
  await api.post("/api/system-ai/items", {
    item_type: "training",
    title: "Review percakapan skor " + item.score + " - " + (item.user_number || "customer"),
    content: "Customer:\n" + (item.user_message || "") + "\n\nAI:\n" + (item.ai_response || "") + "\n\nCatatan:\n" + (item.reasons || []).join(", "),
    status: "pending",
    tags: "scoring,auto-review",
    source_user_number: item.user_number || "",
  });
  toast("Masuk ke Training Inbox");
}

function systemAiField(type, field) {
  return document.getElementById("system-ai-" + type + "-" + field);
}

async function createSystemAiItem(type) {
  var title = systemAiField(type, "title");
  var content = systemAiField(type, "content");
  var tags = systemAiField(type, "tags");
  if (!title || !content || !title.value.trim()) {
    toast("Judul wajib diisi", "error");
    return;
  }
  var defaultStatus = type === "learning" ? "active" : (type === "skill" ? "active" : "pending");
  await api.post("/api/system-ai/items", {
    item_type: type,
    title: title.value.trim(),
    content: content.value.trim(),
    tags: tags ? tags.value.trim() : "",
    status: defaultStatus,
  });
  title.value = "";
  content.value = "";
  if (tags) tags.value = "";
  toast(systemAiItemTypeLabel(type) + " disimpan");
  loadSystemAiItems(type);
}

function renderSystemAiItem(item) {
  var actions = "";
  if (item.item_type === "review") {
    actions += '<button class="btn btn-primary btn-sm" type="button" onclick="approveSystemAiReview(' + item.id + ')">Approve</button>';
    actions += "<button class=\"btn btn-ghost btn-sm\" type=\"button\" onclick=\"updateSystemAiItemStatus(" + item.id + ", 'rejected', 'review')\">Tolak</button>";
  } else if (item.item_type === "skill") {
    actions += "<button class=\"btn btn-ghost btn-sm\" type=\"button\" onclick=\"updateSystemAiItemStatus(" + item.id + ", 'active', 'skill')\">Aktif</button>";
    actions += "<button class=\"btn btn-ghost btn-sm\" type=\"button\" onclick=\"updateSystemAiItemStatus(" + item.id + ", 'inactive', 'skill')\">Nonaktif</button>";
  } else if (item.item_type === "training") {
    actions += '<button class="btn btn-primary btn-sm" type="button" onclick="moveTrainingToReview(' + item.id + ')">Kirim Review</button>';
  } else {
    actions += "<button class=\"btn btn-ghost btn-sm\" type=\"button\" onclick=\"updateSystemAiItemStatus(" + item.id + ", 'active', 'learning')\">Aktif</button>";
    actions += "<button class=\"btn btn-ghost btn-sm\" type=\"button\" onclick=\"updateSystemAiItemStatus(" + item.id + ", 'archived', 'learning')\">Arsip</button>";
  }
  actions += "<button class=\"btn btn-danger btn-sm\" type=\"button\" onclick=\"deleteSystemAiItem(" + item.id + ", '" + escHtml(item.item_type) + "')\">Hapus</button>";
  return '<div class="system-ai-item">'
    + '<div class="system-ai-item-head"><div><div class="system-ai-item-title">' + escHtml(item.title) + '</div><div class="system-ai-item-meta">' + escHtml(item.tags || "-") + ' &middot; ' + escHtml(item.updated_at || "") + '</div></div>' + systemAiStatusBadge(item.status) + '</div>'
    + '<div class="system-ai-item-content">' + renderSystemAiMessage(item.content) + '</div>'
    + (item.source_user_number ? '<div class="system-ai-item-meta">Source: ' + escHtml(item.source_user_number) + '</div>' : '')
    + '<div class="system-ai-log-actions">' + actions + '</div>'
    + '</div>';
}

async function loadSystemAiItems(type) {
  var list = document.getElementById("system-ai-" + type + "-list");
  if (!list) return;
  list.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:12px 0">Memuat ' + escHtml(systemAiItemTypeLabel(type)) + '...</div>';
  try {
    var data = await api.get("/api/system-ai/items?type=" + encodeURIComponent(type));
    var items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) {
      list.innerHTML = '<div class="empty"><div class="empty-icon">&#x1F4ED;</div><div class="empty-text">Belum ada data.</div></div>';
      return;
    }
    list.innerHTML = items.map(renderSystemAiItem).join("");
  } catch (e) {
    list.innerHTML = '<div class="system-ai-error">Gagal memuat data.</div>';
  }
}

async function updateSystemAiItemStatus(id, status, type) {
  await api.put("/api/system-ai/items/" + id, { status: status });
  toast("Status diperbarui");
  loadSystemAiItems(type);
}

async function deleteSystemAiItem(id, type) {
  if (!confirm("Hapus item ini?")) return;
  await api.delete("/api/system-ai/items/" + id);
  toast("Item dihapus");
  loadSystemAiItems(type);
}

async function approveSystemAiReview(id) {
  await api.put("/api/system-ai/items/" + id, { status: "approved" });
  var data = await api.get("/api/system-ai/items?type=review");
  var item = (data.items || []).find(function (row) { return row.id === id; });
  if (item) {
    await api.post("/api/system-ai/items", {
      item_type: "learning",
      title: item.title,
      content: item.content,
      tags: item.tags,
      status: "active",
      source_user_number: item.source_user_number || "",
    });
  }
  toast("Review approved dan masuk Learning Bank");
  loadSystemAiItems("review");
}

async function moveTrainingToReview(id) {
  var data = await api.get("/api/system-ai/items?type=training");
  var item = (data.items || []).find(function (row) { return row.id === id; });
  if (!item) return;
  await api.post("/api/system-ai/items", {
    item_type: "review",
    title: item.title,
    content: item.content,
    tags: item.tags,
    status: "pending",
    source_user_number: item.source_user_number || "",
  });
  await api.put("/api/system-ai/items/" + id, { status: "review" });
  toast("Training case dikirim ke Review Approval");
  loadSystemAiItems("training");
}

async function loadSystemAiMemory() {
  var list = document.getElementById("system-ai-memory-list");
  if (!list) return;
  list.innerHTML = '<div class="system-ai-loading">Memuat memory customer...</div>';
  try {
    var data = await api.get("/api/system-ai/memory?limit=80");
    var memories = Array.isArray(data.memories) ? data.memories : [];
    systemAiMemoryCache = memories;
    var total = document.getElementById("system-ai-memory-total");
    if (total) total.textContent = memories.length;
    if (!memories.length) {
      list.innerHTML = '<div class="empty"><div class="empty-text">Belum ada memory customer.</div></div>';
      setSystemAiMemoryDetail(null);
      return;
    }
    renderSystemAiMemoryList(memories);
    var selectedNumber = systemAiSelectedMemory && systemAiSelectedMemory.user_number;
    var next = memories.find(function (m) { return String(m.user_number) === String(selectedNumber); }) || memories[0];
    await selectSystemAiMemory(next.user_number);
  } catch (e) {
    list.innerHTML = '<div class="system-ai-error">Gagal memuat memory customer.</div>';
  }
}

function renderSystemAiMemoryList(memories) {
  var list = document.getElementById("system-ai-memory-list");
  if (!list) return;
  if (!memories.length) {
    list.innerHTML = '<div class="empty"><div class="empty-text">Customer tidak ditemukan.</div></div>';
    return;
  }
  var selected = systemAiSelectedMemory && systemAiSelectedMemory.user_number;
  list.innerHTML = memories.map(function (m) {
    var profile = m.profile || {};
    var name = systemAiProfileValue(profile, ["name", "nama", "customer_name"]) || m.user_number;
    var stage = systemAiProfileValue(profile, ["active_stage", "stage", "follow_up_stage"]) || "-";
    var context = systemAiProfileValue(profile, ["customer_context", "complaint", "keluhan_utama", "main_complaint"]) || (m.summary || "");
    var isActive = String(m.user_number) === String(selected);
    return '<button class="system-ai-memory-row' + (isActive ? ' active' : '') + '" type="button" onclick="selectSystemAiMemory(\'' + escHtml(m.user_number) + '\')">'
      + '<strong>' + escHtml(name) + '</strong>'
      + '<span>' + escHtml(m.user_number) + '</span>'
      + '<div><span>' + escHtml(stage) + '</span><time>' + escHtml(m.updated_at || m.latest_timestamp || "-") + '</time></div>'
      + '<small>' + escHtml(String(context || "-").slice(0, 115)) + '</small>'
      + '</button>';
  }).join("");
}

function filterSystemAiMemoryList() {
  var input = document.getElementById("system-ai-memory-search");
  var q = String(input && input.value || "").toLowerCase().trim();
  var filtered = systemAiMemoryCache.filter(function (m) {
    var profile = m.profile || {};
    var haystack = [
      m.user_number,
      m.summary,
      m.latest_content,
      profile.name,
      profile.nama,
      profile.customer_name,
      profile.customer_context,
      profile.complaint,
      profile.keluhan_utama,
      profile.active_stage,
    ].join(" ").toLowerCase();
    return !q || haystack.indexOf(q) >= 0;
  });
  renderSystemAiMemoryList(filtered);
}

function setSystemAiMemoryDetail(memory) {
  systemAiSelectedMemory = memory;
  var profile = memory && memory.profile || {};
  var selectedNumber = memory && memory.user_number || "";
  var fields = {
    "system-ai-memory-number": selectedNumber,
    "system-ai-memory-name": systemAiProfileValue(profile, ["name", "nama", "customer_name"]),
    "system-ai-memory-age": systemAiProfileValue(profile, ["age", "usia"]),
    "system-ai-memory-complaint": systemAiProfileValue(profile, ["complaint", "keluhan_utama", "main_complaint", "customer_context"]),
    "system-ai-memory-stage": systemAiProfileValue(profile, ["active_stage", "stage", "follow_up_stage"]),
    "system-ai-memory-objection": systemAiProfileValue(profile, ["objection", "keberatan", "main_objection"]),
    "system-ai-memory-summary": memory && memory.summary || "",
  };
  Object.keys(fields).forEach(function (id) {
    var node = document.getElementById(id);
    if (node) node.value = fields[id] || "";
  });
  var selected = document.getElementById("system-ai-memory-selected-number");
  if (selected) selected.textContent = selectedNumber || "-";
  renderSystemAiProfileKeys(profile);
  renderSystemAiMemoryHistory([]);
}

function renderSystemAiProfileKeys(profile) {
  var wrap = document.getElementById("system-ai-memory-profile-keys");
  if (!wrap) return;
  var keys = Object.keys(profile || {}).filter(function (key) {
    return profile[key] !== undefined && profile[key] !== null && String(profile[key]).trim() !== "";
  });
  if (!keys.length) {
    wrap.innerHTML = '<span class="system-ai-muted">Belum ada profile key.</span>';
    return;
  }
  wrap.innerHTML = keys.map(function (key) {
    return '<span>' + escHtml(key) + '</span>';
  }).join("");
}

function renderSystemAiMemoryHistory(history) {
  var wrap = document.getElementById("system-ai-memory-history");
  var count = document.getElementById("system-ai-memory-history-count");
  if (count) count.textContent = history.length;
  if (!wrap) return;
  if (!history.length) {
    wrap.innerHTML = '<div class="empty"><div class="empty-text">Belum ada history terakhir.</div></div>';
    return;
  }
  wrap.innerHTML = history.map(function (msg) {
    return '<article class="system-ai-history-row">'
      + '<div><strong>' + escHtml(systemAiRoleLabel(msg.role)) + '</strong><time>' + escHtml(msg.timestamp || "") + '</time></div>'
      + '<p>' + renderSystemAiMessage(msg.content) + '</p>'
      + '</article>';
  }).join("");
}

async function selectSystemAiMemory(number) {
  var memory = systemAiMemoryCache.find(function (m) { return String(m.user_number) === String(number); });
  if (!memory) return;
  setSystemAiMemoryDetail(memory);
  renderSystemAiMemoryList(systemAiMemoryCache);
  try {
    var history = await api.get("/api/conversation/history/" + encodeURIComponent(number) + "?limit=20");
    systemAiSelectedHistory = Array.isArray(history) ? history : [];
    renderSystemAiMemoryHistory(systemAiSelectedHistory);
  } catch (e) {
    renderSystemAiMemoryHistory([]);
  }
}

async function reloadSelectedSystemAiMemory() {
  if (!systemAiSelectedMemory || !systemAiSelectedMemory.user_number) {
    toast("Pilih customer dulu", "error");
    return;
  }
  await loadSystemAiMemory();
}

async function saveSystemAiMemoryDetail() {
  var number = (document.getElementById("system-ai-memory-number") || {}).value || "";
  if (!number) {
    toast("Pilih customer dulu", "error");
    return;
  }
  var current = systemAiSelectedMemory && systemAiSelectedMemory.profile || {};
  var profile = Object.assign({}, current, {
    name: (document.getElementById("system-ai-memory-name") || {}).value || "",
    age: (document.getElementById("system-ai-memory-age") || {}).value || "",
    complaint: (document.getElementById("system-ai-memory-complaint") || {}).value || "",
    active_stage: (document.getElementById("system-ai-memory-stage") || {}).value || "",
    objection: (document.getElementById("system-ai-memory-objection") || {}).value || "",
  });
  var summary = (document.getElementById("system-ai-memory-summary") || {}).value || "";
  try {
    await api.post("/api/customer-profile/" + encodeURIComponent(number), {
      profile: profile,
      summary: summary,
    });
    toast("Memory disimpan");
    await loadSystemAiMemory();
  } catch (e) {
    toast(e.message || "Gagal menyimpan memory", "error");
  }
}

async function resetSelectedSystemAiMemory() {
  var number = (document.getElementById("system-ai-memory-number") || {}).value || "";
  if (!number) {
    toast("Pilih customer dulu", "error");
    return;
  }
  await resetSystemAiMemory(number);
}

function openSystemAiChatFromMemory(number) {
  var tab = document.querySelector("#section-system-ai .system-ai-tab-card[onclick*='human-handoff']");
  showSystemAiTab("human-handoff", tab);
  setSystemAiHandoff(true, number);
}

async function resetSystemAiMemory(number) {
  if (!confirm("Reset memory dan history untuk " + number + "?")) return;
  await api.delete("/api/customer-memory/" + encodeURIComponent(number));
  toast("Memory di-reset");
  loadSystemAiMemory();
}

function systemAiRoleLabel(role) {
  if (role === "assistant") return "CS/AI";
  if (role === "system_note") return "Sistem";
  return "Customer";
}

function systemAiConversationStatus(item) {
  return item.human_handoff_active
    ? '<span class="badge badge-amber">CS Organik</span>'
    : '<span class="badge badge-teal">AI aktif</span>';
}

function renderSystemAiConversation(item) {
  var rawNumber = String(item.normalized_user_number || item.user_number || "");
  var latest = item.latest_content || "-";
  return '<div class="log-card system-ai-log-card' + (item.human_handoff_active ? ' handoff-active' : '') + '">'
    + '<div class="log-header">'
    + '<span class="log-number">' + escHtml(rawNumber || "-") + '</span>'
    + '<span class="log-time">' + escHtml(item.latest_timestamp || "") + '</span>'
    + '</div>'
    + '<div class="system-ai-row-meta">'
    + systemAiConversationStatus(item)
    + '<span>' + escHtml(systemAiRoleLabel(item.latest_role)) + '</span>'
    + '<span>' + escHtml(item.message_count || 0) + ' pesan</span>'
    + '</div>'
    + '<div class="system-ai-preview">' + renderSystemAiMessage(latest) + '</div>'
    + '<div class="system-ai-log-actions">'
    + '<button class="btn btn-ghost btn-sm system-ai-history-btn" type="button" data-number="' + escHtml(rawNumber) + '">Buka Chat</button>'
    + '<button class="btn btn-ghost btn-sm system-ai-takeover-btn" type="button" data-number="' + escHtml(rawNumber) + '" data-active="' + (item.human_handoff_active ? "0" : "1") + '">'
    + (item.human_handoff_active ? "Lepas ke AI" : "Ambil Alih")
    + '</button>'
    + '</div>'
    + '</div>';
}

function bindSystemAiConversationButtons() {
  document.querySelectorAll("#system-ai-recent-chats .system-ai-history-btn, #system-ai-handoff-list .system-ai-history-btn").forEach(function (button) {
    button.onclick = function () {
      loadSystemAiCustomerHistory(button.getAttribute("data-number") || "");
    };
  });

  document.querySelectorAll("#system-ai-recent-chats .system-ai-takeover-btn, #system-ai-handoff-list .system-ai-takeover-btn").forEach(function (button) {
    button.onclick = function () {
      var number = button.getAttribute("data-number") || "";
      var active = button.getAttribute("data-active") === "1";
      setSystemAiHandoff(active, number);
    };
  });
}

async function loadSystemAiRecentChats(force) {
  var list = document.getElementById("system-ai-recent-chats");
  var empty = document.getElementById("system-ai-recent-empty");
  if (!list || !empty) return;

  if (force) {
    list.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:12px 0">Memuat chat realtime...</div>';
  }
  empty.style.display = "none";

  try {
    var data = await api.get("/api/conversation/recent?limit=30");
    var conversations = Array.isArray(data.conversations) ? data.conversations : [];
    if (!conversations.length) {
      list.innerHTML = "";
      empty.style.display = "flex";
      return;
    }

    list.innerHTML = conversations.map(renderSystemAiConversation).join("");
    bindSystemAiConversationButtons();
  } catch (e) {
    list.innerHTML = '<div class="system-ai-error">Gagal memuat chat realtime.</div>';
  }
}

function renderSystemAiThread(history, number) {
  if (!history.length) {
    return '<div class="empty">'
      + '<div class="empty-icon">&#x1F4ED;</div>'
      + '<div class="empty-text">Belum ada history untuk ' + escHtml(number) + '.</div>'
      + '</div>';
  }

  return '<div class="system-ai-thread-head">History ' + escHtml(number) + '</div>'
    + history.map(function (msg) {
      var role = msg.role === "assistant" ? "ai" : (msg.role === "system_note" ? "system" : "user");
      var label = systemAiRoleLabel(msg.role);
      return '<div class="system-ai-thread-msg ' + role + '">'
        + '<div class="system-ai-thread-meta">'
        + '<span>' + label + '</span>'
        + '<span>' + escHtml(msg.timestamp || "") + '</span>'
        + '</div>'
        + '<div class="system-ai-thread-bubble">' + renderSystemAiMessage(msg.content) + '</div>'
        + '</div>';
    }).join("");
}

function setSystemAiSelectedCustomer(number) {
  systemAiSelectedCustomer = String(number || "").trim();
  var selected = document.getElementById("system-ai-selected-customer");
  if (selected) {
    selected.textContent = systemAiSelectedCustomer
      ? "Customer dipilih: " + systemAiSelectedCustomer
      : "Belum ada customer dipilih.";
  }
}

async function loadSystemAiCustomerHistory(numberFromButton) {
  var input = document.getElementById("system-ai-history-number");
  var output = document.getElementById("system-ai-customer-history");
  if (!output) return;

  var number = numberFromButton
    ? String(numberFromButton).trim()
    : normalizeSystemAiWaNumber(input && input.value);
  if (!number) {
    toast("Isi nomor WA dulu", "error");
    return;
  }

  if (input) input.value = number;
  setSystemAiSelectedCustomer(number);
  output.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:12px 0">Memuat history ' + escHtml(number) + '...</div>';

  try {
    var history = await api.get("/api/conversation/history/" + encodeURIComponent(number) + "?limit=80");
    if (!Array.isArray(history)) history = [];
    output.innerHTML = renderSystemAiThread(history, number);
    output.scrollTop = output.scrollHeight;
  } catch (e) {
    output.innerHTML = '<div class="system-ai-error">Gagal memuat history customer.</div>';
  }
}

async function setSystemAiHandoff(active, numberFromButton) {
  var number = String(numberFromButton || systemAiSelectedCustomer || "").trim();
  if (!number) {
    toast("Pilih customer dulu", "error");
    return;
  }

  try {
    await api.post("/api/human-handoff/" + encodeURIComponent(number), {
      active: !!active,
      note: active ? "Diambil alih dari dashboard Sistem AI" : "Dilepas kembali ke AI",
    });
    toast(active ? "Handover CS Organik aktif" : "AI aktif kembali");
    await loadSystemAiRecentChats();
    await loadSystemAiHandoffs();
    await loadSystemAiCustomerHistory(number);
  } catch (e) {
    toast(e.message || "Gagal mengubah handover", "error");
  }
}

async function sendSystemAiManualReply() {
  var textarea = document.getElementById("system-ai-manual-message");
  var message = textarea ? textarea.value.trim() : "";
  var number = systemAiSelectedCustomer;
  if (!number) {
    toast("Pilih customer dulu", "error");
    return;
  }
  if (!message) {
    toast("Isi pesan balasan dulu", "error");
    return;
  }

  try {
    await api.post("/api/manual-reply", {
      user_number: number,
      message: message,
    });
    if (textarea) textarea.value = "";
    toast("Balasan manual terkirim");
    await loadSystemAiCustomerHistory(number);
    await loadSystemAiRecentChats();
  } catch (e) {
    toast(e.message || "Gagal kirim balasan manual", "error");
  }
}

function renderSystemAiHandoff(item) {
  var rawNumber = String(item.user_number || "");
  return '<div class="log-card system-ai-log-card handoff-active">'
    + '<div class="log-header">'
    + '<span class="log-number">' + escHtml(rawNumber || "-") + '</span>'
    + '<span class="log-time">' + escHtml(item.handoff_updated_at || item.latest_timestamp || "") + '</span>'
    + '</div>'
    + '<div class="system-ai-row-meta">'
    + '<span class="badge badge-amber">CS Organik</span>'
    + (item.handoff_note ? '<span>' + escHtml(item.handoff_note) + '</span>' : '')
    + '</div>'
    + '<div class="system-ai-preview">' + renderSystemAiMessage(item.latest_content || item.summary || "Menunggu balasan CS Organik.") + '</div>'
    + '<div class="system-ai-log-actions">'
    + '<button class="btn btn-ghost btn-sm system-ai-history-btn" type="button" data-number="' + escHtml(rawNumber) + '">Buka Chat</button>'
    + '<button class="btn btn-ghost btn-sm system-ai-takeover-btn" type="button" data-number="' + escHtml(rawNumber) + '" data-active="0">Lepas ke AI</button>'
    + '</div>'
    + '</div>';
}

async function loadSystemAiHandoffs() {
  var list = document.getElementById("system-ai-handoff-list");
  var empty = document.getElementById("system-ai-handoff-empty");
  if (!list || !empty) return;

  try {
    var data = await api.get("/api/human-handoffs");
    var handoffs = Array.isArray(data.handoffs) ? data.handoffs : [];
    if (!handoffs.length) {
      list.innerHTML = "";
      empty.style.display = "flex";
      return;
    }
    empty.style.display = "none";
    list.innerHTML = handoffs.map(renderSystemAiHandoff).join("");
    bindSystemAiConversationButtons();
  } catch (e) {
    list.innerHTML = '<div class="system-ai-error">Gagal memuat antrian handover.</div>';
  }
}

function startSystemAiRealtime() {
  if (systemAiRefreshTimer) return;
  systemAiRefreshTimer = window.setInterval(function () {
    if (!systemAiIsVisible()) return;
    if (systemAiLastTab === "human-chat") loadSystemAiRecentChats();
    if (systemAiLastTab === "human-handoff") loadSystemAiHandoffs();
    if (systemAiSelectedCustomer && systemAiLastTab === "human-chat") {
      loadSystemAiCustomerHistory(systemAiSelectedCustomer);
    }
  }, 5000);
}

document.addEventListener("DOMContentLoaded", startSystemAiRealtime);
