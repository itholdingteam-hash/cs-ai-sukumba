// ================================================================
// INIT
// ================================================================
document.addEventListener("DOMContentLoaded", function () {
  if (typeof showSection === "function") {
    showSection("whatsapp");
  }

  if (typeof loadWAStatus === "function") {
    loadWAStatus();
    setInterval(loadWAStatus, 30000);
  }

  if (typeof loadCsTemplates === "function") {
    loadCsTemplates();
  }
});
