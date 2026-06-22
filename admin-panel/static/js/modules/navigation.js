// ================================================================
// NAVIGATION
// ================================================================

function setActiveNav(sectionName) {
  document.querySelectorAll(".nav-item").forEach(function (item) {
    item.classList.remove("active");
    if (item.getAttribute("onclick") === "showSection('" + sectionName + "')") {
      item.classList.add("active");
    }
  });
}

function updatePageTitle(sectionName) {
  var meta = pageTitles[sectionName] || [sectionName, ""];
  var title = document.getElementById("page-title");
  var subtitle = document.getElementById("page-sub");

  if (title) title.textContent = meta[0];
  if (subtitle) subtitle.textContent = meta[1];
}

function loadSectionData(sectionName) {
  if (sectionName === "products" && typeof loadProducts === "function") loadProducts();
  if (sectionName === "faqs" && typeof loadFAQs === "function") loadFAQs();
  if (sectionName === "testimonials" && typeof loadTestimonials === "function") loadTestimonials();
  if (sectionName === "cs-templates" && typeof loadCsTemplates === "function") loadCsTemplates();
  if (sectionName === "test" && typeof loadSettings === "function") loadSettings();
  if (sectionName === "prompt" && typeof loadPrompts === "function") loadPrompts();
  if (sectionName === "orders" && typeof loadOrders === "function") loadOrders();
  if (sectionName === "finance" && typeof loadPaymentProofs === "function") loadPaymentProofs();
  if (sectionName === "shipping" && typeof loadShippingRates === "function") loadShippingRates();
  if (sectionName === "logs" && typeof loadAnalytics === "function") loadAnalytics();
  if (sectionName === "ai-system" && typeof initAiSystemTabs === "function") initAiSystemTabs();
  if (sectionName === "settings") {
    if (typeof loadSettings === "function") loadSettings();
    if (typeof loadTgUsers === "function") loadTgUsers();
  }
}

function showSection(sectionName) {
  var target = document.getElementById("section-" + sectionName);
  if (!target) {
    console.warn("Section tidak ditemukan:", sectionName);
    return;
  }

  document.querySelectorAll(".section").forEach(function (section) {
    section.classList.remove("active");
  });

  target.classList.add("active");
  setActiveNav(sectionName);
  updatePageTitle(sectionName);
  closeSidebar();
  loadSectionData(sectionName);
}

function toggleSidebar() {
  var sidebar = document.querySelector(".sidebar");
  var overlay = document.getElementById("mobile-overlay");
  var button = document.querySelector(".mobile-menu-btn");
  var isOpen = sidebar && sidebar.classList.toggle("open");

  if (overlay) overlay.classList.toggle("open", !!isOpen);
  if (button) button.setAttribute("aria-expanded", isOpen ? "true" : "false");
  document.body.classList.toggle("sidebar-open", !!isOpen);
}

function closeSidebar() {
  var sidebar = document.querySelector(".sidebar");
  var overlay = document.getElementById("mobile-overlay");
  var button = document.querySelector(".mobile-menu-btn");

  if (sidebar) sidebar.classList.remove("open");
  if (overlay) overlay.classList.remove("open");
  if (button) button.setAttribute("aria-expanded", "false");
  document.body.classList.remove("sidebar-open");
}

window.addEventListener("resize", function () {
  if (window.innerWidth > 900) closeSidebar();
});

document.addEventListener("keydown", function (event) {
  if (event.key === "Escape") closeSidebar();
});

function openModal(id) {
  var modal = document.getElementById(id);
  if (modal) modal.classList.add("active");
}

function closeModal(id) {
  var modal = document.getElementById(id);
  if (modal) modal.classList.remove("active");
}

function toast(message, type) {
  var node = document.createElement("div");
  node.className = "toast" + (type === "error" ? " toast-error" : " toast-success");
  node.innerHTML = '<span class="toast-indicator"></span><span>' + escHtml(message || "") + "</span>";
  document.body.appendChild(node);
  window.setTimeout(function () {
    node.remove();
  }, 3000);
}
