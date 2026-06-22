// ================================================================
// SETTINGS
// ================================================================
async function loadSettings(){
  var s = await api.get("/api/settings");
  document.getElementById("s-name").value = s.company_name||"";
  document.getElementById("s-location").value = s.company_location||"";
  document.getElementById("s-hours").value = s.company_hours||"";
  document.getElementById("s-contact").value = s.company_contact||"";
  document.getElementById("s-provider").value = s.llm_provider||"openrouter";
  document.getElementById("s-api-url").value = s.llm_api_url||"https://openrouter.ai/api/v1/chat/completions";
  document.getElementById("s-model").value = s.ai_model||"qwen/qwen3-32b:free";
  var apiKeyInput = document.getElementById("s-apikey");
  apiKeyInput.value = "";
  apiKeyInput.placeholder = (s.llm_api_key_configured || s.groq_api_key_configured)
    ? "API key sudah tersimpan. Isi hanya jika ingin mengganti."
    : "";
  document.getElementById("s-temp").value = s.ai_temperature||"0.7";
  document.getElementById("s-tokens").value = s.ai_max_tokens||"500";
  var tgTokenInput = document.getElementById("s-tg-token");
  tgTokenInput.value = "";
  tgTokenInput.placeholder = s.telegram_bot_token_configured
    ? "Token sudah tersimpan. Isi hanya jika ingin mengganti."
    : "";
}
async function saveSettings(){
  await api.post("/api/settings", {
    company_name: document.getElementById("s-name").value,
    company_location: document.getElementById("s-location").value,
    company_hours: document.getElementById("s-hours").value,
    company_contact: document.getElementById("s-contact").value,
    llm_provider: document.getElementById("s-provider").value,
    llm_api_url: document.getElementById("s-api-url").value,
    llm_api_key: document.getElementById("s-apikey").value,
    ai_model: document.getElementById("s-model").value,
    groq_api_key: document.getElementById("s-apikey").value,
    ai_temperature: document.getElementById("s-temp").value,
    ai_max_tokens: document.getElementById("s-tokens").value
  });
  toast("Settings disimpan!");
}
async function saveTgToken(){
  await api.post("/api/settings", {telegram_bot_token: document.getElementById("s-tg-token").value});
  toast("Token disimpan!");
}
async function setTelegramWebhook(){
  var token = document.getElementById("s-tg-token").value.trim();
  if(!token){ toast("Isi token dulu!", "var(--red)"); return; }
  await saveTgToken();
  var res = await api.post("/api/telegram-set-webhook", {});
  if(res.success) toast("Webhook berhasil diset!"); else toast("Error: "+res.error, "var(--red)");
}
async function loadTgUsers(){
  try{
    var users = await api.get("/api/telegram-users");
    var el = document.getElementById("tg-users-list");
    if(!users.length){ el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:12px 0">Belum ada user terdaftar</div>'; return; }
    el.innerHTML = "";
    users.forEach(function(u){
      var div = document.createElement("div");
      div.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)";
      div.innerHTML = '<div><div style="font-weight:600;font-size:13px">'+u.name+'</div><div style="font-family:\'DM Mono\',monospace;font-size:11px;color:var(--text2)">'+u.chat_id+'</div></div>';
      var btn = document.createElement("button");
      btn.className = "del-btn"; btn.textContent = "✕";
      btn.setAttribute("data-uid", u.id);
      btn.onclick = function(){ deleteTgUser(parseInt(this.dataset.uid)); };
      div.appendChild(btn); el.appendChild(div);
    });
  } catch(e){}
}
async function openAddTgUser(){
  var chatId = prompt("Chat ID Telegram:"); if(!chatId) return;
  var name = prompt("Nama CS:"); if(!name) return;
  var res = await api.post("/api/telegram-users", {chat_id:chatId.trim(), name:name.trim()});
  if(res.success){ toast("User ditambahkan!"); loadTgUsers(); } else toast("Error: "+res.error, "var(--red)");
}
async function deleteTgUser(id){
  if(!confirm("Hapus user ini?")) return;
  await api.delete("/api/telegram-users/"+id);
  loadTgUsers(); toast("Dihapus", "var(--red)");
}

function cleanWaNumberInput(){
  var num = (document.getElementById("reset-memory-number").value || "").replace(/\D/g, "");
  if(num.startsWith("0")) return "62" + num.slice(1);
  if(num.startsWith("8")) return "62" + num;
  return num;
}
async function checkCustomerMemory(){
  var num = cleanWaNumberInput();
  var out = document.getElementById("memory-reset-result");
  if(!num){ toast("Isi nomor WA dulu", "var(--red)"); return; }
  try{
    var data = await api.get("/api/customer-profile/"+num);
    var history = [];
    try{
      history = await api.get("/api/conversation/history/"+num+"?limit=5");
      if(!Array.isArray(history)) history = [];
    }catch(_e){}
    var keys = data.profile ? Object.keys(data.profile) : [];
    var summary = data.summary || "";
    var parts = [];
    if(keys.length) parts.push("Profile: " + keys.join(", "));
    if(summary) parts.push("Summary: " + summary);
    if(history.length) parts.push("History terakhir: " + history.length + " pesan");
    out.textContent = parts.length
      ? "Memory ditemukan. " + parts.join(" | ")
      : "Tidak ada profile/summary permanent atau history untuk nomor ini.";
  } catch(e){
    out.textContent = "Gagal cek memory.";
  }
}
async function resetCustomerMemory(){
  var num = cleanWaNumberInput();
  var out = document.getElementById("memory-reset-result");
  if(!num){ toast("Isi nomor WA dulu", "var(--red)"); return; }
  if(!confirm("Reset history chat dan memory permanent untuk "+num+"?")) return;
  try{
    var data = await api.delete("/api/customer-memory/"+num);
    if(!data.success) throw new Error(data.error || "Reset gagal");
    out.textContent = "Reset berhasil. History terhapus: "+data.history_deleted+", profile terhapus: "+data.profile_deleted+".";
    toast("Memory customer di-reset");
  } catch(e){
    out.textContent = "Gagal reset: " + e.message;
    toast("Gagal reset memory", "var(--red)");
  }
}
