"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  let services = new Map();
  let selected = null; // wa_id of the open conversation
  let contacts = [];

  const when = (ms) =>
    new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  function cell(text, className) {
    const td = document.createElement("td");
    td.textContent = text;
    if (className) td.className = className;
    return td;
  }

  function pill(text, kind) {
    const td = document.createElement("td");
    const span = document.createElement("span");
    span.className = `pill ${kind}`;
    span.textContent = text;
    td.append(span);
    return td;
  }

  function fill(tbodyId, emptyId, rows) {
    $(tbodyId).replaceChildren(...rows);
    $(emptyId).hidden = rows.length > 0;
  }

  const label = (waId) => {
    const c = contacts.find((x) => x.waId === waId);
    return c?.profileName ? `${c.profileName} (+${waId})` : `+${waId}`;
  };

  function selectableRow(waId, cells) {
    const tr = document.createElement("tr");
    tr.className = `selectable${waId === selected ? " selected" : ""}`;
    tr.tabIndex = 0;
    tr.append(...cells);
    const open = () => void openConversation(waId);
    tr.addEventListener("click", open);
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter") open();
    });
    return tr;
  }

  async function api(path, init) {
    const res = await fetch(`/admin/api${path}`, init);
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  async function refresh() {
    const { res, data } = await api("/overview");
    if (!res.ok) return;
    services = new Map(data.services.map((s) => [s.id, s.name]));
    contacts = data.contacts;
    $("clinic-tag").textContent = `${data.clinic.name} · ${data.clinic.timeZone}`;

    const upcoming = data.bookings.filter((b) => b.status === "booked");
    const open = data.handoffs.filter((h) => h.status === "open");
    $("stat-bookings").textContent = String(upcoming.length);
    $("stat-handoffs").textContent = String(open.length);
    $("stat-contacts").textContent = String(contacts.length);

    fill(
      "handoffs",
      "handoffs-empty",
      data.handoffs.map((h) =>
        selectableRow(h.waId, [cell(String(h.id)), cell(label(h.waId)), cell(h.reason), cell(when(h.createdAt)), pill(h.status, h.status)]),
      ),
    );
    fill(
      "bookings",
      "bookings-empty",
      data.bookings.map((b) => {
        const tr = selectableRow(b.waId, [
          cell(String(b.id)),
          cell(`${b.start.replace("T", " ")}–${b.end.slice(11)}`),
          cell(services.get(b.serviceId) ?? b.serviceId),
          cell(b.patientName),
          pill(b.status, b.status),
        ]);
        if (b.status === "cancelled") tr.classList.add("cancelled");
        return tr;
      }),
    );
    fill(
      "contacts",
      "contacts-empty",
      contacts.map((c) =>
        selectableRow(c.waId, [
          cell(label(c.waId)),
          c.optedOut ? pill("opted out", "") : pill(c.mode === "human" ? "staff" : "bot", c.mode === "human" ? "human" : ""),
          cell(c.lastMessageAt ? when(c.lastMessageAt) : "—"),
        ]),
      ),
    );
    if (selected) await loadTranscript();
  }

  async function loadTranscript() {
    const { res, data } = await api(`/contacts/${selected}/messages`);
    if (!res.ok) return;
    const box = $("transcript");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.replaceChildren(
      ...data.messages.map((m) => {
        const div = document.createElement("div");
        div.className = `bubble ${m.role === "user" ? "in" : m.role === "staff" ? "out staff" : "out"}`;
        const role = document.createElement("span");
        role.className = "role";
        role.textContent = m.role === "user" ? "Patient" : m.role === "staff" ? "Staff" : "Assistant";
        const time = document.createElement("time");
        time.textContent = when(m.createdAt);
        div.append(role, document.createTextNode(m.body), time);
        return div;
      }),
    );
    if (atBottom) box.scrollTop = box.scrollHeight;

    const handoff = contacts.find((c) => c.waId === selected)?.openHandoffId ?? null;
    $("resolve").hidden = handoff === null;
    $("resolve").dataset.id = handoff === null ? "" : String(handoff);
  }

  async function openConversation(waId) {
    selected = waId;
    $("chat-title").textContent = label(waId);
    $("reply").hidden = false;
    $("reply-note").textContent = "";
    await refresh();
    const box = $("transcript");
    box.scrollTop = box.scrollHeight;
  }

  function note(text, bad = false) {
    $("reply-note").textContent = text;
    $("reply-note").className = bad ? "note bad" : "note";
  }

  $("reply").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = $("reply-text").value.trim();
    if (!text || !selected) return;
    $("reply-send").disabled = true;
    try {
      const { res, data } = await api(`/contacts/${selected}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      note(data.note ?? data.error ?? `Error ${res.status}`, !res.ok);
      if (res.ok) $("reply-text").value = "";
      await refresh();
    } finally {
      $("reply-send").disabled = false;
    }
  });

  $("resolve").addEventListener("click", async () => {
    const id = $("resolve").dataset.id;
    if (!id) return;
    const { res } = await api(`/handoffs/${id}/resolve`, { method: "POST" });
    note(res.ok ? "Resolved. The assistant answers this chat again." : "Could not resolve.", !res.ok);
    await refresh();
  });

  setInterval(() => void refresh(), 3000);
  void refresh();
})();
