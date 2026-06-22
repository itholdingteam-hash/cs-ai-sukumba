var selectedMemoryCustomer = "";
var selectedMemoryDisplayNumber = "";

function confirmAiSystemAction(message, detail) {
  return new Promise(function (resolve) {
    var existing = document.getElementById("ai-confirm-overlay");
    if (existing) existing.remove();

    var overlay = document.createElement("div");
    overlay.id = "ai-confirm-overlay";
    overlay.className = "ai-confirm-overlay";
    overlay.innerHTML = '<div class="ai-confirm-dialog" role="dialog" aria-modal="true">'
      + '<div class="ai-confirm-icon">!</div>'
      + '<div class="ai-confirm-copy"><h3>Apakah Anda yakin?</h3><p>' + escHtml(message || "Lanjutkan aksi ini?") + '</p>'
      + (detail ? '<small>' + escHtml(detail) + '</small>' : '') + '</div>'
      + '<div class="ai-confirm-actions"><button class="btn btn-ghost" type="button" data-confirm="no">Tidak</button><button class="btn btn-danger" type="button" data-confirm="yes">Ya, lanjutkan</button></div>'
      + '</div>';
    document.body.appendChild(overlay);

    function close(value) {
      overlay.remove();
      resolve(value);
    }

    overlay.querySelector('[data-confirm="no"]').onclick = function () { close(false); };
    overlay.querySelector('[data-confirm="yes"]').onclick = function () { close(true); };
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) close(false);
    });
    document.addEventListener("keydown", function onKey(event) {
      if (!document.getElementById("ai-confirm-overlay")) {
        document.removeEventListener("keydown", onKey);
        return;
      }
      if (event.key === "Escape") {
        document.removeEventListener("keydown", onKey);
        close(false);
      }
    });
  });
}


function showAiSystemTab(tabName) {
  document.querySelectorAll(".ai-system-tab").forEach(function (tab) {
    var isActive = tab.getAttribute("data-ai-system-tab") === tabName;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  document.querySelectorAll(".ai-system-panel").forEach(function (panel) {
    panel.classList.remove("active");
  });

  var target = document.getElementById("ai-system-" + tabName);
  if (target) target.classList.add("active");
  if (tabName === "overview") loadAiSystemOverview();
  if (tabName === "memory-customer") loadMemoryCustomers();
  if (tabName === "learning-bank") loadLearningBank();
  if (tabName === "skill-system") loadAiSkills();
  if (tabName === "review-approval") loadReviewApproval();
  if (tabName === "conversation-scoring") loadConversationScoring();
  if (tabName === "human-handoff") { loadHandoffSettings(); loadHumanHandoffs(); }
  if (tabName === "human-chat") loadHumanChatTickets();
}

function initAiSystemTabs() {
  document.querySelectorAll(".ai-system-tab").forEach(function (tab) {
    if (tab.dataset.bound === "true") return;
    tab.dataset.bound = "true";
    tab.addEventListener("click", function () {
      showAiSystemTab(tab.getAttribute("data-ai-system-tab"));
    });
  });

  var search = document.getElementById("memory-search-input");
  if (search && search.dataset.bound !== "true") {
    search.dataset.bound = "true";
    search.addEventListener("keydown", function (event) {
      if (event.key === "Enter") loadMemoryCustomers();
    });
  }

  var learningSearch = document.getElementById("learning-search-input");
  if (learningSearch && learningSearch.dataset.bound !== "true") {
    learningSearch.dataset.bound = "true";
    learningSearch.addEventListener("keydown", function (event) {
      if (event.key === "Enter") loadLearningBank();
    });
  }

  var skillSearch = document.getElementById("skill-search-input");
  if (skillSearch && skillSearch.dataset.bound !== "true") {
    skillSearch.dataset.bound = "true";
    skillSearch.addEventListener("keydown", function (event) {
      if (event.key === "Enter") loadAiSkills();
    });
  }

  var reviewSearch = document.getElementById("review-search-input");
  if (reviewSearch && reviewSearch.dataset.bound !== "true") {
    reviewSearch.dataset.bound = "true";
    reviewSearch.addEventListener("keydown", function (event) {
      if (event.key === "Enter") loadReviewApproval();
    });
  }

  var scoringSearch = document.getElementById("scoring-search-input");
  if (scoringSearch && scoringSearch.dataset.bound !== "true") {
    scoringSearch.dataset.bound = "true";
    scoringSearch.addEventListener("keydown", function (event) {
      if (event.key === "Enter") loadConversationScoring();
    });
  }

  var handoffSearch = document.getElementById("handoff-search-input");
  if (handoffSearch && handoffSearch.dataset.bound !== "true") {
    handoffSearch.dataset.bound = "true";
    handoffSearch.addEventListener("keydown", function (event) {
      if (event.key === "Enter") loadHumanHandoffs();
    });
  }

  var humanChatSearch = document.getElementById("human-chat-search-input");
  if (humanChatSearch && humanChatSearch.dataset.bound !== "true") {
    humanChatSearch.dataset.bound = "true";
    humanChatSearch.addEventListener("keydown", function (event) {
      if (event.key === "Enter") loadHumanChatTickets();
    });
  }

  var humanChatMessage = document.getElementById("human-chat-message");
  if (humanChatMessage && humanChatMessage.dataset.bound !== "true") {
    humanChatMessage.dataset.bound = "true";
    humanChatMessage.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) sendHumanChatMessage();
    });
  }

  showAiSystemTab("overview");
}


function setOverviewText(id, value) {
  var el = document.getElementById(id);
  if (el) el.textContent = value ?? "0";
}

function overviewHealthLabel(value, warnAt, dangerAt) {
  value = Number(value || 0);
  if (value >= dangerAt) return "Perlu tindakan";
  if (value >= warnAt) return "Perlu dipantau";
  return "Aman";
}

async function fetchOverviewJson(url, fallback) {
  try {
    var res = await fetch(url);
    if (!res.ok) return fallback;
    return await res.json();
  } catch (error) {
    return fallback;
  }
}

async function loadAiSystemOverview() {
  var priority = document.getElementById("overview-priority-list");
  if (priority) priority.innerHTML = '<div class="memory-empty">Memuat prioritas...</div>';
  var results = await Promise.all([
    fetchOverviewJson("/api/ai-system/memory/customers?limit=500", {customers: []}),
    fetchOverviewJson("/api/ai-system/learning-bank", {items: [], counts: {}}),
    fetchOverviewJson("/api/ai-system/skills", {items: [], counts: {}}),
    fetchOverviewJson("/api/ai-system/review-approval", {items: [], counts: {}}),
    fetchOverviewJson("/api/ai-system/conversation-scoring?limit=1", {counts: {}, total_logs: 0}),
    fetchOverviewJson("/api/ai-system/human-handoff", {items: [], counts: {}, total: 0}),
    fetchOverviewJson("/api/ai-system/human-handoff?status=in_progress", {items: [], count: 0})
  ]);
  var memory = results[0] || {};
  var learning = results[1] || {};
  var skills = results[2] || {};
  var review = results[3] || {};
  var scoring = results[4] || {};
  var handoff = results[5] || {};
  var humanChat = results[6] || {};

  var learningCounts = learning.counts || {};
  var skillItems = Array.isArray(skills.items) ? skills.items : [];
  var activeSkills = skillItems.filter(function (item) { return item.active === 1 || item.active === true; }).length;
  var reviewCounts = review.counts || {};
  var scoringCounts = scoring.counts || {};
  var handoffCounts = handoff.counts || {};

  setOverviewText("overview-memory-count", memory.total || memory.count || (memory.customers || []).length || 0);
  setOverviewText("overview-learning-pending", (learningCounts.draft || 0) + (learningCounts.pending || 0));
  setOverviewText("overview-skill-active", activeSkills || (skills.counts && skills.counts.active) || 0);
  setOverviewText("overview-review-pending", reviewCounts.pending || (review.items || []).length || 0);
  setOverviewText("overview-scoring-high", scoringCounts.high || 0);
  setOverviewText("overview-handoff-open", handoffCounts.open || 0);
  setOverviewText("overview-human-chat-active", humanChat.count || (humanChat.items || []).length || 0);

  setOverviewText("overview-health-review", overviewHealthLabel(reviewCounts.pending || 0, 3, 8));
  setOverviewText("overview-health-risk", overviewHealthLabel(scoringCounts.high || 0, 1, 5));
  setOverviewText("overview-health-cs", overviewHealthLabel((handoffCounts.open || 0) + (humanChat.count || 0), 3, 8));
  setOverviewText("overview-health-knowledge", activeSkills > 0 ? "Aktif" : "Belum aktif");

  var items = [];
  if ((handoffCounts.open || 0) > 0) items.push({tab:"human-handoff", title:"Ada " + handoffCounts.open + " ticket Handoff open", desc:"Perlu dicek dan diambil CS."});
  if ((humanChat.count || 0) > 0) items.push({tab:"human-chat", title:"Ada " + humanChat.count + " chat sedang dipegang CS", desc:"Pantau balasan dan selesaikan ticket."});
  if ((reviewCounts.pending || 0) > 0) items.push({tab:"review-approval", title:"Ada " + reviewCounts.pending + " bahan menunggu approval", desc:"Review agar knowledge AI tetap aman."});
  if ((scoringCounts.high || 0) > 0) items.push({tab:"conversation-scoring", title:"Ada " + scoringCounts.high + " chat high risk", desc:"Cek pola jawaban AI yang rawan."});
  if (!items.length) items.push({tab:"human-handoff", title:"Tidak ada prioritas mendesak", desc:"Sistem AI terlihat stabil saat ini."});

  if (priority) {
    priority.innerHTML = items.map(function (item) {
      return '<button type="button" class="ai-overview-priority" onclick="showAiSystemTab(\'' + item.tab + '\')"><strong>' + escHtml(item.title) + '</strong><span>' + escHtml(item.desc) + '</span></button>';
    }).join("");
  }
}

function memoryValue(id) {
  var el = document.getElementById(id);
  return el ? el.value.trim() : "";
}

function setMemoryValue(id, value) {
  var el = document.getElementById(id);
  if (el) el.value = value || "";
}

function setMemoryText(id, value) {
  var el = document.getElementById(id);
  if (el) el.textContent = value || "-";
}

function memoryDate(value) {
  return value || "-";
}

function formatMemorySummary(value) {
  var text = String(value || "").trim();
  if (!text) return "";

  text = text.replace(/\s+/g, " ");
  var parts = text.split(/;\s*/).map(function (part) { return part.trim(); }).filter(Boolean);
  if (parts.length < 2) return value;

  return parts.map(function (part) {
    var match = part.match(/^([^:]+):\s*(.*)$/);
    if (!match) return "- " + part;
    return "- " + match[1].trim() + ": " + match[2].trim();
  }).join("\n");
}

function memoryCustomerTitle(customer) {
  var number = (customer.display_number || customer.user_number || "").trim();
  var name = (customer.name || "").trim();
  if (name && name !== number && !/^\d{8,}$/.test(name)) return name;
  return "Customer";
}

function memoryPreview(value, maxLength) {
  var text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  var limit = maxLength || 150;
  return text.length > limit ? text.slice(0, limit - 1).trim() + "..." : text;
}

async function loadMemoryCustomers() {
  var list = document.getElementById("memory-customer-list");
  if (!list) return;

  var query = memoryValue("memory-search-input");
  list.innerHTML = '<div class="memory-empty">Memuat data memory...</div>';

  try {
    var data = await (await fetch("/api/ai-system/memory/customers?q=" + encodeURIComponent(query) + "&limit=80")).json();
    var customers = Array.isArray(data.customers) ? data.customers : [];
    setMemoryText("memory-total-count", customers.length);

    if (!customers.length) {
      list.innerHTML = '<div class="memory-empty">Belum ada memory customer. Masukkan nomor WA di detail untuk mulai membuat memory manual.</div>';
      return;
    }

    list.innerHTML = "";
    customers.forEach(function (customer) {
      var div = document.createElement("button");
      div.type = "button";
      div.className = "memory-customer-item" + (customer.user_number === selectedMemoryCustomer ? " active" : "");
      div.innerHTML = '<div class="memory-customer-head"><strong>' + escHtml(memoryCustomerTitle(customer)) + '</strong>'
        + '<span class="memory-wa-number">' + escHtml(customer.display_number || customer.user_number || "-") + '</span></div>'
        + '<div class="memory-customer-meta"><span>' + escHtml(customer.history_count || 0) + ' chat</span><span>' + escHtml(memoryDate(customer.updated_at || customer.last_chat_at)) + '</span></div>'
        + (customer.summary ? '<p>' + escHtml(memoryPreview(customer.summary, 155)) + '</p>' : '')
        + (customer.complaint ? '<small>' + escHtml(memoryPreview(customer.complaint, 120)) + '</small>' : '');
      div.onclick = function () { selectMemoryCustomer(customer.user_number, customer.display_number); };
      list.appendChild(div);
    });
  } catch (error) {
    list.innerHTML = '<div class="memory-empty">Gagal memuat memory customer.</div>';
  }
}

function selectMemoryCustomer(userNumber, displayNumber) {
  selectedMemoryCustomer = userNumber || "";
  selectedMemoryDisplayNumber = displayNumber || userNumber || "";
  setMemoryValue("memory-user-number", selectedMemoryDisplayNumber);
  setMemoryText("memory-selected-number", selectedMemoryDisplayNumber || "-");
  document.querySelectorAll(".memory-customer-item").forEach(function (item) { item.classList.remove("active"); });
  loadSelectedCustomerMemory(true);
}

async function loadSelectedCustomerMemory(skipConfirm) {
  var num = memoryValue("memory-user-number") || selectedMemoryCustomer;
  if (!num) {
    toast("Isi nomor WA dulu", "var(--red)");
    return;
  }
  if (!skipConfirm && !(await confirmAiSystemAction("Muat ulang memory customer?", "Perubahan yang belum disimpan bisa tertimpa."))) return;
  selectedMemoryCustomer = num;
  setMemoryText("memory-selected-number", num);

  try {
    var profileData = await (await fetch("/api/customer-profile/" + encodeURIComponent(num))).json();
    var profile = profileData.profile || {};
    setMemoryValue("memory-user-number", selectedMemoryDisplayNumber || profileData.user_number || num);
    setMemoryText("memory-selected-number", selectedMemoryDisplayNumber || profileData.user_number || num);
    setMemoryValue("memory-name", profile.name || "");
    setMemoryValue("memory-age", profile.age || "");
    setMemoryValue("memory-complaint", profile.complaint || profile.complaint_detail || "");
    setMemoryValue("memory-follow-up-stage", profile.follow_up_stage || profile.active_stage || "");
    setMemoryValue("memory-objection", profile.objection || "");
    setMemoryValue("memory-summary", formatMemorySummary(profileData.summary || ""));
    setMemoryValue("memory-customer-context", profile.customer_context || "");
    renderMemoryProfileKeys(profile);
    await loadMemoryHistory(num);
  } catch (error) {
    toast("Gagal memuat memory customer", "var(--red)");
  }
}

function renderMemoryProfileKeys(profile) {
  var target = document.getElementById("memory-profile-keys");
  if (!target) return;
  var keys = Object.keys(profile || {}).sort();
  if (!keys.length) {
    target.innerHTML = '<span class="memory-muted">Belum ada profile.</span>';
    return;
  }
  target.innerHTML = keys.map(function (key) { return '<span class="memory-chip">' + escHtml(key) + '</span>'; }).join("");
}

async function loadMemoryHistory(num) {
  var target = document.getElementById("memory-history-list");
  if (!target) return;
  target.innerHTML = '<div class="memory-empty">Memuat history...</div>';
  try {
    var history = await (await fetch("/api/conversation/history/" + encodeURIComponent(num) + "?limit=12")).json();
    if (!Array.isArray(history)) history = [];
    setMemoryText("memory-history-count", history.length);
    if (!history.length) {
      target.innerHTML = '<div class="memory-empty">Belum ada history chat untuk nomor ini.</div>';
      return;
    }
    target.innerHTML = history.map(function (item) {
      var isAi = item.role === "assistant";
      var isCustomer = item.role === "user";
      var role = isAi ? "AI" : (isCustomer ? "Customer" : item.role || "Chat");
      var roleClass = isAi ? " role-ai" : (isCustomer ? " role-customer" : "");
      return '<div class="memory-history-item' + roleClass + '"><div><strong>' + escHtml(role) + '</strong><span>' + escHtml(item.timestamp || "") + '</span></div><p>' + escHtml(item.content || "") + '</p></div>';
    }).join("");
    requestAnimationFrame(function () {
      target.scrollTop = target.scrollHeight;
    });
  } catch (error) {
    target.innerHTML = '<div class="memory-empty">Gagal memuat history chat.</div>';
  }
}

async function tidyMemorySummary() {
  if (!(await confirmAiSystemAction("Rapikan format Summary Memory sekarang?"))) return;
  var el = document.getElementById("memory-summary");
  if (!el) return;
  el.value = formatMemorySummary(el.value);
}

async function clearCustomerMemoryForm(skipConfirm) {
  if (!skipConfirm && !(await confirmAiSystemAction("Kosongkan form Memory Per Customer?", "Data yang sudah tersimpan tidak akan dihapus."))) return;
  selectedMemoryCustomer = "";
  selectedMemoryDisplayNumber = "";
  ["memory-user-number", "memory-name", "memory-age", "memory-complaint", "memory-follow-up-stage", "memory-objection", "memory-summary", "memory-customer-context"].forEach(function (id) { setMemoryValue(id, ""); });
  setMemoryText("memory-selected-number", "-");
  setMemoryText("memory-history-count", "0");
  renderMemoryProfileKeys({});
  var history = document.getElementById("memory-history-list");
  if (history) history.innerHTML = '<div class="memory-empty">Form kosong. Pilih customer di daftar kiri atau isi nomor WA baru.</div>';
  document.querySelectorAll(".memory-customer-item").forEach(function (item) { item.classList.remove("active"); });
}

async function saveCustomerMemory() {
  var num = memoryValue("memory-user-number");
  if (!num) {
    toast("Nomor WA wajib diisi", "var(--red)");
    return;
  }

  var profile = {
    name: memoryValue("memory-name"),
    age: memoryValue("memory-age"),
    complaint: memoryValue("memory-complaint"),
    follow_up_stage: memoryValue("memory-follow-up-stage"),
    objection: memoryValue("memory-objection"),
    customer_context: memoryValue("memory-customer-context")
  };

  if (!(await confirmAiSystemAction("Simpan perubahan Memory Per Customer untuk " + num + "?"))) return;

  try {
    var res = await fetch("/api/customer-profile/" + encodeURIComponent(num), {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({summary: memoryValue("memory-summary"), profile_updates: profile})
    });
    var data = await res.json();
    if (!data.success) throw new Error(data.error || "Simpan gagal");
    selectedMemoryCustomer = num;
    toast("Memory customer disimpan");
    await loadMemoryCustomers();
    await loadSelectedCustomerMemory(true);
  } catch (error) {
    toast("Gagal simpan memory", "var(--red)");
  }
}

async function resetSelectedCustomerMemory() {
  var num = memoryValue("memory-user-number") || selectedMemoryCustomer;
  if (!num) {
    toast("Pilih customer dulu", "var(--red)");
    return;
  }
  if (!(await confirmAiSystemAction("Reset history chat dan memory permanent untuk " + num + "?", "Data memory dan history nomor ini akan dihapus."))) return;

  try {
    var res = await fetch("/api/customer-memory/" + encodeURIComponent(num), {method: "DELETE"});
    var data = await res.json();
    if (!data.success) throw new Error(data.error || "Reset gagal");
    selectedMemoryCustomer = "";
    ["memory-user-number", "memory-name", "memory-age", "memory-complaint", "memory-follow-up-stage", "memory-objection", "memory-summary", "memory-customer-context"].forEach(function (id) { setMemoryValue(id, ""); });
    setMemoryText("memory-selected-number", "-");
    setMemoryText("memory-history-count", "0");
    renderMemoryProfileKeys({});
    document.getElementById("memory-history-list").innerHTML = '<div class="memory-empty">Memory sudah di-reset.</div>';
    toast("Memory customer di-reset");
    loadMemoryCustomers();
  } catch (error) {
    toast("Gagal reset memory", "var(--red)");
  }
}


var selectedLearningStatus = "";
var currentLearningItems = [];

function learningValue(id) {
  var el = document.getElementById(id);
  return el ? el.value.trim() : "";
}

function setLearningValue(id, value) {
  var el = document.getElementById(id);
  if (el) el.value = value || "";
}

function setLearningText(id, value) {
  var el = document.getElementById(id);
  if (el) el.textContent = value || "0";
}

function setLearningStatus(status, button) {
  selectedLearningStatus = status || "";
  document.querySelectorAll(".learning-status-card").forEach(function (card) { card.classList.remove("active"); });
  if (button) button.classList.add("active");
  loadLearningBank();
}

async function loadLearningBank() {
  var list = document.getElementById("learning-bank-list");
  if (!list) return;
  var query = learningValue("learning-search-input");
  list.innerHTML = '<div class="memory-empty">Memuat Learning Bank...</div>';
  try {
    var url = "/api/ai-system/learning-bank?limit=120&q=" + encodeURIComponent(query);
    if (selectedLearningStatus) url += "&status=" + encodeURIComponent(selectedLearningStatus);
    var data = await (await fetch(url)).json();
    currentLearningItems = Array.isArray(data.items) ? data.items : [];
    var counts = data.counts || {};
    var draftCount = counts.draft || 0;
    var pendingCount = counts.pending || 0;
    setLearningText("learning-count-all", draftCount + pendingCount || currentLearningItems.length);
    setLearningText("learning-count-draft", draftCount);
    setLearningText("learning-count-pending", pendingCount);

    if (!currentLearningItems.length) {
      list.innerHTML = '<div class="memory-empty">Belum ada insight. Klik Insight Baru untuk mulai mengisi bahan belajar AI.</div>';
      return;
    }

    list.innerHTML = currentLearningItems.map(function (item) {
      return '<button type="button" class="learning-bank-item" onclick="selectLearningBankItem(' + item.id + ')">'
        + '<div><strong>' + escHtml(item.title || "Tanpa judul") + '</strong><span>' + escHtml(item.updated_at || "-") + '</span></div>'
        + '<p>' + escHtml(item.question_pattern || item.insight || item.answer_recommendation || "-") + '</p>'
        + '<div class="learning-bank-meta"><span class="learning-status-pill status-' + escHtml(item.status || "pending") + '">' + escHtml(item.status || "pending") + '</span><span>' + escHtml(item.category || "general") + '</span></div>'
        + '</button>';
    }).join("");
  } catch (error) {
    list.innerHTML = '<div class="memory-empty">Gagal memuat Learning Bank.</div>';
  }
}

async function newLearningBankItem(skipConfirm) {
  if (!skipConfirm && !(await confirmAiSystemAction("Kosongkan form Learning Bank dan mulai insight baru?"))) return;
  setLearningValue("learning-id", "");
  setLearningValue("learning-title", "");
  setLearningValue("learning-category", "faq");
  setLearningValue("learning-source-type", "manual");
  setLearningValue("learning-status", "draft");
  setLearningValue("learning-question-pattern", "");
  setLearningValue("learning-answer-recommendation", "");
  setLearningValue("learning-insight", "");
  setLearningValue("learning-tags", "");
  var title = document.getElementById("learning-editor-title");
  if (title) title.textContent = "Insight Baru";
}

function selectLearningBankItem(id) {
  var item = currentLearningItems.find(function (entry) { return entry.id === id; });
  if (!item) return;
  setLearningValue("learning-id", item.id);
  setLearningValue("learning-title", item.title);
  setLearningValue("learning-category", item.category || "general");
  setLearningValue("learning-source-type", item.source_type || "manual");
  setLearningValue("learning-status", (item.status === "approved" || item.status === "rejected") ? "pending" : (item.status || "draft"));
  setLearningValue("learning-question-pattern", item.question_pattern || "");
  setLearningValue("learning-answer-recommendation", item.answer_recommendation || "");
  setLearningValue("learning-insight", item.insight || "");
  setLearningValue("learning-tags", item.tags || "");
  var title = document.getElementById("learning-editor-title");
  if (title) title.textContent = "Edit Insight #" + item.id;
}

async function saveLearningBankItem(skipConfirm) {
  var id = learningValue("learning-id");
  var payload = {
    title: learningValue("learning-title"),
    category: learningValue("learning-category"),
    source_type: learningValue("learning-source-type"),
    status: learningValue("learning-status"),
    question_pattern: learningValue("learning-question-pattern"),
    answer_recommendation: learningValue("learning-answer-recommendation"),
    insight: learningValue("learning-insight"),
    tags: learningValue("learning-tags")
  };
  if (!payload.title) {
    toast("Judul insight wajib diisi", "var(--red)");
    return;
  }
  if (!skipConfirm && !(await confirmAiSystemAction("Simpan draft Learning Bank ini?"))) return;
  try {
    var url = id ? "/api/ai-system/learning-bank/" + encodeURIComponent(id) : "/api/ai-system/learning-bank";
    var res = await fetch(url, {
      method: id ? "PUT" : "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)
    });
    var data = await res.json();
    if (!data.success) throw new Error(data.error || "Simpan gagal");
    toast("Draft Learning Bank disimpan");
    await loadLearningBank();
    if (!id && data.id) selectLearningBankItem(data.id);
  } catch (error) {
    toast("Gagal simpan insight", "var(--red)");
  }
}

async function sendLearningToReview() {
  var id = learningValue("learning-id");
  if (!id) {
    toast("Simpan draft dulu sebelum dikirim ke review", "var(--red)");
    return;
  }
  if (!(await confirmAiSystemAction("Kirim insight ini ke Review & Approval?", "Status akan menjadi Pending Review."))) return;
  setLearningValue("learning-status", "pending");
  await saveLearningBankItem(true);
}

async function deleteLearningBankItem() {
  var id = learningValue("learning-id");
  if (!id) {
    toast("Pilih insight dulu", "var(--red)");
    return;
  }
  if (!(await confirmAiSystemAction("Hapus insight Learning Bank #" + id + "?", "Data insight ini akan dihapus dari Learning Bank."))) return;
  try {
    var res = await fetch("/api/ai-system/learning-bank/" + encodeURIComponent(id), {method: "DELETE"});
    var data = await res.json();
    if (!data.success) throw new Error(data.error || "Hapus gagal");
    toast("Insight dihapus");
    newLearningBankItem(true);
    loadLearningBank();
  } catch (error) {
    toast("Gagal hapus insight", "var(--red)");
  }
}


var selectedSkillFilter = "";
var currentAiSkills = [];

function skillValue(id) {
  var el = document.getElementById(id);
  return el ? el.value.trim() : "";
}

function setSkillValue(id, value) {
  var el = document.getElementById(id);
  if (el) el.value = value ?? "";
}

function setSkillText(id, value) {
  var el = document.getElementById(id);
  if (el) el.textContent = value || "0";
}

function setSkillFilter(active, button) {
  selectedSkillFilter = active || "";
  document.querySelectorAll(".skill-status-card").forEach(function (card) { card.classList.remove("active"); });
  if (button) button.classList.add("active");
  loadAiSkills();
}

async function loadAiSkills() {
  var list = document.getElementById("skill-system-list");
  if (!list) return;
  var query = skillValue("skill-search-input");
  list.innerHTML = '<div class="memory-empty">Memuat skill...</div>';
  try {
    var url = "/api/ai-system/skills?q=" + encodeURIComponent(query);
    if (selectedSkillFilter !== "") url += "&active=" + encodeURIComponent(selectedSkillFilter);
    var data = await (await fetch(url)).json();
    currentAiSkills = Array.isArray(data.skills) ? data.skills : [];
    var counts = data.counts || {};
    var activeCount = counts["1"] || 0;
    var inactiveCount = counts["0"] || 0;
    setSkillText("skill-count-all", activeCount + inactiveCount || currentAiSkills.length);
    setSkillText("skill-count-active", activeCount);
    setSkillText("skill-count-inactive", inactiveCount);
    if (!currentAiSkills.length) {
      list.innerHTML = '<div class="memory-empty">Belum ada skill. Klik Skill Baru untuk membuat modul kemampuan AI.</div>';
      return;
    }
    list.innerHTML = currentAiSkills.map(function (skill) {
      return '<button type="button" class="skill-system-item" onclick="selectAiSkill(' + skill.id + ')">'
        + '<div><strong>' + escHtml(skill.name || "Tanpa nama") + '</strong><span>P' + escHtml(skill.priority || 50) + '</span></div>'
        + '<p>' + escHtml(skill.description || skill.trigger_rules || "-") + '</p>'
        + '<div class="skill-system-meta"><span class="skill-status-pill ' + (skill.active ? 'active' : 'inactive') + '">' + (skill.active ? 'Aktif' : 'Nonaktif') + '</span><span>' + escHtml(skill.category || 'general') + '</span></div>'
        + '</button>';
    }).join("");
  } catch (error) {
    list.innerHTML = '<div class="memory-empty">Gagal memuat Skill System.</div>';
  }
}

async function newAiSkill(skipConfirm) {
  if (!skipConfirm && !(await confirmAiSystemAction("Kosongkan form Skill System dan mulai skill baru?"))) return;
  setSkillValue("skill-id", "");
  setSkillValue("skill-name", "");
  setSkillValue("skill-key", "");
  setSkillValue("skill-category", "consultation");
  setSkillValue("skill-priority", "50");
  setSkillValue("skill-active", "1");
  setSkillValue("skill-description", "");
  setSkillValue("skill-trigger-rules", "");
  setSkillValue("skill-response-rules", "");
  setSkillValue("skill-guardrails", "");
  setSkillValue("skill-example-response", "");
  var title = document.getElementById("skill-editor-title");
  if (title) title.textContent = "Skill Baru";
}

function selectAiSkill(id) {
  var skill = currentAiSkills.find(function (entry) { return entry.id === id; });
  if (!skill) return;
  setSkillValue("skill-id", skill.id);
  setSkillValue("skill-name", skill.name);
  setSkillValue("skill-key", skill.skill_key);
  setSkillValue("skill-category", skill.category || "general");
  setSkillValue("skill-priority", skill.priority || 50);
  setSkillValue("skill-active", String(skill.active ? 1 : 0));
  setSkillValue("skill-description", skill.description || "");
  setSkillValue("skill-trigger-rules", skill.trigger_rules || "");
  setSkillValue("skill-response-rules", skill.response_rules || "");
  setSkillValue("skill-guardrails", skill.guardrails || "");
  setSkillValue("skill-example-response", skill.example_response || "");
  var title = document.getElementById("skill-editor-title");
  if (title) title.textContent = "Edit Skill #" + skill.id;
}

async function saveAiSkill() {
  var id = skillValue("skill-id");
  var payload = {
    name: skillValue("skill-name"),
    skill_key: skillValue("skill-key"),
    category: skillValue("skill-category"),
    priority: parseInt(skillValue("skill-priority") || "50", 10),
    active: skillValue("skill-active") === "1",
    description: skillValue("skill-description"),
    trigger_rules: skillValue("skill-trigger-rules"),
    response_rules: skillValue("skill-response-rules"),
    guardrails: skillValue("skill-guardrails"),
    example_response: skillValue("skill-example-response")
  };
  if (!payload.name) {
    toast("Nama skill wajib diisi", "var(--red)");
    return;
  }
  if (!(await confirmAiSystemAction("Simpan skill ini?"))) return;
  try {
    var url = id ? "/api/ai-system/skills/" + encodeURIComponent(id) : "/api/ai-system/skills";
    var res = await fetch(url, {method: id ? "PUT" : "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)});
    var data = await res.json();
    if (!data.success) throw new Error(data.error || "Simpan gagal");
    toast("Skill disimpan");
    await loadAiSkills();
    if (!id && data.id) selectAiSkill(data.id);
  } catch (error) {
    toast("Gagal simpan skill", "var(--red)");
  }
}

async function deleteAiSkill() {
  var id = skillValue("skill-id");
  if (!id) {
    toast("Pilih skill dulu", "var(--red)");
    return;
  }
  if (!(await confirmAiSystemAction("Hapus skill #" + id + "?", "Data skill ini akan dihapus dari Skill System."))) return;
  try {
    var res = await fetch("/api/ai-system/skills/" + encodeURIComponent(id), {method: "DELETE"});
    var data = await res.json();
    if (!data.success) throw new Error(data.error || "Hapus gagal");
    toast("Skill dihapus");
    newAiSkill(true);
    loadAiSkills();
  } catch (error) {
    toast("Gagal hapus skill", "var(--red)");
  }
}


var selectedReviewStatus = "pending";
var currentReviewItems = [];

function reviewValue(id) {
  var el = document.getElementById(id);
  return el ? el.value.trim() : "";
}

function setReviewValue(id, value) {
  var el = document.getElementById(id);
  if (el) el.value = value || "";
}

function setReviewText(id, value) {
  var el = document.getElementById(id);
  if (el) el.textContent = value || "-";
}

function setReviewStatus(status, button) {
  selectedReviewStatus = status || "";
  document.querySelectorAll(".review-status-card").forEach(function (card) { card.classList.remove("active"); });
  if (button) button.classList.add("active");
  loadReviewApproval();
}

async function loadReviewApproval() {
  var list = document.getElementById("review-approval-list");
  if (!list) return;
  var query = reviewValue("review-search-input");
  list.innerHTML = '<div class="memory-empty">Memuat antrean review...</div>';
  try {
    var url = "/api/ai-system/review-approval?q=" + encodeURIComponent(query);
    if (selectedReviewStatus) url += "&status=" + encodeURIComponent(selectedReviewStatus);
    var data = await (await fetch(url)).json();
    currentReviewItems = Array.isArray(data.items) ? data.items : [];
    var counts = data.counts || {};
    var allCount = (counts.pending || 0) + (counts.approved || 0) + (counts.rejected || 0);
    setReviewText("review-count-pending", counts.pending || 0);
    setReviewText("review-count-approved", counts.approved || 0);
    setReviewText("review-count-rejected", counts.rejected || 0);
    setReviewText("review-count-all", allCount);
    if (!currentReviewItems.length) {
      list.innerHTML = '<div class="memory-empty">Tidak ada item review pada filter ini.</div>';
      return;
    }
    list.innerHTML = currentReviewItems.map(function (item) {
      return '<button type="button" class="review-approval-item" onclick="selectReviewItem(' + item.id + ')">'
        + '<div><strong>' + escHtml(item.title || 'Tanpa judul') + '</strong><span>' + escHtml(item.updated_at || '-') + '</span></div>'
        + '<p>' + escHtml(item.question_pattern || item.insight || item.answer_recommendation || '-') + '</p>'
        + '<div class="learning-bank-meta"><span class="learning-status-pill status-' + escHtml(item.status || 'pending') + '">' + escHtml(item.status || 'pending') + '</span><span>' + escHtml(item.category || 'general') + '</span></div>'
        + '</button>';
    }).join("");
  } catch (error) {
    list.innerHTML = '<div class="memory-empty">Gagal memuat Review & Approval.</div>';
  }
}

function selectReviewItem(id) {
  var item = currentReviewItems.find(function (entry) { return entry.id === id; });
  if (!item) return;
  setReviewValue("review-item-id", item.id);
  setReviewText("review-detail-title", item.title || "Item Review");
  setReviewText("review-category", item.category || "-");
  setReviewText("review-source-type", item.source_type || "-");
  setReviewText("review-updated-at", item.updated_at || "-");
  setReviewText("review-tags", item.tags || "-");
  setReviewValue("review-question-pattern", item.question_pattern || "");
  setReviewValue("review-answer-recommendation", item.answer_recommendation || "");
  setReviewValue("review-insight", item.insight || "");
  setReviewValue("review-note", item.review_note || "");
  var badge = document.getElementById("review-detail-status");
  if (badge) {
    badge.textContent = item.status || "pending";
    badge.className = "learning-status-pill status-" + (item.status || "pending");
  }
}

async function clearReviewSelection(skipConfirm) {
  if (!skipConfirm && !(await confirmAiSystemAction("Kosongkan form Review & Approval?", "Data review yang tersimpan tidak akan dihapus."))) return;
  setReviewValue("review-item-id", "");
  setReviewText("review-detail-title", "Pilih Item Review");
  setReviewText("review-category", "-");
  setReviewText("review-source-type", "-");
  setReviewText("review-updated-at", "-");
  setReviewText("review-tags", "-");
  ["review-question-pattern", "review-answer-recommendation", "review-insight", "review-note"].forEach(function (id) { setReviewValue(id, ""); });
  var badge = document.getElementById("review-detail-status");
  if (badge) { badge.textContent = "pending"; badge.className = "learning-status-pill status-pending"; }
}

async function updateReviewItemStatus(status) {
  var id = reviewValue("review-item-id");
  if (!id) {
    toast("Pilih item review dulu", "var(--red)");
    return;
  }
  var label = status === "approved" ? "approve" : "reject";
  if (!(await confirmAiSystemAction("Yakin ingin " + label + " item review #" + id + "?", "Status item di Learning Bank akan berubah."))) return;
  try {
    var res = await fetch("/api/ai-system/review-approval/" + encodeURIComponent(id), {
      method: "PUT",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({status: status, review_note: reviewValue("review-note")})
    });
    var data = await res.json();
    if (!data.success) throw new Error(data.error || "Update review gagal");
    toast(status === "approved" ? "Item di-approve" : "Item di-reject");
    clearReviewSelection(true);
    loadReviewApproval();
    loadLearningBank();
  } catch (error) {
    toast("Gagal update review", "var(--red)");
  }
}

function approveReviewItem() { updateReviewItemStatus("approved"); }
function rejectReviewItem() { updateReviewItemStatus("rejected"); }


var selectedScoringRisk = "";
var currentScoringItems = [];

function scoringValue(id) { var el = document.getElementById(id); return el ? el.value.trim() : ""; }
function setScoringValue(id, value) { var el = document.getElementById(id); if (el) el.value = value ?? ""; }
function setScoringText(id, value) { var el = document.getElementById(id); if (el) el.textContent = value || "0"; }
function setScoringBox(id, value) { var el = document.getElementById(id); if (el) el.textContent = value || "-"; }
function setScoringBar(id, value) { var el = document.getElementById(id); if (el) el.style.width = Math.max(0, Math.min(100, parseInt(value || 0, 10))) + "%"; }

function setScoringRisk(risk, button) {
  selectedScoringRisk = risk || "";
  document.querySelectorAll(".scoring-status-card").forEach(function (card) { card.classList.remove("active"); });
  if (button) button.classList.add("active");
  loadConversationScoring();
}

async function loadConversationScoring() {
  var list = document.getElementById("conversation-scoring-list");
  if (!list) return;
  var query = scoringValue("scoring-search-input");
  list.innerHTML = '<div class="memory-empty">Memuat conversation scoring...</div>';
  try {
    var url = "/api/ai-system/conversation-scoring?limit=120&q=" + encodeURIComponent(query);
    if (selectedScoringRisk) url += "&risk=" + encodeURIComponent(selectedScoringRisk);
    var data = await (await fetch(url)).json();
    currentScoringItems = Array.isArray(data.items) ? data.items : [];
    var counts = data.counts || {};
    setScoringText("scoring-count-total", data.total_logs || currentScoringItems.length);
    setScoringText("scoring-count-low", counts.low || 0);
    setScoringText("scoring-count-medium", counts.medium || 0);
    setScoringText("scoring-count-high", counts.high || 0);
    if (!currentScoringItems.length) {
      list.innerHTML = '<div class="memory-empty">Belum ada percakapan pada filter ini.</div>';
      return;
    }
    list.innerHTML = currentScoringItems.map(function (item) {
      return '<button type="button" class="conversation-scoring-item" onclick="selectConversationScore(' + item.log_id + ')">'
        + '<div><strong>' + escHtml(item.user_number || '-') + '</strong><span>' + escHtml(item.timestamp || '-') + '</span></div>'
        + '<p>' + escHtml(item.user_message || '-') + '</p>'
        + '<div class="scoring-item-meta"><span class="score-pill risk-' + escHtml(item.risk_level || 'low') + '">' + escHtml(item.score || 0) + '</span><span>' + escHtml(item.risk_level || 'low') + '</span></div>'
        + '</button>';
    }).join("");
  } catch (error) {
    list.innerHTML = '<div class="memory-empty">Gagal memuat Conversation Scoring.</div>';
  }
}

function selectConversationScore(logId) {
  var item = currentScoringItems.find(function (entry) { return entry.log_id === logId; });
  if (!item) return;
  setScoringText("scoring-log-id", item.log_id);
  setScoringText("scoring-detail-title", "Log #" + item.log_id + " - " + (item.user_number || "Unknown"));
  setScoringText("scoring-score", item.score || 0);
  setScoringText("scoring-relevance", item.relevance || 0);
  setScoringText("scoring-empathy", item.empathy || 0);
  setScoringText("scoring-safety", item.safety || 0);
  setScoringText("scoring-closing", item.closing || 0);
  setScoringText("scoring-risk-level", item.risk_level || "low");
  setScoringText("scoring-status", item.status || "preview");
  setScoringBox("scoring-user-message", item.user_message || "");
  setScoringBox("scoring-ai-response", item.ai_response || "");
  setScoringBox("scoring-issues", item.issues || "Tidak ada issue utama terdeteksi.");
  setScoringBox("scoring-recommendation", item.recommendation || "-");
  setScoringBar("scoring-relevance-bar", item.relevance || 0);
  setScoringBar("scoring-empathy-bar", item.empathy || 0);
  setScoringBar("scoring-safety-bar", item.safety || 0);
  setScoringBar("scoring-closing-bar", item.closing || 0);
  var badge = document.getElementById("scoring-risk-badge");
  if (badge) { badge.textContent = item.risk_level || "low"; badge.className = "score-pill risk-" + (item.risk_level || "low"); }
}

function clearConversationScoring() {
  setScoringText("scoring-log-id", "-");
  setScoringText("scoring-score", "-");
  setScoringText("scoring-relevance", "0");
  setScoringText("scoring-empathy", "0");
  setScoringText("scoring-safety", "0");
  setScoringText("scoring-closing", "0");
  setScoringText("scoring-risk-level", "-");
  setScoringText("scoring-status", "Preview");
  setScoringText("scoring-detail-title", "Pilih Percakapan");
  setScoringBox("scoring-user-message", "Pilih percakapan untuk melihat pesan customer.");
  setScoringBox("scoring-ai-response", "Pilih percakapan untuk melihat jawaban AI.");
  setScoringBox("scoring-issues", "-");
  setScoringBox("scoring-recommendation", "-");
  ["scoring-relevance-bar", "scoring-empathy-bar", "scoring-safety-bar", "scoring-closing-bar"].forEach(function (id) { setScoringBar(id, 0); });
  var badge = document.getElementById("scoring-risk-badge");
  if (badge) { badge.textContent = "preview"; badge.className = "learning-status-pill status-draft"; }
}

var selectedHandoffStatus = "";
var currentHandoffItems = [];
var selectedHandoffId = "";
var selectedHandoffStatusValue = "";

function handoffValue(id) { var el = document.getElementById(id); return el ? el.value.trim() : ""; }
function setHandoffValue(id, value) { var el = document.getElementById(id); if (el) el.value = value || ""; }
function setHandoffText(id, value) { var el = document.getElementById(id); if (el) el.textContent = value || "-"; }

function handoffStatusLabel(status) {
  return {open: "Open", in_progress: "Diambil CS", resolved: "Selesai", canceled: "Archive", archived: "Archive"}[status] || "Preview";
}

function handoffStatusClass(status) {
  if (status === "open") return "learning-status-pill status-pending";
  if (status === "in_progress") return "learning-status-pill status-draft";
  if (status === "resolved") return "learning-status-pill status-approved";
  if (status === "canceled" || status === "archived") return "learning-status-pill status-rejected";
  return "learning-status-pill status-draft";
}

function handoffPriorityLabel(priority) {
  return {high: "High", medium: "Medium", low: "Low"}[priority] || "Medium";
}

function setHandoffChecked(id, value) { var el = document.getElementById(id); if (el) el.checked = !!value; }
function getHandoffChecked(id) { var el = document.getElementById(id); return !!(el && el.checked); }

function openHandoffSettings() {
  var panel = document.getElementById("handoff-settings-panel");
  if (panel) panel.hidden = false;
  loadHandoffSettings();
}

function closeHandoffSettings() {
  var panel = document.getElementById("handoff-settings-panel");
  if (panel) panel.hidden = true;
}

async function loadHandoffSettings() {
  var panel = document.getElementById("handoff-settings-panel");
  if (!panel && !document.getElementById("handoff-enable-risk")) return;
  try {
    var data = await (await fetch("/api/ai-system/human-handoff/settings")).json();
    var settings = data.settings || {};
    setHandoffChecked("handoff-enable-risk", settings.enable_risk_scoring);
    setHandoffChecked("handoff-medium-risk", settings.medium_risk_enabled);
    setHandoffChecked("handoff-enable-keywords", settings.enable_sensitive_keywords);
    setHandoffChecked("handoff-enable-followup", settings.enable_follow_up);
    setHandoffValue("handoff-followup-days", settings.follow_up_days || 2);
    setHandoffValue("handoff-idle-hours", settings.idle_hours || 12);
    setHandoffValue("handoff-min-chat-count", settings.min_chat_count || 2);
    setHandoffValue("handoff-keywords", (settings.keywords || []).join(", "));
    setHandoffValue("handoff-followup-keywords", (settings.follow_up_keywords || []).join(", "));
  } catch (error) {
    toast("Gagal memuat pengaturan Handoff", "var(--red)");
  }
}

async function saveHandoffSettings() {
  if (!(await confirmAiSystemAction("Simpan pengaturan Human Handoff?", "Aturan baru akan dipakai saat ticket Handoff dimuat ulang."))) return;
  var payload = {
    enable_risk_scoring: getHandoffChecked("handoff-enable-risk"),
    medium_risk_enabled: getHandoffChecked("handoff-medium-risk"),
    enable_sensitive_keywords: getHandoffChecked("handoff-enable-keywords"),
    enable_follow_up: getHandoffChecked("handoff-enable-followup"),
    follow_up_days: parseInt(handoffValue("handoff-followup-days") || "2", 10),
    idle_hours: parseInt(handoffValue("handoff-idle-hours") || "12", 10),
    min_chat_count: parseInt(handoffValue("handoff-min-chat-count") || "2", 10),
    keywords: handoffValue("handoff-keywords"),
    follow_up_keywords: handoffValue("handoff-followup-keywords")
  };
  try {
    var res = await fetch("/api/ai-system/human-handoff/settings", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)
    });
    var data = await res.json();
    if (!data.success) throw new Error(data.error || "Simpan pengaturan gagal");
    toast("Pengaturan Handoff disimpan");
    await loadHandoffSettings();
    await loadHumanHandoffs();
  } catch (error) {
    toast("Gagal simpan pengaturan Handoff", "var(--red)");
  }
}

function setHandoffStatus(status, button) {
  selectedHandoffStatus = status || "";
  document.querySelectorAll(".handoff-status-card").forEach(function (card) { card.classList.remove("active"); });
  if (button) button.classList.add("active");
  loadHumanHandoffs();
}

async function loadHumanHandoffs() {
  var list = document.getElementById("human-handoff-list");
  if (!list) return;
  var query = handoffValue("handoff-search-input");
  list.innerHTML = '<div class="memory-empty">Memuat ticket handoff...</div>';
  try {
    var url = "/api/ai-system/human-handoff?q=" + encodeURIComponent(query);
    if (selectedHandoffStatus) url += "&status=" + encodeURIComponent(selectedHandoffStatus);
    var data = await (await fetch(url)).json();
    currentHandoffItems = Array.isArray(data.items) ? data.items : [];
    var counts = data.counts || {};
    setHandoffText("handoff-count-total", data.total || currentHandoffItems.length || 0);
    setHandoffText("handoff-count-open", counts.open || 0);
    setHandoffText("handoff-count-progress", counts.in_progress || 0);
    setHandoffText("handoff-count-resolved", counts.resolved || 0);
    setHandoffText("handoff-count-archived", (counts.archived || 0) + (counts.canceled || 0));
    if (!currentHandoffItems.length) {
      list.innerHTML = '<div class="memory-empty">Belum ada ticket handoff pada filter ini.</div>';
      return;
    }
    list.innerHTML = currentHandoffItems.map(function (item) {
      return '<button type="button" class="human-handoff-item" onclick="selectHumanHandoff(' + item.id + ')">'
        + '<div><strong>' + escHtml(item.user_number || '-') + '</strong><span>' + escHtml(item.updated_at || item.created_at || '-') + '</span></div>'
        + '<p>' + escHtml(item.reason || '-') + '</p>'
        + '<div class="handoff-item-meta"><span class="handoff-priority priority-' + escHtml(item.priority || 'medium') + '">' + escHtml(handoffPriorityLabel(item.priority)) + '</span><span>' + escHtml(handoffStatusLabel(item.status)) + '</span></div>'
        + '</button>';
    }).join("");
  } catch (error) {
    list.innerHTML = '<div class="memory-empty">Gagal memuat ticket handoff.</div>';
  }
}

function selectHumanHandoff(ticketId) {
  var item = currentHandoffItems.find(function (entry) { return entry.id === ticketId; });
  if (!item) return;
  selectedHandoffId = String(item.id || "");
  selectedHandoffStatusValue = item.status || "open";
  setHandoffText("handoff-detail-title", "Ticket #" + item.id + " - " + (item.user_number || "Unknown"));
  setHandoffText("handoff-ticket-id", item.id);
  setHandoffText("handoff-log-id", item.log_id || "-");
  setHandoffText("handoff-user-number", item.user_number || "-");
  setHandoffText("handoff-priority", handoffPriorityLabel(item.priority));
  setHandoffText("handoff-created-at", item.created_at || "-");
  setHandoffText("handoff-updated-at", item.updated_at || "-");
  setHandoffText("handoff-reason", item.reason || "-");
  setHandoffText("handoff-customer-message", item.customer_message || "-");
  setHandoffText("handoff-ai-response", item.ai_response || "-");
  setHandoffValue("handoff-owner", item.owner || "");
  setHandoffValue("handoff-notes", item.notes || "");
  var badge = document.getElementById("handoff-detail-status");
  if (badge) { badge.textContent = handoffStatusLabel(item.status); badge.className = handoffStatusClass(item.status); }
  renderHandoffActions(item.status || "open");
}

async function clearHumanHandoffSelection(skipConfirm) {
  if (!skipConfirm && !(await confirmAiSystemAction("Kosongkan form Human Handoff?", "Ini hanya membersihkan tampilan, data ticket tidak dihapus."))) return;
  selectedHandoffId = "";
  selectedHandoffStatusValue = "";
  setHandoffText("handoff-detail-title", "Pilih Tiket");
  ["handoff-ticket-id", "handoff-log-id", "handoff-user-number", "handoff-priority", "handoff-created-at", "handoff-updated-at"].forEach(function (id) { setHandoffText(id, "-"); });
  setHandoffText("handoff-reason", "Pilih tiket untuk melihat alasan eskalasi.");
  setHandoffText("handoff-customer-message", "-");
  setHandoffText("handoff-ai-response", "-");
  setHandoffValue("handoff-owner", "");
  setHandoffValue("handoff-notes", "");
  var badge = document.getElementById("handoff-detail-status");
  if (badge) { badge.textContent = "preview"; badge.className = "learning-status-pill status-draft"; }
  renderHandoffActions("");
}

async function updateHumanHandoff(status, message, detail) {
  if (!selectedHandoffId) {
    toast("Pilih ticket handoff dulu", "var(--red)");
    return;
  }
  if (!(await confirmAiSystemAction(message, detail))) return;
  try {
    var res = await fetch("/api/ai-system/human-handoff/" + encodeURIComponent(selectedHandoffId), {
      method: "PUT",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({status: status || "", owner: handoffValue("handoff-owner"), notes: handoffValue("handoff-notes")})
    });
    var data = await res.json();
    if (!data.success) throw new Error(data.error || "Update handoff gagal");
    toast("Ticket handoff diperbarui");
    await loadHumanHandoffs();
    var id = parseInt(selectedHandoffId, 10);
    if (status === "resolved" || status === "canceled" || status === "archived") clearHumanHandoffSelection(true);
    else selectHumanHandoff(id);
  } catch (error) {
    toast("Gagal update ticket handoff", "var(--red)");
  }
}

function renderHandoffActions(status) {
  var primary = document.getElementById("handoff-primary-action");
  var autoReply = document.getElementById("handoff-auto-reply-action");
  var cancel = document.getElementById("handoff-cancel-action");
  var hasTicket = !!selectedHandoffId;
  var isClosed = status === "resolved" || status === "canceled" || status === "archived";
  if (primary) {
    primary.disabled = !hasTicket || isClosed;
    primary.textContent = !hasTicket ? "Ambil Tiket" : (status === "in_progress" ? "Selesaikan" : "Ambil Tiket");
  }
  if (autoReply) {
    autoReply.disabled = !hasTicket || isClosed;
  }
  if (cancel) {
    cancel.disabled = !hasTicket || isClosed;
  }
}

function takeHumanHandoff() {
  if (!handoffValue("handoff-owner")) setHandoffValue("handoff-owner", "CS Team");
  updateHumanHandoff("in_progress", "Ambil tiket handoff ini?", "Owner dan Catatan Penanganan / Auto Balas akan ikut tersimpan.");
}

function resolveHumanHandoff() {
  updateHumanHandoff("resolved", "Selesaikan tiket handoff ini?", "Owner dan Catatan Penanganan / Auto Balas akan ikut tersimpan. AI bisa dilanjutkan lagi setelah tiket selesai.");
}

function runHumanHandoffPrimaryAction() {
  if (selectedHandoffStatusValue === "in_progress") resolveHumanHandoff();
  else takeHumanHandoff();
}

async function autoReplyHumanHandoff() {
  if (!selectedHandoffId) {
    toast("Pilih tiket handoff dulu", "var(--red)");
    return;
  }
  var message = handoffValue("handoff-notes");
  if (!message) {
    toast("Isi Catatan Penanganan dulu untuk Auto Balas", "var(--red)");
    return;
  }
  if (!(await confirmAiSystemAction("Kirim Auto Balas ke customer?", "Isi Catatan Penanganan akan dikirim sebagai pesan WhatsApp."))) return;
  try {
    var res = await fetch("/api/ai-system/human-handoff/" + encodeURIComponent(selectedHandoffId) + "/auto-reply", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({message: message})
    });
    var data = await res.json();
    if (!data.success) throw new Error(data.error || "Auto Balas gagal");
    toast("Auto Balas terkirim");
    await loadHumanHandoffs();
    selectHumanHandoff(parseInt(selectedHandoffId, 10));
  } catch (error) {
    toast("Gagal Auto Balas: " + (error.message || ""), "var(--red)");
  }
}

function cancelHumanHandoff() {
  updateHumanHandoff("archived", "Archive tiket handoff ini?", "Tiket akan masuk Archive. Owner dan Catatan Penanganan / Auto Balas akan ikut tersimpan.");
}

var currentHumanChatTickets = [];
var selectedHumanChatTicket = null;
var selectedHumanChatStatus = "in_progress";

function humanChatValue(id) { var el = document.getElementById(id); return el ? el.value.trim() : ""; }
function setHumanChatValue(id, value) { var el = document.getElementById(id); if (el) el.value = value || ""; }
function setHumanChatText(id, value) { var el = document.getElementById(id); if (el) el.textContent = value || "-"; }

function humanChatStatusLabel(status) {
  return {in_progress: "Diambil CS", resolved: "Selesai", archived: "Archive", canceled: "Archive"}[status] || "Diambil CS";
}

function setHumanChatStatus(status, button) {
  selectedHumanChatStatus = status || "in_progress";
  document.querySelectorAll(".human-chat-filter button").forEach(function (btn) { btn.classList.remove("active"); });
  if (button) button.classList.add("active");
  clearHumanChatSelection(true);
  loadHumanChatTickets();
}

function isHumanChatReadonly(status) {
  return status === "resolved" || status === "archived" || status === "canceled";
}

async function loadHumanChatTickets() {
  var list = document.getElementById("human-chat-ticket-list");
  if (!list) return;
  var query = humanChatValue("human-chat-search-input");
  list.innerHTML = '<div class="memory-empty">Memuat chat ' + humanChatStatusLabel(selectedHumanChatStatus).toLowerCase() + '...</div>';
  try {
    var data = await (await fetch("/api/ai-system/human-handoff?status=" + encodeURIComponent(selectedHumanChatStatus) + "&q=" + encodeURIComponent(query))).json();
    currentHumanChatTickets = Array.isArray(data.items) ? data.items : [];
    var title = document.getElementById("human-chat-list-title");
    if (title) title.textContent = selectedHumanChatStatus === "resolved" ? "Chat Selesai" : (selectedHumanChatStatus === "archived" ? "Chat Archive" : "Chat Diambil CS");
    if (!currentHumanChatTickets.length) {
      list.innerHTML = '<div class="memory-empty">Belum ada chat ' + escHtml(humanChatStatusLabel(selectedHumanChatStatus).toLowerCase()) + '.</div>';
      clearHumanChatSelection(true);
      return;
    }
    list.innerHTML = currentHumanChatTickets.map(function (item) {
      return '<button type="button" class="human-chat-ticket-item" onclick="selectHumanChatTicket(' + item.id + ')">'
        + '<div><strong>' + escHtml(item.user_number || '-') + '</strong><span>' + escHtml(item.owner || 'CS Team') + '</span></div>'
        + '<p>' + escHtml(item.reason || '-') + '</p>'
        + '<div class="handoff-item-meta"><span class="handoff-priority priority-' + escHtml(item.priority || 'medium') + '">' + escHtml(handoffPriorityLabel(item.priority)) + '</span><span>' + escHtml(humanChatStatusLabel(item.status || selectedHumanChatStatus)) + '</span></div>'
        + '</button>';
    }).join("");
  } catch (error) {
    list.innerHTML = '<div class="memory-empty">Gagal memuat Human Chat.</div>';
  }
}

function selectHumanChatTicket(ticketId) {
  var item = currentHumanChatTickets.find(function (entry) { return entry.id === ticketId; });
  if (!item) return;
  selectedHumanChatTicket = item;
  setHumanChatText("human-chat-title", "Ticket #" + item.id + " - " + (item.user_number || "Unknown"));
  setHumanChatText("human-chat-subtitle", isHumanChatReadonly(item.status) ? "Mode arsip. Chat ini sudah tidak aktif untuk dibalas." : "AI pause operasional. CS membalas manual dari panel ini.");
  setHumanChatText("human-chat-ticket-id", item.id);
  setHumanChatText("human-chat-user-number", item.user_number || "-");
  setHumanChatText("human-chat-owner", item.owner || "CS Team");
  setHumanChatText("human-chat-priority", handoffPriorityLabel(item.priority));
  setHumanChatText("human-chat-reason", item.reason || "-");
  setHumanChatText("human-chat-notes", item.notes || "-");
  var sendBtn = document.getElementById("human-chat-send-btn");
  var resolveBtn = document.getElementById("human-chat-resolve-btn");
  var archiveBtn = document.getElementById("human-chat-archive-btn");
  var readonly = isHumanChatReadonly(item.status);
  if (sendBtn) sendBtn.disabled = readonly;
  if (resolveBtn) resolveBtn.disabled = readonly;
  if (archiveBtn) archiveBtn.disabled = readonly;
  setHumanChatValue("human-chat-message", "");
  var compose = document.querySelector(".human-chat-compose");
  if (compose) compose.classList.toggle("readonly", readonly);
  loadHumanChatHistory(item.user_number);
}

function clearHumanChatSelection(skipList) {
  selectedHumanChatTicket = null;
  setHumanChatText("human-chat-title", "Pilih Chat");
  setHumanChatText("human-chat-subtitle", "Pilih chat dari filter Diambil, Selesai, atau Archive.");
  ["human-chat-ticket-id", "human-chat-user-number", "human-chat-owner", "human-chat-priority", "human-chat-reason", "human-chat-notes"].forEach(function (id) { setHumanChatText(id, "-"); });
  setHumanChatValue("human-chat-message", "");
  var history = document.getElementById("human-chat-history");
  if (history) history.innerHTML = '<div class="memory-empty">Pilih ticket untuk melihat chat.</div>';
  var sendBtn = document.getElementById("human-chat-send-btn");
  var resolveBtn = document.getElementById("human-chat-resolve-btn");
  var archiveBtn = document.getElementById("human-chat-archive-btn");
  if (sendBtn) sendBtn.disabled = true;
  if (resolveBtn) resolveBtn.disabled = true;
  if (archiveBtn) archiveBtn.disabled = true;
  var compose = document.querySelector(".human-chat-compose");
  if (compose) compose.classList.remove("readonly");
  if (!skipList) loadHumanChatTickets();
}

async function loadHumanChatHistory(userNumber) {
  var target = document.getElementById("human-chat-history");
  if (!target) return;
  target.innerHTML = '<div class="memory-empty">Memuat history chat...</div>';
  try {
    var history = await (await fetch("/api/conversation/history/" + encodeURIComponent(userNumber) + "?limit=80")).json();
    if (!Array.isArray(history) || !history.length) {
      target.innerHTML = '<div class="memory-empty">Belum ada history chat untuk nomor ini.</div>';
      return;
    }
    target.innerHTML = history.map(function (row) {
      var role = String(row.role || "").toLowerCase();
      var isCustomer = role === "user" || role === "customer";
      var label = isCustomer ? "Customer" : (role === "system_note" ? "Note" : "CS/AI");
      return '<div class="human-chat-bubble ' + (isCustomer ? 'customer' : 'assistant') + '">'
        + '<div><strong>' + escHtml(label) + '</strong><span>' + escHtml(row.timestamp || '-') + '</span></div>'
        + '<p>' + escHtml(row.content || '-') + '</p>'
        + '</div>';
    }).join("");
    target.scrollTop = target.scrollHeight;
  } catch (error) {
    target.innerHTML = '<div class="memory-empty">Gagal memuat history chat.</div>';
  }
}

async function sendHumanChatMessage() {
  if (!selectedHumanChatTicket) {
    toast("Pilih chat dulu", "var(--red)");
    return;
  }
  if (isHumanChatReadonly(selectedHumanChatTicket.status)) {
    toast("Chat arsip tidak bisa dibalas", "var(--red)");
    return;
  }
  var message = humanChatValue("human-chat-message");
  if (!message) {
    toast("Isi pesan balasan dulu", "var(--red)");
    return;
  }
  if (!(await confirmAiSystemAction("Kirim pesan ke customer?", "Pesan akan dikirim lewat WhatsApp dan masuk history chat."))) return;
  try {
    var res = await fetch("/api/wa/send-message", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({to: selectedHumanChatTicket.user_number, message: message})
    });
    var data = await res.json();
    if (!data.success) throw new Error(data.error || "Kirim pesan gagal");
    setHumanChatValue("human-chat-message", "");
    toast("Pesan terkirim");
    await loadHumanChatHistory(selectedHumanChatTicket.user_number);
  } catch (error) {
    toast("Gagal kirim pesan: " + (error.message || ""), "var(--red)");
  }
}

async function resolveHumanChatTicket() {
  if (!selectedHumanChatTicket) {
    toast("Pilih chat dulu", "var(--red)");
    return;
  }
  if (!(await confirmAiSystemAction("Selesaikan chat ini?", "Chat akan pindah ke status Selesai dan keluar dari Human Chat."))) return;
  try {
    var res = await fetch("/api/ai-system/human-handoff/" + encodeURIComponent(selectedHumanChatTicket.id), {
      method: "PUT",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({status: "resolved", owner: selectedHumanChatTicket.owner || "CS Team", notes: selectedHumanChatTicket.notes || "Diselesaikan dari Human Chat"})
    });
    var data = await res.json();
    if (!data.success) throw new Error(data.error || "Selesaikan chat gagal");
    toast("Ticket selesai");
    clearHumanChatSelection(true);
    loadHumanChatTickets();
    loadHumanHandoffs();
  } catch (error) {
    toast("Gagal selesaikan ticket", "var(--red)");
  }
}

async function archiveHumanChatTicket() {
  if (!selectedHumanChatTicket) {
    toast("Pilih chat dulu", "var(--red)");
    return;
  }
  if (!(await confirmAiSystemAction("Archive ticket chat ini?", "Chat akan pindah ke Archive dan keluar dari chat aktif."))) return;
  try {
    var res = await fetch("/api/ai-system/human-handoff/" + encodeURIComponent(selectedHumanChatTicket.id), {
      method: "PUT",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({status: "archived", owner: selectedHumanChatTicket.owner || "CS Team", notes: selectedHumanChatTicket.notes || "Di-skip/archive dari Human Chat"})
    });
    var data = await res.json();
    if (!data.success) throw new Error(data.error || "Archive ticket gagal");
    toast("Chat masuk Archive");
    clearHumanChatSelection(true);
    loadHumanChatTickets();
    loadHumanHandoffs();
  } catch (error) {
    toast("Gagal archive ticket", "var(--red)");
  }
}

