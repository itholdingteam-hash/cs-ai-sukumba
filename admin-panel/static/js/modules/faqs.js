// ================================================================
// FAQs
// ================================================================
async function loadFAQs(){
  try {
    var faqs = await api.get("/api/faqs");
    document.getElementById("faqs-count").textContent = faqs.length;
    document.getElementById("faqs-empty").style.display = faqs.length ? "none" : "block";
    var list = document.getElementById("faqs-list");
    list.innerHTML = "";
    faqs.forEach(function(f){
      var div = document.createElement("div");
      div.className = "faq-card";
      div.innerHTML = '<div class="faq-head">'
        +'<div style="min-width:0">'
        +'<span class="faq-source">Baseline FAQ</span>'
        +'<div class="faq-question">'+escHtml(f.question)+'</div>'
        +'</div>'
        +'<div class="product-actions">'
        +'<button class="btn btn-ghost btn-xs" data-id="'+f.id+'" title="Edit FAQ" aria-label="Edit FAQ" onclick="editFaqById(this)">&#x270F;</button>'
        +'<button class="btn btn-danger btn-xs" data-id="'+f.id+'" title="Hapus FAQ" aria-label="Hapus FAQ" onclick="deleteFaqById(this)">&#x1F5D1;</button>'
        +'</div>'
        +'</div>'
        +'<div class="faq-answer">'+renderAnswerText(f.answer)+renderMedia(f.image_url)+'</div>';
      div._faq = f;
      list.appendChild(div);
    });
  } catch (err) {
    toast(err.message || "Gagal memuat FAQ", "var(--red)");
  }
}

function openFaqModal(){
  document.getElementById("modal-faq-title").textContent = "Tambah FAQ";
  document.getElementById("f-id").value = "";
  document.getElementById("f-question").value = "";
  document.getElementById("f-answer").value = "";
  document.getElementById("f-image-url").value = "";
  document.getElementById("f-preview").innerHTML = "";
  var file = document.getElementById("f-file");
  if (file) file.value = "";
  openModal("modal-faq");
}

function editFaqById(btn){
  var f = btn.closest(".faq-card")._faq;
  document.getElementById("modal-faq-title").textContent = "Edit FAQ";
  document.getElementById("f-id").value = f.id;
  document.getElementById("f-question").value = f.question;
  document.getElementById("f-answer").value = f.answer;
  document.getElementById("f-image-url").value = f.image_url||"";
  document.getElementById("f-preview").innerHTML = f.image_url ? renderMedia(f.image_url) : "";
  openModal("modal-faq");
}

async function deleteFaqById(btn){
  if(!confirm("Hapus FAQ?")) return;
  try {
    await api.delete("/api/faqs/"+btn.dataset.id);
    loadFAQs();
    toast("Dihapus", "var(--red)");
  } catch (err) {
    toast(err.message || "Gagal menghapus FAQ", "var(--red)");
  }
}

async function saveFaq(){
  var id = document.getElementById("f-id").value;
  var data = {
    question: document.getElementById("f-question").value,
    answer: document.getElementById("f-answer").value,
    image_url: document.getElementById("f-image-url").value
  };
  try {
    if (id) {
      await api.put("/api/faqs/"+id, data);
    } else {
      await api.post("/api/faqs", data);
    }
    closeModal("modal-faq");
    loadFAQs();
    toast("FAQ disimpan!");
  } catch (err) {
    toast(err.message || "Gagal menyimpan FAQ", "var(--red)");
  }
}
