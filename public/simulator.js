"use strict";

(() => {
  const chat = document.getElementById("chat");
  const form = document.getElementById("composer");
  const input = document.getElementById("message");
  const sendButton = document.getElementById("send");
  const waIdInput = document.getElementById("wa-id");
  const nameInput = document.getElementById("profile-name");
  const log = document.getElementById("log");

  let waId = waIdInput.value;
  let cursor = 0;
  let waitingSince = 0;
  let typing = null;

  const timeLabel = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  function addLog(text, bad = false) {
    const li = document.createElement("li");
    li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
    if (bad) li.className = "bad";
    log.prepend(li);
  }

  function render(entry) {
    const bubble = document.createElement("div");
    // Patient's own messages sit on the right, like on their phone.
    bubble.className = `bubble ${entry.direction === "in" ? "out" : "in"}`;
    bubble.dataset.seq = String(entry.seq);
    if (entry.direction === "out" && entry.kind === "template") {
      bubble.classList.add("template");
      bubble.textContent = `Template message "${entry.template}" (the 24-hour window was closed)`;
    } else {
      bubble.textContent = entry.text;
    }
    const time = document.createElement("time");
    time.textContent = timeLabel(entry.at);
    bubble.append(time);
    chat.insertBefore(bubble, typing);
    chat.scrollTop = chat.scrollHeight;
  }

  function setTyping(on) {
    if (on && !typing) {
      typing = document.createElement("div");
      typing.className = "typing";
      typing.textContent = "typing…";
      chat.append(typing);
      chat.scrollTop = chat.scrollHeight;
    } else if (!on && typing) {
      typing.remove();
      typing = null;
    }
  }

  async function poll() {
    try {
      const res = await fetch(`/simulator/api/thread?waId=${encodeURIComponent(waId)}&after=${cursor}`);
      if (res.ok) {
        const { entries } = await res.json();
        for (const entry of entries) {
          cursor = Math.max(cursor, entry.seq);
          if (chat.querySelector(`[data-seq="${entry.seq}"]`)) continue;
          if (entry.direction === "out") waitingSince = 0;
          render(entry);
        }
      }
    } catch {
      // Server restarting; the next poll catches up.
    }
    // The bot may stay silent on purpose (handoff, STOP), so stop showing "typing" after a while.
    setTyping(waitingSince > 0 && Date.now() - waitingSince < 6000);
  }

  async function send(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    sendButton.disabled = true;
    try {
      const res = await fetch("/simulator/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ waId, name: nameInput.value.trim() || "Sample Patient", text: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        addLog(`not sent: ${data.error ?? res.status}`, true);
        return;
      }
      render(data.entry);
      waitingSince = Date.now();
      addLog(`POST /webhook signed → ${data.webhookStatus}`);
      input.value = "";
    } catch {
      addLog("server unreachable", true);
    } finally {
      sendButton.disabled = false;
      input.focus();
      void poll();
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void send(input.value);
  });
  document.getElementById("chips").addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (chip) void send(chip.textContent);
  });
  waIdInput.addEventListener("change", () => {
    if (!/^\d{6,15}$/.test(waIdInput.value)) {
      waIdInput.value = waId;
      return;
    }
    waId = waIdInput.value;
    cursor = 0;
    chat.querySelectorAll(".bubble").forEach((b) => b.remove());
    void poll();
  });

  fetch("/simulator/api/info")
    .then((res) => res.json())
    .then((info) => {
      document.getElementById("clinic-name").textContent = info.clinicName;
      const tag = document.getElementById("model-tag");
      const note = document.getElementById("model-note");
      if (info.model === "demo") {
        tag.textContent = "Offline demo model";
        note.textContent = "Replies come from a small rule-based stand-in for Claude that calls the same tools. Set ANTHROPIC_API_KEY to use Claude.";
      } else {
        tag.textContent = "Claude";
        tag.classList.add("live");
        note.textContent = "Replies come from Claude through the Anthropic API.";
      }
    })
    .catch(() => addLog("could not load server info", true));

  setInterval(poll, 1000);
  void poll();
})();
