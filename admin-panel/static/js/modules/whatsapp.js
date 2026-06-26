// ================================================================
// WHATSAPP
// ================================================================
var waFocusScrollAt = 0;
var waFocusedSection = "";

function loadQRScript(cb){
  if(window.QRCode){ cb(); return; }
  var s = document.createElement("script");
  s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
  s.onload = cb;
  document.head.appendChild(s);
}

function focusWASectionOnMobile(sectionId){
  if(window.innerWidth > 900) return;
  if(waFocusedSection === sectionId) return;

  var section = document.getElementById(sectionId);
  if(!section || section.hidden) return;

  var rect = section.getBoundingClientRect();
  var isComfortablyVisible = rect.top >= 72 && rect.bottom <= window.innerHeight - 16;
  if(isComfortablyVisible) return;

  var now = Date.now();
  if(now - waFocusScrollAt < 4500) return;
  waFocusScrollAt = now;
  waFocusedSection = sectionId;

  setTimeout(function(){
    section.scrollIntoView({behavior:"smooth", block:"start"});
  }, 120);
}

function setWAButtonsLoading(isLoading){
  ["wa-refresh-btn","wa-reconnect-btn","wa-reset-session-btn","wa-disconnect-btn"].forEach(function(id){
    var button = document.getElementById(id);
    if(button) button.disabled = isLoading;
  });
}

function confirmWAAction(options){
  return new Promise(function(resolve){
    var existing = document.getElementById("wa-confirm-overlay");
    if(existing) existing.remove();

    var overlay = document.createElement("div");
    overlay.id = "wa-confirm-overlay";
    overlay.className = "ai-confirm-overlay";
    overlay.innerHTML = '<div class="ai-confirm-dialog wa-confirm-dialog" role="dialog" aria-modal="true">'
      + '<div class="ai-confirm-icon">' + escHtml(options.icon || "!") + '</div>'
      + '<div class="ai-confirm-copy"><h3>' + escHtml(options.title || "Konfirmasi aksi WhatsApp") + '</h3>'
      + '<p>' + escHtml(options.message || "Lanjutkan aksi ini?") + '</p>'
      + (options.detail ? '<small>' + escHtml(options.detail) + '</small>' : '') + '</div>'
      + '<div class="ai-confirm-actions">'
      + '<button class="btn btn-ghost" type="button" data-confirm="no">' + escHtml(options.cancelText || "Batal") + '</button>'
      + '<button class="btn ' + escHtml(options.confirmClass || "btn-primary") + '" type="button" data-confirm="yes">' + escHtml(options.confirmText || "Ya, lanjutkan") + '</button>'
      + '</div>'
      + '</div>';
    document.body.appendChild(overlay);

    function close(value){
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    }

    function onKey(event){
      if(event.key === "Escape") close(false);
      if(event.key === "Enter") close(true);
    }

    overlay.querySelector('[data-confirm="no"]').onclick = function(){ close(false); };
    overlay.querySelector('[data-confirm="yes"]').onclick = function(){ close(true); };
    overlay.addEventListener("click", function(event){
      if(event.target === overlay) close(false);
    });
    document.addEventListener("keydown", onKey);
    setTimeout(function(){
      var button = overlay.querySelector('[data-confirm="yes"]');
      if(button) button.focus();
    }, 0);
  });
}

function setWAStatusView(config){
  var box = document.getElementById("wa-status-big");
  var qrSection = document.getElementById("qr-section");
  var connectingSection = document.getElementById("wa-connecting-section");
  var sidebarDot = document.getElementById("sidebar-dot");
  var sidebarLabel = document.getElementById("sidebar-status");
  var serviceDot = document.getElementById("wa-service-dot");
  var qrContainer = document.getElementById("qr-container");
  var connectingTitle = document.getElementById("wa-connecting-title");
  var connectingSub = document.getElementById("wa-connecting-sub");

  box.className = "wa-overview " + config.state;
  document.getElementById("wa-status-emoji").textContent = config.icon;
  document.getElementById("wa-status-badge").textContent = config.badge;
  document.getElementById("wa-status-label").textContent = config.title;
  document.getElementById("wa-status-sub").textContent = config.description;
  document.getElementById("wa-service-status").textContent = config.service;
  document.getElementById("wa-ai-status").textContent = config.ai;
  document.getElementById("wa-last-check").textContent = new Intl.DateTimeFormat("id-ID", {hour:"2-digit",minute:"2-digit",second:"2-digit"}).format(new Date());

  sidebarDot.className = "dot " + config.state;
  serviceDot.className = "dot " + config.state;
  sidebarLabel.textContent = config.sidebar;
  qrSection.hidden = !config.showQR;
  if(connectingSection) connectingSection.hidden = !config.showConnecting;
  if(connectingTitle) connectingTitle.textContent = config.connectingTitle || "QR diterima, sedang menghubungkan";
  if(connectingSub) connectingSub.textContent = config.connectingDescription || "Tunggu sebentar. Gateway sedang membuat sesi WhatsApp dan menyiapkan AI Customer Service.";
  if(!config.showQR && qrContainer) qrContainer.innerHTML = "";
  if(!config.showQR && !config.showConnecting) waFocusedSection = "";
  if(config.showConnecting) focusWASectionOnMobile("wa-connecting-section");
}

function setWAConnectingView(description){
  setWAStatusView({
    state:"connecting",
    icon:"...",
    badge:"Menghubungkan",
    title:"WhatsApp sedang menghubungkan",
    description:description || "QR sudah diterima. Mohon tunggu beberapa detik sampai sesi WhatsApp siap digunakan.",
    service:"Membuat sesi",
    ai:"Menunggu WhatsApp siap",
    sidebar:"Menghubungkan",
    showQR:false,
    showConnecting:true,
    connectingTitle:"QR diterima, sedang menghubungkan",
    connectingDescription:"Tunggu sebentar. Gateway sedang membuat sesi WhatsApp dan menyiapkan AI Customer Service."
  });
}

async function loadWAStatus(force){
  if(waStatusLoading || (!force && Date.now() < waStatusBackoffUntil)) return;
  waStatusLoading = true;
  setWAButtonsLoading(true);

  try{
    var res = await fetch("/api/wa/status", {headers:{"Accept":"application/json"}});

    if(res.status === 429){
      waStatusBackoffUntil = Date.now() + 60000;
      setWAStatusView({state:"waiting",icon:"⏳",badge:"Terlalu sering diperiksa",title:"Pemeriksaan status dijeda",description:"Tunggu sekitar satu menit, lalu coba muat ulang kembali.",service:"Menunggu",ai:"Belum dapat dipastikan",sidebar:"Menunggu",showQR:false});
      return;
    }

    if(!res.ok) throw new Error("HTTP " + res.status);
    var data = await res.json();

    if(data.status === "connected" && data.isReady){
      setWAStatusView({state:"connected",icon:"✓",badge:"Terhubung",title:"WhatsApp siap digunakan",description:"AI Customer Service aktif dan siap menerima pesan pelanggan.",service:"Aktif dan stabil",ai:"Aktif",sidebar:"Terhubung",showQR:false});
      if(qrInterval){ clearInterval(qrInterval); qrInterval = null; }
      return;
    }

    if(
      data.reconnecting ||
      data.status === "connecting" ||
      (data.status === "connected" && !data.isReady) ||
      (data.status === "waiting_scan" && !data.hasQR && data.hasSocket)
    ){
      setWAConnectingView(data.status === "connected" ? "WhatsApp sudah tersambung, AI sedang disiapkan." : "QR sudah diproses atau socket sedang dibuat. Mohon tunggu sebentar.");
      if(!qrInterval) qrInterval = setInterval(function(){ loadWAStatus(true); }, 3000);
      return;
    }

    if(data.status === "waiting_scan" && data.hasQR){
      setWAStatusView({state:"waiting",icon:"▦",badge:"Menunggu QR",title:"Pindai QR Code untuk melanjutkan",description:"Gunakan menu Perangkat tertaut pada aplikasi WhatsApp.",service:"Menunggu autentikasi",ai:"Belum aktif",sidebar:"Menunggu QR",showQR:true});
      showQR();
      return;
    }

    setWAStatusView({state:"disconnected",icon:"!",badge:"Terputus",title:"WhatsApp belum terhubung",description:"Hubungkan ulang agar AI Customer Service dapat menerima pesan.",service:"Tidak aktif",ai:"Menunggu koneksi",sidebar:"Terputus",showQR:false});
  } catch(error){
    setWAStatusView({state:"disconnected",icon:"!",badge:"Gateway tidak tersedia",title:"Tidak dapat memeriksa koneksi",description:"Pastikan layanan WhatsApp Gateway sedang berjalan, lalu coba lagi.",service:"Tidak dapat dijangkau",ai:"Tidak aktif",sidebar:"Gateway error",showQR:false});
    console.error("Gagal memuat status WhatsApp:", error);
  } finally {
    waStatusLoading = false;
    setWAButtonsLoading(false);
  }
}

async function showQR(){
  try{
    var response = await fetch("/api/wa/qr", {headers:{"Accept":"application/json"}});
    if(!response.ok) throw new Error("HTTP " + response.status);
    var data = await response.json();
    if(!data.success || !data.qr) return;

    loadQRScript(function(){
      var container = document.getElementById("qr-container");
      container.innerHTML = '<div id="qr-canvas"></div>';
      new QRCode(document.getElementById("qr-canvas"), {text:data.qr,width:220,height:220,correctLevel:QRCode.CorrectLevel.M});
      focusWASectionOnMobile("qr-section");
    });
  } catch(error){
    toast("QR Code gagal dimuat", "var(--red)");
    console.error("Gagal memuat QR Code:", error);
  }
}

async function reconnectWA(){
  if(!(await confirmWAAction({
    icon:"↻",
    title:"Hubungkan ulang WhatsApp?",
    message:"Gateway akan mencoba menyambungkan WhatsApp memakai session yang tersimpan.",
    detail:"Gunakan ini kalau WhatsApp belum siap tapi tidak ingin scan QR ulang.",
    confirmText:"Hubungkan sekarang",
    confirmClass:"btn-primary"
  }))) return;
  if(qrInterval){ clearInterval(qrInterval); qrInterval = null; }
  waStatusBackoffUntil = 0;
  setWAButtonsLoading(true);

  try{
    var response = await fetch("/api/wa/reconnect", {method:"POST",headers:{"Accept":"application/json"}});
    if(!response.ok) throw new Error("HTTP " + response.status);
    toast("Proses menghubungkan ulang dimulai");
    setWAConnectingView("Gateway sedang mencoba memakai session WhatsApp yang tersimpan.");
    setTimeout(function(){ loadWAStatus(true); }, 2500);
    qrInterval = setInterval(function(){ loadWAStatus(true); }, 5000);
  } catch(error){
    toast("Gagal menghubungkan ulang WhatsApp", "var(--red)");
    console.error("Reconnect WhatsApp gagal:", error);
  } finally {
    setWAButtonsLoading(false);
  }
}

async function resetWASession(){
  if(!(await confirmWAAction({
    icon:"▦",
    title:"Scan QR ulang?",
    message:"Session WhatsApp lama akan direset dan QR baru akan ditampilkan.",
    detail:"Pakai ini hanya kalau nomor memang perlu login ulang. Setelah reset, ponsel harus scan QR lagi.",
    confirmText:"Reset dan tampilkan QR",
    confirmClass:"btn-danger"
  }))) return;
  if(qrInterval){ clearInterval(qrInterval); qrInterval = null; }
  waStatusBackoffUntil = 0;
  setWAButtonsLoading(true);

  try{
    var response = await fetch("/api/wa/reset-session", {method:"POST",headers:{"Accept":"application/json"}});
    if(!response.ok) throw new Error("HTTP " + response.status);
    toast("Session WhatsApp direset, tunggu QR baru");
    setWAStatusView({state:"waiting",icon:"▦",badge:"Menyiapkan QR",title:"Menyiapkan QR Code baru",description:"Tunggu sebentar sampai QR Code WhatsApp muncul.",service:"Menunggu QR",ai:"Belum aktif",sidebar:"Menunggu QR",showQR:false,showConnecting:true,connectingTitle:"Menyiapkan QR Code",connectingDescription:"Gateway sedang membuat sesi login baru. QR akan muncul sebentar lagi."});
    setTimeout(function(){ loadWAStatus(true); }, 2500);
    qrInterval = setInterval(function(){ loadWAStatus(true); }, 5000);
  } catch(error){
    toast("Gagal reset session WhatsApp", "var(--red)");
    console.error("Reset session WhatsApp gagal:", error);
  } finally {
    setWAButtonsLoading(false);
  }
}

async function disconnectWA(){
  if(!(await confirmWAAction({
    icon:"!",
    title:"Putuskan koneksi WhatsApp?",
    message:"AI Customer Service tidak akan menerima atau membalas pesan WhatsApp sampai koneksi dibuat kembali.",
    detail:"Session akan logout dari gateway ini.",
    confirmText:"Putuskan koneksi",
    confirmClass:"btn-danger"
  }))) return;
  if(qrInterval){ clearInterval(qrInterval); qrInterval = null; }
  waStatusBackoffUntil = 0;
  setWAButtonsLoading(true);

  try{
    var response = await fetch("/api/wa/disconnect", {method:"POST",headers:{"Accept":"application/json"}});
    if(!response.ok) throw new Error("HTTP " + response.status);
    toast("Koneksi WhatsApp berhasil diputuskan", "var(--red)");
    await loadWAStatus(true);
  } catch(error){
    toast("Gagal memutuskan koneksi WhatsApp", "var(--red)");
    console.error("Disconnect WhatsApp gagal:", error);
  } finally {
    setWAButtonsLoading(false);
  }
}
