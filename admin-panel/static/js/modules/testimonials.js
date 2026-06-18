// ================================================================
// TESTIMONIALS
// ================================================================
async function loadTestimonials(){
  var testimonials;
  try {
    testimonials = await api.get("/api/testimonials");
  } catch (err) {
    toast("Gagal memuat testimoni", "error");
    return;
  }
  document.getElementById("testimonials-count").textContent = testimonials.length;
  document.getElementById("testimonials-empty").style.display = testimonials.length ? "none" : "block";
  var list = document.getElementById("testimonials-list");
  list.innerHTML = "";
  testimonials.forEach(function(t){
    var div = document.createElement("div");
    div.className = "faq-card";
    div.innerHTML = '<div class="faq-head">'
      +'<div style="min-width:0">'
      +'<span class="faq-source">Testimoni #' + escHtml(t.sort_order || 0) + '</span>'
      +'<div class="faq-question">'+escHtml(t.title)+'</div>'
      +'</div>'
      +'<div class="product-actions">'
      +'<button class="btn btn-ghost btn-xs" data-id="'+t.id+'" title="Edit Testimoni" aria-label="Edit Testimoni" onclick="editTestimonialById(this)">&#x270F;</button>'
      +'<button class="btn btn-danger btn-xs" data-id="'+t.id+'" title="Hapus Testimoni" aria-label="Hapus Testimoni" onclick="deleteTestimonialById(this)">&#x1F5D1;</button>'
      +'</div>'
      +'</div>'
      +'<div class="faq-answer">'+renderAnswerText(t.caption || "Media testimoni customer.")+renderMedia(t.media_url, { previewModal: true, title: t.title || "Testimoni customer" })+'</div>';
    div._testimonial = t;
    list.appendChild(div);
  });
}

function openTestimonialModal(){
  document.getElementById("modal-testimonial-title").innerHTML = "&#x2795; Tambah Testimoni";
  document.getElementById("t-id").value = "";
  document.getElementById("t-title").value = "";
  document.getElementById("t-caption").value = "";
  document.getElementById("t-sort-order").value = "0";
  document.getElementById("t-media-url").value = "";
  document.getElementById("t-file").value = "";
  document.getElementById("t-preview").innerHTML = "";
  openModal("modal-testimonial");
}

function editTestimonialById(btn){
  var t = btn.closest(".faq-card")._testimonial;
  document.getElementById("modal-testimonial-title").textContent = "Edit Testimoni";
  document.getElementById("t-id").value = t.id;
  document.getElementById("t-title").value = t.title || "";
  document.getElementById("t-caption").value = t.caption || "";
  document.getElementById("t-sort-order").value = t.sort_order || 0;
  document.getElementById("t-media-url").value = t.media_url || "";
  document.getElementById("t-file").value = "";
  document.getElementById("t-preview").innerHTML = t.media_url ? renderMedia(t.media_url, { previewModal: true, title: t.title || "Testimoni customer" }) : "";
  openModal("modal-testimonial");
}

async function deleteTestimonialById(btn){
  if(!confirm("Hapus testimoni?")) return;
  try {
    await api.delete("/api/testimonials/"+btn.dataset.id);
    loadTestimonials();
    toast("Testimoni dihapus", "error");
  } catch (err) {
    toast(err.message || "Gagal menghapus testimoni", "error");
  }
}

async function saveTestimonial(){
  var id = document.getElementById("t-id").value;
  var data = {
    title: document.getElementById("t-title").value,
    caption: document.getElementById("t-caption").value,
    media_url: document.getElementById("t-media-url").value,
    sort_order: parseInt(document.getElementById("t-sort-order").value || "0", 10)
  };
  if (!data.title.trim()) {
    toast("Judul testimoni wajib diisi", "error");
    return;
  }
  if (!data.media_url.trim()) {
    toast("Foto/video testimoni wajib diisi", "error");
    return;
  }
  try {
    if (id) {
      await api.put("/api/testimonials/"+id, data);
    } else {
      await api.post("/api/testimonials", data);
    }
    closeModal("modal-testimonial");
    loadTestimonials();
    toast("Testimoni disimpan!");
  } catch (err) {
    toast(err.message || "Gagal menyimpan testimoni", "error");
  }
}
