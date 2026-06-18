// ================================================================
// ANALYTICS & LOGS
// ================================================================
async function loadAnalytics(){
  try{
    var data = await (await fetch("/api/analytics")).json();
    document.getElementById("stat-total").textContent = data.total;
    document.getElementById("stat-today").textContent = data.today;
    document.getElementById("stat-users").textContent = data.unique_users;
    var medals = ["🥇","🥈","🥉","4️⃣","5️⃣"];
    var el = document.getElementById("top-users");
    if(!data.top_users.length){ el.innerHTML = '<div style="color:var(--text3);font-size:13px;text-align:center;padding:20px">Belum ada data</div>'; return; }
    el.innerHTML = "";
    data.top_users.forEach(function(u,i){
      var div = document.createElement("div");
      div.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)";
      div.innerHTML = '<div style="display:flex;align-items:center;gap:10px"><span>'+medals[i]+'</span><span style="font-family:\'DM Mono\',monospace;font-size:12px">'+u.number+'</span></div><span class="badge badge-teal">'+u.count+' pesan</span>';
      el.appendChild(div);
    });
  } catch(e){}
}

async function loadLogs(page){
  page = page||1;
  try{
    var data = await (await fetch("/api/logs?page="+page)).json();
    var el = document.getElementById("logs-list");
    if(!data.logs.length){ el.innerHTML = '<div style="text-align:center;color:var(--text3);padding:32px">Belum ada percakapan</div>'; return; }
    el.innerHTML = "";
    data.logs.forEach(function(log){
      var div = document.createElement("div"); div.className = "log-card";
      div.innerHTML = '<div class="log-header"><span class="log-number">'+log.user_number+'</span><span class="log-time">'+log.timestamp+'</span></div>'
        +'<div class="log-message log-user">'+log.user_message+'</div>'
        +'<div class="log-message log-ai">'+log.ai_response+'</div>';
      el.appendChild(div);
    });
    var total = Math.ceil(data.total/20);
    var pg = document.getElementById("pagination"); pg.innerHTML = "";
    if(total > 1){
      for(var i=1;i<=total;i++){
        var btn = document.createElement("button");
        btn.className = "page-btn" + (i===page?" active":"");
        btn.textContent = i;
        btn.setAttribute("data-pg", i);
        btn.onclick = function(){ loadLogs(parseInt(this.dataset.pg)); };
        pg.appendChild(btn);
      }
    }
  } catch(e){}
}
