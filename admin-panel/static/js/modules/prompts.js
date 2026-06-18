// ================================================================
// PROMPTS
// ================================================================
async function loadPrompts(){
  var s = await (await fetch("/api/settings")).json();
  document.getElementById("prompt-greeting").value = s.prompt_greeting||"";
  document.getElementById("prompt-product").value = s.prompt_product||"";
  document.getElementById("prompt-order").value = s.prompt_order||"";
  document.getElementById("prompt-escalation").value = s.prompt_escalation||"";
}
async function savePrompts(){
  await fetch("/api/settings", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({
    prompt_greeting: document.getElementById("prompt-greeting").value,
    prompt_product:  document.getElementById("prompt-product").value,
    prompt_order:    document.getElementById("prompt-order").value,
    prompt_escalation: document.getElementById("prompt-escalation").value
  })});
  toast("Prompts disimpan!");
}
