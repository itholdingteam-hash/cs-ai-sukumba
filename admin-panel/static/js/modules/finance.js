// ================================================================
// FINANCE / PAYMENT PROOFS
// ================================================================
var currentPaymentProofStatus = "";

function paymentProofBadge(status) {
  var badges = {
    pending: '<span class="badge badge-amber">Menunggu cek</span>',
    valid: '<span class="badge badge-green">Valid</span>',
    invalid: '<span class="badge badge-red">Tidak valid</span>'
  };
  return badges[status] || '<span class="badge badge-blue">' + escHtml(status || "-") + "</span>";
}

function paymentProofOrderLabel(proof) {
  if (!proof.order_id) return '<span class="badge badge-red">Belum cocok order</span>';
  return '<span class="badge badge-blue">Order #' + escHtml(proof.public_order_id || proof.order_id) + "</span>";
}

async function loadPaymentProofs(status, tabEl) {
  if (typeof status === "string") currentPaymentProofStatus = status;
  status = typeof status === "string" ? status : currentPaymentProofStatus;

  if (tabEl) {
    document.querySelectorAll("#section-finance .filter-tab").forEach(function (t) { t.classList.remove("active"); });
    tabEl.classList.add("active");
  }

  var url = status ? "/api/payment-proofs?status=" + encodeURIComponent(status) : "/api/payment-proofs";
  var proofs = await (await fetch(url)).json();
  var pendingCount = proofs.filter(function (p) { return p.status === "pending"; }).length;
  if (!status) updatePendingProofBadge(pendingCount);

  var empty = document.getElementById("payment-proofs-empty");
  var list = document.getElementById("payment-proofs-list");
  if (empty) empty.style.display = proofs.length ? "none" : "block";
  if (!list) return;
  list.innerHTML = "";

  proofs.forEach(function (p) {
    var div = document.createElement("div");
    div.className = "order-card finance-proof-card";
    div.innerHTML = '<div class="order-header">'
      + '<div><span class="order-id">Bukti #' + escHtml(p.id) + '</span><span style="margin-left:8px">' + paymentProofBadge(p.status) + '</span><span style="margin-left:8px">' + paymentProofOrderLabel(p) + '</span></div>'
      + '<div style="font-size:11px;color:var(--text3)">' + escHtml(p.created_at || "-") + '</div>'
      + '</div>'
      + '<div class="finance-proof-layout">'
      + '<div class="finance-proof-media">' + renderMedia(p.media_url, { previewModal: true, title: "Bukti transfer #" + p.id }) + '</div>'
      + '<div class="finance-proof-info">'
      + '<div class="order-grid">'
      + '<div class="order-field"><div class="order-field-label">Customer</div><div class="order-field-value">' + escHtml(p.user_name || "Unknown") + '<br><span style="font-size:12px;color:var(--text3)">' + escHtml(p.user_number || "-") + '</span></div></div>'
      + '<div class="order-field"><div class="order-field-label">HP</div><div class="order-field-value">' + escHtml(p.phone || "-") + '</div></div>'
      + '<div class="order-field"><div class="order-field-label">Produk</div><div class="order-field-value">' + escHtml(p.product || "-") + '<br><span style="color:var(--teal);font-weight:700">' + escHtml(p.total || "-") + '</span></div></div>'
      + '<div class="order-field"><div class="order-field-label">Order</div><div class="order-field-value">' + (p.order_id ? "#" + escHtml(p.public_order_id || p.order_id) : "Belum otomatis cocok") + '<br><span style="font-size:12px;color:var(--text3)">Status: ' + escHtml(p.order_status || "-") + '</span></div></div>'
      + '</div>'
      + (p.caption ? '<div class="finance-caption">' + escHtml(p.caption) + '</div>' : "")
      + (p.reviewer_note ? '<div class="finance-note">Catatan pembayaran: ' + escHtml(p.reviewer_note) + '</div>' : "")
      + '<div class="order-actions" id="proof-actions-' + escHtml(p.id) + '"></div>'
      + '</div>'
      + '</div>';
    list.appendChild(div);

    var actions = document.getElementById("proof-actions-" + p.id);
    [["pending", "btn-ghost", "Menunggu"], ["valid", "btn-ghost", "Valid"], ["invalid", "btn-danger", "Tidak valid"]].forEach(function (s) {
      var btn = document.createElement("button");
      btn.className = "btn " + s[1] + " btn-xs";
      btn.textContent = s[2];
      btn.setAttribute("data-id", p.id);
      btn.setAttribute("data-status", s[0]);
      btn.onclick = function () { updatePaymentProof(parseInt(this.dataset.id), this.dataset.status); };
      actions.appendChild(btn);
    });
  });
}

function updatePendingProofBadge(count) {
  var badge = document.getElementById("pending-proof-count");
  if (!badge) return;
  badge.textContent = count;
  badge.style.display = count ? "inline" : "none";
}

async function updatePaymentProof(id, status) {
  var note = "";
  if (status === "invalid") {
    note = prompt("Catatan untuk bukti tidak valid:", "") || "";
  }
  var res = await fetch("/api/payment-proofs/" + id, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: status, reviewer_note: note })
  });
  var data = await res.json();
  loadPaymentProofs(currentPaymentProofStatus, null);
  if (status === "valid" || status === "invalid") {
    toast(data.wa_sent ? "Status diperbarui, customer sudah dinotifikasi" : "Status diperbarui, tapi WA belum terkirim", data.wa_sent ? "" : "error");
  } else {
    toast("Status bukti transfer diperbarui");
  }
}
