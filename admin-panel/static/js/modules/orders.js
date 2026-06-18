// ================================================================
// ORDERS
// ================================================================
async function loadOrders(status, tabEl){
  if(tabEl){
    document.querySelectorAll("#section-orders .filter-tab").forEach(function(t){ t.classList.remove("active"); });
    tabEl.classList.add("active");
  }
  var url = status ? "/api/orders?status="+status : "/api/orders";
  var orders = await (await fetch(url)).json();
  var nc = orders.filter(function(o){ return o.status === "new"; }).length;
  var b = document.getElementById("new-order-count"); b.textContent = nc; b.style.display = nc?"inline":"none";
  document.getElementById("orders-empty").style.display = orders.length ? "none" : "block";
  var list = document.getElementById("orders-list");
  list.innerHTML = "";
  orders.forEach(function(o){
    var displayId = o.public_order_id || o.id;
    var statusBadges = {new:'<span class="badge badge-blue">Baru</span>', process:'<span class="badge badge-amber">Proses</span>', done:'<span class="badge badge-green">Selesai</span>', cancelled:'<span class="badge badge-red">Batal</span>'};
    var div = document.createElement("div");
    div.className = "order-card";
    div.innerHTML = '<div class="order-header">'
      +'<div><span class="order-id">#'+displayId+'</span><span style="font-size:13px;font-weight:600;margin-left:10px">'+(o.user_name||"Unknown")+'</span></div>'
      +'<div style="display:flex;align-items:center;gap:8px"><span style="font-size:11px;color:var(--text3)">'+o.timestamp+'</span>'+(statusBadges[o.status]||"")+'</div>'
      +'</div>'
      +'<div class="order-grid">'
      +'<div class="order-field"><div class="order-field-label">WA</div><div class="order-field-value" style="font-size:12px">'+o.user_number+'</div></div>'
      +'<div class="order-field"><div class="order-field-label">HP</div><div class="order-field-value">'+(o.phone||"-")+'</div></div>'
      +'<div class="order-field"><div class="order-field-label">Produk</div><div class="order-field-value">'+(o.product||"-")+' x'+(o.quantity||1)+'<br><span style="color:var(--teal);font-weight:700">'+(o.total||"-")+'</span></div></div>'
      +'<div class="order-field"><div class="order-field-label">Alamat</div><div class="order-field-value" style="font-size:12px">'+(o.address||"-")+'</div></div>'
      +'</div>'
      +(o.notes?'<div style="background:var(--amber-dim);border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:10px;color:var(--amber)">'+o.notes+'</div>':"")
      +'<div class="order-actions" id="oa-'+o.id+'"></div>';
    list.appendChild(div);
    var actions = document.getElementById("oa-"+o.id);
    [["new","btn-ghost","Baru"],["process","btn-ghost","Proses"],["done","btn-ghost","Selesai"],["cancelled","btn-danger","Batal"]].forEach(function(s){
      var btn = document.createElement("button");
      btn.className = "btn "+s[1]+" btn-xs"; btn.textContent = s[2];
      btn.setAttribute("data-oid", o.id); btn.setAttribute("data-st", s[0]);
      btn.onclick = function(){ updateOrder(parseInt(this.dataset.oid), this.dataset.st); };
      actions.appendChild(btn);
    });
    var delBtn = document.createElement("button");
    delBtn.className = "btn btn-danger btn-xs"; delBtn.textContent = "Hapus"; delBtn.style.marginLeft = "auto";
    delBtn.setAttribute("data-oid", o.id);
    delBtn.onclick = function(){ deleteOrder(parseInt(this.dataset.oid)); };
    actions.appendChild(delBtn);
  });
}
async function updateOrder(id, status){
  await fetch("/api/orders/"+id, {method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify({status:status})});
  loadOrders("", null); toast("Status diperbarui");
}
async function deleteOrder(id){
  if(!confirm("Hapus order?")) return;
  await fetch("/api/orders/"+id, {method:"DELETE"});
  loadOrders("", null); toast("Dihapus", "var(--red)");
}
