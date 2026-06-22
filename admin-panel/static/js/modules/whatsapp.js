// ================================================================
// WHATSAPP
// ================================================================
function loadQRScript(cb){
  if(window.QRCode){ cb(); return; }
  var s = document.createElement("script");
  s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
  s.onload = cb;
  document.head.appendChild(s);
}

function setWAButtonsLoading(isLoading){
  ["wa-refresh-btn","wa-reconnect-btn","wa-reset-session-btn","wa-disconnect-btn"].forEach(function(id){
    var button = document.getElementById(id);
    if(button) button.disabled = isLoading;
  });
}

function setWAStatusView(config){
  var box = document.getElementById("wa-status-big");
  var qrSection = document.getElementById("qr-section");
  var sidebarDot = document.getElementById("sidebar-dot");
  var sidebarLabel = document.getElementById("sidebar-status");
  var serviceDot = document.getElementById("wa-service-dot");

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
    });
  } catch(error){
    toast("QR Code gagal dimuat", "var(--red)");
    console.error("Gagal memuat QR Code:", error);
  }
}

async function reconnectWA(){
  if(!confirm("Hubungkan ulang WhatsApp tanpa menghapus session?")) return;
  if(qrInterval){ clearInterval(qrInterval); qrInterval = null; }
  waStatusBackoffUntil = 0;
  setWAButtonsLoading(true);

  try{
    var response = await fetch("/api/wa/reconnect", {method:"POST",headers:{"Accept":"application/json"}});
    if(!response.ok) throw new Error("HTTP " + response.status);
    toast("Proses menghubungkan ulang dimulai");
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
  if(!confirm("Reset session WhatsApp dan tampilkan QR baru? Gunakan ini hanya kalau nomor memang harus login ulang.")) return;
  if(qrInterval){ clearInterval(qrInterval); qrInterval = null; }
  waStatusBackoffUntil = 0;
  setWAButtonsLoading(true);

  try{
    var response = await fetch("/api/wa/reset-session", {method:"POST",headers:{"Accept":"application/json"}});
    if(!response.ok) throw new Error("HTTP " + response.status);
    toast("Session WhatsApp direset, tunggu QR baru");
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
  if(!confirm("Putuskan koneksi WhatsApp? AI tidak akan menerima pesan sampai koneksi dibuat kembali.")) return;
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
