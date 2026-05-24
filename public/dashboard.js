const metricsGridEl = document.getElementById("metricsGrid");
const logsTableEl = document.getElementById("logsTable");

function metricCard(label, value, note = "") {
  const card = document.createElement("section");
  card.className = "card metric-card";

  const labelEl = document.createElement("div");
  labelEl.className = "metric-label";
  labelEl.textContent = label;

  const valueEl = document.createElement("div");
  valueEl.className = "metric-value";
  valueEl.textContent = value;

  const noteEl = document.createElement("div");
  noteEl.className = "metric-note";
  noteEl.textContent = note;

  card.appendChild(labelEl);
  card.appendChild(valueEl);
  card.appendChild(noteEl);
  return card;
}

function statusClass(status) {
  if (status === "success") return "status-pill status-success";
  if (status === "error") return "status-pill status-error";
  if (status === "canceled") return "status-pill status-canceled";
  return "status-pill";
}

function createCell(text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  return cell;
}

async function loadDashboard() {
  const response = await fetch("/api/dashboard");
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Failed to load dashboard");
  }

  const dashboard = data.dashboard;
  metricsGridEl.innerHTML = "";
  metricsGridEl.appendChild(metricCard("Conversations", dashboard.totalConversations, "Active threads"));
  metricsGridEl.appendChild(metricCard("Messages", dashboard.totalMessages, "Stored chat turns"));
  metricsGridEl.appendChild(metricCard("Avg latency", `${dashboard.avgLatencyMs} ms`, "Inference time"));
  metricsGridEl.appendChild(metricCard("Errors", dashboard.errorCount, `${dashboard.canceledCount} canceled`));

  logsTableEl.innerHTML = "";
  for (const log of dashboard.recentLogs || []) {
    const row = document.createElement("tr");

    const statusCell = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = statusClass(log.status);
    pill.textContent = log.status;
    statusCell.appendChild(pill);

    row.appendChild(statusCell);
    row.appendChild(createCell(log.model || "-"));
    row.appendChild(createCell(`${Number(log.latencyMs || 0)} ms`));
    row.appendChild(createCell(String(log.tokenUsage?.total_tokens ?? log.tokenUsage?.totalTokens ?? "-")));
    row.appendChild(createCell(log.inputPreview || "-"));
    row.appendChild(createCell(log.outputPreview || "-"));
    row.appendChild(createCell(new Date(log.loggedAt).toLocaleString()));

    logsTableEl.appendChild(row);
  }
}

loadDashboard().catch((error) => {
  metricsGridEl.innerHTML = "";
  metricsGridEl.appendChild(metricCard("Error", "Failed", error.message));
});

setInterval(() => {
  loadDashboard().catch(() => {});
}, 5000);
