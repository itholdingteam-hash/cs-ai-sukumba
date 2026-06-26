// ================================================================
// TEST AI
// ================================================================
var agentLabels = {
  greeting_agent: "Greeting",
  product_agent: "Product",
  order_agent: "Order",
  escalation_agent: "Escalation",
  cancel_agent: "Cancel",
  male_health_consultant_agent: "Konsultan Pria"
};

function chatTime(){
  return new Date().toLocaleTimeString("id-ID", {hour:"2-digit", minute:"2-digit"});
}

function appendChatBubble(chat, role, text, metaText, mediaItems){
  var msgDiv = document.createElement("div");
  msgDiv.className = "chat-msg " + role;

  var bubble = document.createElement("div");
  bubble.className = "chat-bubble";

  var body = document.createElement("div");
  body.className = "chat-text";
  body.textContent = text;
  bubble.appendChild(body);

  if(Array.isArray(mediaItems) && mediaItems.length){
    var mediaWrap = document.createElement("div");
    mediaWrap.className = "test-ai-media-list";
    mediaItems.forEach(function(item){
      if(!item || !item.url) return;
      var mediaBlock = document.createElement("div");
      mediaBlock.className = "test-ai-media-item";
      mediaBlock.innerHTML = renderMedia(item.url, {previewModal:true, title:item.name || "Media Sukumba"});
      if(item.name){
        var caption = document.createElement("div");
        caption.className = "test-ai-media-caption";
        caption.textContent = item.name;
        mediaBlock.appendChild(caption);
      }
      mediaWrap.appendChild(mediaBlock);
    });
    if(mediaWrap.childNodes.length) bubble.appendChild(mediaWrap);
  }

  var time = document.createElement("span");
  time.className = "chat-time";
  time.textContent = chatTime();
  bubble.appendChild(time);

  msgDiv.appendChild(bubble);

  if(metaText){
    var meta = document.createElement("div");
    meta.className = "chat-agent";
    meta.textContent = metaText;
    msgDiv.appendChild(meta);
  }

  chat.appendChild(msgDiv);
  return msgDiv;
}

function clearChat(){
  chatHistory = [];
  document.getElementById("chat").innerHTML = '<div class="test-ai-empty">Mulai percakapan...</div>';
  document.getElementById("agent-badge").style.display = "none";
}

async function sendMsg(){
  var msg = document.getElementById("msg").value.trim();
  if(!msg) return;

  document.getElementById("msg").value = "";
  var chat = document.getElementById("chat");
  if(chat.querySelector(".test-ai-empty")) chat.innerHTML = "";

  appendChatBubble(chat, "user", msg);

  var typingDiv = document.createElement("div");
  typingDiv.id = "typing";
  typingDiv.className = "chat-msg ai";
  var typingBubble = document.createElement("div");
  typingBubble.className = "chat-bubble typing-bubble";
  typingBubble.innerHTML = "<span></span><span></span><span></span>";
  typingDiv.appendChild(typingBubble);
  chat.appendChild(typingDiv);
  chat.scrollTop = chat.scrollHeight;

  try{
    var res = await fetch("/api/chat-proxy", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({content:msg, history:chatHistory})
    });
    var data = await res.json();
    var t = document.getElementById("typing");
    if(t) t.remove();
    if(!res.ok || data.error) throw new Error(data.error || ("HTTP "+res.status));

    var reply = data.reply || (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);
    if(!reply) throw new Error("Response AI kosong/tidak valid");

    var agent = (data._meta && data._meta.agent) || "";
    var intent = (data._meta && data._meta.intent) || "";
    var metaText = agent ? (agentLabels[agent] || agent) + " - " + intent : "";
    var mediaItems = Array.isArray(data._media) ? data._media : [];

    chatHistory.push({role:"user", content:msg});
    chatHistory.push({role:"assistant", content:reply});
    appendChatBubble(chat, "ai", reply, metaText, mediaItems);

    if(agent){
      var badge = document.getElementById("agent-badge");
      badge.textContent = (agentLabels[agent] || agent) + " - " + intent;
      badge.style.display = "inline-flex";
    }
  } catch(e){
    var typing = document.getElementById("typing");
    if(typing) typing.remove();
    appendChatBubble(chat, "ai error", "Error: " + e.message);
  }

  chat.scrollTop = chat.scrollHeight;
}
