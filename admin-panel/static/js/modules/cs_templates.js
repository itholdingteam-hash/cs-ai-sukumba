// ================================================================
// CS TEMPLATES
// ================================================================

function escapeCsTemplateAttr(item) {
  return encodeURIComponent(JSON.stringify(item));
}

function parseCsTemplateAttr(value) {
  return JSON.parse(decodeURIComponent(value));
}

function templatePreview(content) {
  const text = String(content || "-").trim();
  return text.length > 360 ? text.slice(0, 357).trimEnd() + "..." : text;
}

async function loadCsTemplates() {
  const list = document.getElementById("cs-templates-table-body");
  const count = document.getElementById("cs-templates-count");

  if (!list) {
    console.warn("Element #cs-templates-table-body tidak ditemukan.");
    return;
  }

  if (count) count.textContent = "Memuat...";
  list.innerHTML = `<div class="cs-template-state">Memuat data...</div>`;

  try {
    const res = await fetch("/api/cs-templates", {
      method: "GET",
      cache: "no-store"
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.message || "Gagal memuat CS Template");
    }

    if (!Array.isArray(data) || data.length === 0) {
      if (count) count.textContent = "0 template";
      list.innerHTML = `<div class="cs-template-state">Belum ada template CS.</div>`;
      return;
    }

    if (count) count.textContent = `${data.length} template`;

    list.innerHTML = data.map(function (item, index) {
      const encodedItem = escapeCsTemplateAttr(item);
      const content = templatePreview(item.content);

      return `
        <article class="cs-template-card">
          <div class="cs-template-main">
            <div class="cs-template-index">${String(index + 1).padStart(2, "0")}</div>
            <div class="cs-template-body">
              <div class="cs-template-title">${escHtml(item.title || "-")}</div>
              <div class="cs-template-preview">${escHtml(content)}</div>
            </div>
          </div>

          <div class="cs-template-actions">
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              onclick="editCsTemplateFromAttr('${encodedItem}')">
              Edit
            </button>

            <button
              class="btn btn-danger btn-sm"
              type="button"
              onclick="deleteCsTemplate(${item.id})">
              Hapus
            </button>
          </div>
        </article>
      `;
    }).join("");

  } catch (err) {
    console.error("loadCsTemplates error:", err);
    if (count) count.textContent = "Gagal";

    list.innerHTML = `
      <div class="cs-template-state cs-template-state-error">
        ${escHtml(err.message || "Gagal memuat CS Template")}
      </div>
    `;
  }
}

function openCsTemplateModal() {
  document.getElementById("modal-cs-template-title").innerHTML = "&#x2795; Tambah Template CS";
  document.getElementById("cst-id").value = "";
  document.getElementById("cst-title").value = "";
  document.getElementById("cst-content").value = "";

  openModal("modal-cs-template");
}

function editCsTemplateFromAttr(encodedValue) {
  const item = parseCsTemplateAttr(encodedValue);
  editCsTemplate(item);
}

function editCsTemplate(item) {
  document.getElementById("modal-cs-template-title").innerHTML = "&#x270F;&#xFE0F; Edit Template CS";
  document.getElementById("cst-id").value = item.id || "";
  document.getElementById("cst-title").value = item.title || "";
  document.getElementById("cst-content").value = item.content || "";

  openModal("modal-cs-template");
}

async function saveCsTemplate() {
  const id = document.getElementById("cst-id").value;
  const title = document.getElementById("cst-title").value.trim();
  const content = document.getElementById("cst-content").value.trim();

  if (!title) {
    alert("Judul/Topik wajib diisi.");
    return;
  }

  if (!content) {
    alert("Isi Template wajib diisi.");
    return;
  }

  const url = id ? `/api/cs-templates/${id}` : "/api/cs-templates";
  const method = id ? "PUT" : "POST";

  try {
    const res = await fetch(url, {
      method: method,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title: title,
        content: content
      })
    });

    const result = await res.json();

    if (!res.ok || result.success === false) {
      throw new Error(result.message || "Gagal menyimpan CS Template");
    }

    closeModal("modal-cs-template");
    await loadCsTemplates();

    alert(result.message || "CS Template berhasil disimpan.");

  } catch (err) {
    console.error("saveCsTemplate error:", err);
    alert(err.message || "Gagal menyimpan CS Template.");
  }
}

async function deleteCsTemplate(id) {
  const ok = confirm("Yakin ingin menghapus CS Template ini?");

  if (!ok) return;

  try {
    const res = await fetch(`/api/cs-templates/${id}`, {
      method: "DELETE"
    });

    const result = await res.json();

    if (!res.ok || result.success === false) {
      throw new Error(result.message || "Gagal menghapus CS Template");
    }

    await loadCsTemplates();
    alert(result.message || "CS Template berhasil dihapus.");

  } catch (err) {
    console.error("deleteCsTemplate error:", err);
    alert(err.message || "Gagal menghapus CS Template.");
  }
}
