// ================================================================
// RENDER HELPERS
// ================================================================
function escHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderMedia(url, options) {
  if (!url) return "";
  options = options || {};
  var safeUrl = escHtml(url);
  if (url.match(/\.(mp4|mov|webm)$/i)) return '<video src="' + safeUrl + '" controls style="max-height:180px;border-radius:8px;margin-top:12px;max-width:100%"></video>';
  var title = escHtml(options.title || "Preview media");
  if (options.previewModal) {
    return '<img src="' + safeUrl + '" alt="' + title + '" data-preview-title="' + title + '" data-preview-modal="true" class="media-thumb">';
  }
  return '<img src="' + safeUrl + '" alt="' + title + '" data-preview-title="' + title + '" class="media-thumb" onclick="window.open(this.src)">';
}

function openMediaPreview(eventOrImg, imgMaybe) {
  if (eventOrImg && eventOrImg.preventDefault) {
    eventOrImg.preventDefault();
    eventOrImg.stopPropagation();
  }
  var img = imgMaybe || eventOrImg;
  var modal = document.getElementById("modal-media-preview");
  var preview = document.getElementById("media-preview-content");
  var title = document.getElementById("media-preview-title");
  if (!modal || !preview || !img) return;

  var source = img.getAttribute("src") || "";
  var label = img.getAttribute("data-preview-title") || "Preview testimoni";
  if (title) title.textContent = label;
  preview.innerHTML = '<img src="' + escHtml(source) + '" alt="' + escHtml(label) + '" class="media-preview-image">';
  modal.classList.add("active", "open");
}

function closeMediaPreview() {
  var modal = document.getElementById("modal-media-preview");
  var preview = document.getElementById("media-preview-content");
  if (preview) preview.innerHTML = "";
  if (modal) modal.classList.remove("active", "open");
}

document.addEventListener("click", function (event) {
  var target = event.target && event.target.closest ? event.target.closest(".media-thumb[data-preview-modal='true']") : null;
  if (!target || target.getAttribute("data-preview-modal") !== "true") return;
  openMediaPreview(event, target);
});

function renderAnswerText(text) {
  var lines = String(text || "").split(/\n+/).map(function (line) { return line.trim(); }).filter(Boolean);
  if (!lines.length) return "<p>-</p>";
  var html = "";
  var inList = false;
  lines.forEach(function (line) {
    var bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += "<li>" + escHtml(bullet[1]) + "</li>";
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      html += "<p>" + escHtml(line) + "</p>";
    }
  });
  if (inList) html += "</ul>";
  return html;
}

async function previewFile(inputId, previewId, hiddenId) {
  var file = document.getElementById(inputId).files[0];
  if (!file) return;
  var preview = document.getElementById(previewId);
  var hidden = document.getElementById(hiddenId);
  if (hidden) hidden.value = "";
  preview.innerHTML = '<span style="color:var(--text2);font-size:12px">Uploading...</span>';
  var fd = new FormData(); fd.append("file", file);
  try {
    var res = await fetch("/api/upload", { method: "POST", body: fd });
    var data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || "Upload gagal");
    if (data.success) {
      if (hidden) hidden.value = data.url;
      preview.innerHTML = renderMedia(data.url);
    }
  } catch (e) { preview.innerHTML = '<span style="color:var(--red)">' + escHtml(e.message || "Upload gagal") + '</span>'; }
}
