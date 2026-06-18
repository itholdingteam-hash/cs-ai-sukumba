// ================================================================
// TEST AI
// ================================================================
var agentLabels = {greeting_agent:"👋 Greeting", product_agent:"📦 Product", order_agent:"🛒 Order", escalation_agent:"🆘 Escalation", cancel_agent:"❌ Cancel"};
agentLabels.male_health_consultant_agent = "Konsultan Pria";
function clearChat(){
  chatHistory = [];
  document.getElementById("chat").innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;margin:auto">Mulai percakapan...</div>';
  document.getElementById("agent-badge").style.display = "none";
}
async function sendMsg(){
  var msg = document.getElementById("msg").value.trim();
  if(!msg) return;
  document.getElementById("msg").value = "";
  var chat = document.getElementById("chat");
  if(chat.querySelector("[style*=Mulai]")) chat.innerHTML = "";
  var userDiv = document.createElement("div"); userDiv.className = "chat-msg user";
  var bubble = document.createElement("div"); bubble.className = "chat-bubble"; bubble.textContent = msg;
  userDiv.appendChild(bubble); chat.appendChild(userDiv);
  var typingDiv = document.createElement("div"); typingDiv.id = "typing"; typingDiv.className = "chat-msg ai";
  var tb = document.createElement("div"); tb.className = "chat-bubble"; tb.style.color = "var(--text3)"; tb.textContent = "...";
  typingDiv.appendChild(tb); chat.appendChild(typingDiv);
  chat.scrollTop = chat.scrollHeight;
  try{
    var res = await fetch("/api/chat-proxy", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({content:msg, history:chatHistory})});
    var data = await res.json();
    var t = document.getElementById("typing"); if(t) t.remove();
    if(!res.ok || data.error) throw new Error(data.error || ("HTTP "+res.status));
    var reply = data.reply || (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);
    if(!reply) throw new Error("Response AI kosong/tidak valid");
    var agent = (data._meta && data._meta.agent) || "";
    var intent = (data._meta && data._meta.intent) || "";
    chatHistory.push({role:"user",content:msg}); chatHistory.push({role:"assistant",content:reply});
    var aiDiv = document.createElement("div"); aiDiv.className = "chat-msg ai";
    var ab = document.createElement("div"); ab.className = "chat-bubble"; ab.textContent = reply;
    aiDiv.appendChild(ab);
    if(agent){ var ag = document.createElement("div"); ag.className = "chat-agent"; ag.textContent = (agentLabels[agent]||agent)+" · "+intent; aiDiv.appendChild(ag); }
    chat.appendChild(aiDiv);
    if(agent){ var badge = document.getElementById("agent-badge"); badge.textContent = (agentLabels[agent]||agent)+" · "+intent; badge.style.display = "inline-flex"; }
  } catch(e){
    var t = document.getElementById("typing"); if(t) t.remove();
    var errDiv = document.createElement("div"); errDiv.className = "chat-msg ai";
    var eb = document.createElement("div"); eb.className = "chat-bubble"; eb.style.color = "var(--red)"; eb.textContent = "Error: "+e.message;
    errDiv.appendChild(eb); chat.appendChild(errDiv);
  }
  chat.scrollTop = chat.scrollHeight;
}
