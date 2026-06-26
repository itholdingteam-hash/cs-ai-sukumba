// ================================================================
// PRODUCTS
// ================================================================
async function loadProducts(){
  try {
    var products = await api.get("/api/products");
    var featureCount = products.reduce(function(sum,p){ return sum + ((p.features||[]).length || 0); }, 0);
    document.getElementById("products-count").textContent = products.length;
    document.getElementById("features-count").textContent = featureCount;
    document.getElementById("products-empty").style.display = products.length ? "none" : "block";
    var list = document.getElementById("products-list");
    list.innerHTML = "";
    products.forEach(function(p){
      var div = document.createElement("div");
      div.className = "product-item kb-card";
      var features = p.features || [];
      var thumb = p.image_url ? '<img src="'+escHtml(p.image_url)+'" alt="">' : "&#x1F4E6;";
      var feats = features.length
        ? features.map(function(f){ return '<div class="product-feature">'+escHtml(f)+'</div>'; }).join("")
        : '<div class="kb-meta-value">Belum ada manfaat utama.</div>';
      var meta = "";
      if(p.speed) meta += '<div class="kb-meta"><div class="kb-meta-label">Varian/Ukuran</div><div class="kb-meta-value">'+escHtml(p.speed)+'</div></div>';
      if(p.promo) meta += '<div class="kb-meta"><div class="kb-meta-label">Promo</div><div class="kb-meta-value">'+escHtml(p.promo)+'</div></div>';
      if(p.target) meta += '<div class="kb-meta"><div class="kb-meta-label">Target pelanggan</div><div class="kb-meta-value">'+escHtml(p.target)+'</div></div>';
      div.innerHTML = '<div class="kb-card-head">'
        +'<div class="product-thumb">'+thumb+'</div>'
        +'<div style="min-width:0">'
        +'<div class="product-name">'+escHtml(p.name)+'</div>'
        +'<div class="product-price">'+escHtml(p.price)+'</div>'
        +(p.description?'<div class="product-summary">'+escHtml(p.description)+'</div>':'')
        +'</div>'
        +'<div class="product-actions">'
        +'<button class="btn btn-ghost btn-xs" data-id="'+p.id+'" title="Edit produk" aria-label="Edit produk" onclick="editProductById(this)">&#x270F;</button>'
        +'<button class="btn btn-danger btn-xs" data-id="'+p.id+'" title="Hapus produk" aria-label="Hapus produk" onclick="deleteProductById(this)">&#x1F5D1;</button>'
        +'</div>'
        +'</div>'
        +'<div class="kb-card-body">'
        +'<div class="kb-meta-label">Manfaat utama untuk jawaban CS</div>'
        +'<div class="product-features">'+feats+'</div>'
        +(meta?'<div class="kb-meta-grid">'+meta+'</div>':'')
        +renderMedia(p.image_url)
        +'</div>';
      div._product = p;
      list.appendChild(div);
    });
  } catch (err) {
    toast(err.message || "Gagal memuat produk", "var(--red)");
  }
}

function openProductModal(){
  document.getElementById("modal-product-title").textContent = "Tambah Produk";
  document.getElementById("p-id").value = "";
  document.getElementById("p-name").value = "";
  document.getElementById("p-price").value = "";
  document.getElementById("p-speed").value = "";
  document.getElementById("p-features").value = "";
  document.getElementById("p-description").value = "";
  document.getElementById("p-promo").value = "";
  document.getElementById("p-target").value = "";
  document.getElementById("p-image-url").value = "";
  document.getElementById("p-preview").innerHTML = "";
  var file = document.getElementById("p-file");
  if (file) file.value = "";
  openModal("modal-product");
}

function editProductById(btn){
  var p = btn.closest(".product-item")._product;
  document.getElementById("modal-product-title").textContent = "Edit Produk";
  document.getElementById("p-id").value = p.id;
  document.getElementById("p-name").value = p.name;
  document.getElementById("p-price").value = p.price;
  document.getElementById("p-speed").value = p.speed||"";
  document.getElementById("p-features").value = (p.features||[]).join("\n");
  document.getElementById("p-description").value = p.description||"";
  document.getElementById("p-promo").value = p.promo||"";
  document.getElementById("p-target").value = p.target||"";
  document.getElementById("p-image-url").value = p.image_url||"";
  document.getElementById("p-preview").innerHTML = p.image_url ? renderMedia(p.image_url) : "";
  openModal("modal-product");
}

async function deleteProductById(btn){
  if(!confirm("Hapus produk?")) return;
  var id = btn.dataset.id;
  try {
    await api.delete("/api/products/"+id);
    loadProducts();
    toast("Dihapus", "var(--red)");
  } catch (err) {
    toast(err.message || "Gagal menghapus produk", "var(--red)");
  }
}

async function saveProduct(){
  var id = document.getElementById("p-id").value;
  var data = {
    name: document.getElementById("p-name").value,
    price: document.getElementById("p-price").value,
    speed: document.getElementById("p-speed").value,
    features: document.getElementById("p-features").value.split("\n").filter(function(f){ return f.trim(); }),
    description: document.getElementById("p-description").value,
    promo: document.getElementById("p-promo").value,
    target: document.getElementById("p-target").value,
    image_url: document.getElementById("p-image-url").value
  };
  try {
    if (id) {
      await api.put("/api/products/"+id, data);
    } else {
      await api.post("/api/products", data);
    }
    closeModal("modal-product");
    loadProducts();
    toast("Produk disimpan!");
  } catch (err) {
    toast(err.message || "Gagal menyimpan produk", "var(--red)");
  }
}
