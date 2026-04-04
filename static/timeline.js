let currentCode = null;
const cache = {};

// Viewport state (in seconds)
let viewStart = 0;
let viewEnd = 0;
let totalDuration = 0;
let currentData = null;

// Pan state
let isPanning = false;
let panStartX = 0;
let panStartViewStart = 0;
let panStartViewEnd = 0;

function iconUrl(icon) {
    if (!icon) return null;
    const name = icon.replace(/\.jpg$/i, "");
    return `https://wow.zamimg.com/images/wow/icons/medium/${name}.jpg`;
}

function refreshTooltips() {
    if (typeof $WowheadPower !== "undefined" && $WowheadPower.refreshLinks) {
        $WowheadPower.refreshLinks();
    }
}

function extractCode(input) {
    const match = input.match(/reports\/([A-Za-z0-9]+)/);
    if (match) return match[1];
    const trimmed = input.trim();
    if (/^[A-Za-z0-9]+$/.test(trimmed) && trimmed.length >= 10) return trimmed;
    return null;
}

function showError(msg) {
    const el = document.getElementById("error");
    el.textContent = msg;
    el.classList.remove("hidden");
}

function clearError() {
    document.getElementById("error").classList.add("hidden");
}

function setLoading(on) {
    document.getElementById("loading").classList.toggle("hidden", !on);
}

async function loadReport() {
    clearError();
    const input = document.getElementById("report-url").value;
    const code = extractCode(input);
    if (!code) {
        showError("Could not parse report code from input.");
        return;
    }
    currentCode = code;

    setLoading(true);
    try {
        const cacheKey = `fights:${code}`;
        let data = cache[cacheKey];
        if (!data) {
            const resp = await fetch(`/api/fights?code=${code}`);
            data = await resp.json();
            if (data.error) throw new Error(data.error);
            cache[cacheKey] = data;
        }

        const dropdown = document.getElementById("fight-dropdown");
        dropdown.innerHTML = '<option value="">-- Select a fight --</option>';
        for (const fight of data.fights) {
            const opt = document.createElement("option");
            opt.value = fight.id;
            const status = fight.kill ? "Kill" : `Wipe (${(fight.bossPercentage / 100).toFixed(1)}%)`;
            const dur = formatTime(fight.duration);
            const diff = difficultyName(fight.difficulty);
            opt.textContent = `${fight.name} - ${diff} - ${status} (${dur})`;
            dropdown.appendChild(opt);
        }
        document.getElementById("fight-select").classList.remove("hidden");
    } catch (e) {
        showError(e.message);
    }
    setLoading(false);
}

async function loadTimeline() {
    clearError();
    const fightId = document.getElementById("fight-dropdown").value;
    if (!fightId) {
        document.getElementById("timeline-container").classList.add("hidden");
        return;
    }

    setLoading(true);
    try {
        const cacheKey = `timeline:${currentCode}:${fightId}`;
        let data = cache[cacheKey];
        if (!data) {
            const resp = await fetch(`/api/timeline?code=${currentCode}&fight=${fightId}`);
            data = await resp.json();
            if (data.error) throw new Error(data.error);
            cache[cacheKey] = data;
        }
        currentData = data;
        totalDuration = data.fight.duration;
        viewStart = 0;
        viewEnd = totalDuration;
        renderTimeline(data);
    } catch (e) {
        showError(e.message);
    }
    setLoading(false);
}

function renderTimeline(data) {
    const container = document.getElementById("timeline-container");
    container.classList.remove("hidden");

    const header = document.getElementById("fight-header");
    const diff = difficultyName(data.fight.difficulty);
    const status = data.fight.kill ? "Kill" : `Wipe (${(data.fight.bossPercentage / 100).toFixed(1)}%)`;
    header.innerHTML = `
        <h2>${data.fight.name}</h2>
        <div class="meta">${diff} - ${status} - ${formatTime(data.fight.duration)}</div>
    `;

    renderView();
}

function renderView() {
    if (!currentData) return;
    renderDamageChart(currentData.damage, currentData.fight.duration);
    renderDamageSources(currentData.damageSources, currentData.fight.duration);
    renderCastTimeline(currentData.casts, currentData.fight.duration);
    renderDeaths(currentData.deaths);
}

// --- Viewport helpers ---

function timeToPercent(t) {
    // Convert a time (seconds) to a percentage within the current viewport
    return ((t - viewStart) / (viewEnd - viewStart)) * 100;
}

function isInView(t) {
    return t >= viewStart && t <= viewEnd;
}

function resetZoom() {
    viewStart = 0;
    viewEnd = totalDuration;
    renderView();
}

// --- Zoom / Pan ---

function handleWheel(e) {
    if (!currentData) return;
    e.preventDefault();

    const container = document.getElementById("timeline-container");
    const rect = container.getBoundingClientRect();
    // Account for the 200px label column
    const labelWidth = 200;
    const plotLeft = rect.left + labelWidth;
    const plotWidth = rect.width - labelWidth;
    const mouseX = Math.max(0, Math.min(1, (e.clientX - plotLeft) / plotWidth));

    const viewSpan = viewEnd - viewStart;
    const zoomFactor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
    const newSpan = Math.min(totalDuration, Math.max(2, viewSpan * zoomFactor));

    // Zoom centered on mouse position
    const pivot = viewStart + mouseX * viewSpan;
    let newStart = pivot - mouseX * newSpan;
    let newEnd = pivot + (1 - mouseX) * newSpan;

    // Clamp
    if (newStart < 0) { newEnd -= newStart; newStart = 0; }
    if (newEnd > totalDuration) { newStart -= (newEnd - totalDuration); newEnd = totalDuration; }
    newStart = Math.max(0, newStart);
    newEnd = Math.min(totalDuration, newEnd);

    viewStart = newStart;
    viewEnd = newEnd;
    renderView();
}

function handleMouseDown(e) {
    if (!currentData || e.button !== 0) return;
    // Don't capture if clicking on a link/interactive element
    if (e.target.closest("a, select, input, button")) return;
    isPanning = true;
    panStartX = e.clientX;
    panStartViewStart = viewStart;
    panStartViewEnd = viewEnd;
    document.body.style.cursor = "grabbing";
    e.preventDefault();
}

function handleMouseMove(e) {
    if (!isPanning) return;
    const container = document.getElementById("timeline-container");
    const rect = container.getBoundingClientRect();
    const plotWidth = rect.width - 200;
    const dx = e.clientX - panStartX;
    const viewSpan = panStartViewEnd - panStartViewStart;
    const timeDelta = -(dx / plotWidth) * viewSpan;

    let newStart = panStartViewStart + timeDelta;
    let newEnd = panStartViewEnd + timeDelta;

    // Clamp
    if (newStart < 0) { newEnd -= newStart; newStart = 0; }
    if (newEnd > totalDuration) { newStart -= (newEnd - totalDuration); newEnd = totalDuration; }

    viewStart = Math.max(0, newStart);
    viewEnd = Math.min(totalDuration, newEnd);
    renderView();
}

function handleMouseUp() {
    if (isPanning) {
        isPanning = false;
        document.body.style.cursor = "";
    }
}

// --- Render functions (viewport-aware) ---

const dmgColors = [
    "#c0392b", "#d35400", "#f39c12", "#27ae60", "#16a085",
    "#2980b9", "#8e44ad", "#c2185b", "#00838f", "#ef6c00",
    "#558b2f", "#4e342e", "#37474f", "#bf360c", "#4a148c",
];

function renderDamageChart(buckets, duration) {
    const canvas = document.getElementById("damage-chart");
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.scale(dpr, dpr);

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const pad = { top: 10, bottom: 20, left: 200, right: 10 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    ctx.clearRect(0, 0, w, h);
    if (buckets.length === 0) return;

    const startBucket = Math.max(0, Math.floor(viewStart));
    const endBucket = Math.min(buckets.length - 1, Math.ceil(viewEnd));
    const viewSpan = viewEnd - viewStart;

    // Find max in visible range for scaling
    let maxDmg = 1;
    for (let i = startBucket; i <= endBucket; i++) {
        if (buckets[i] > maxDmg) maxDmg = buckets[i];
    }

    const sources = currentData ? currentData.damageSources : [];
    const barW = plotW / viewSpan;

    for (let i = startBucket; i <= endBucket; i++) {
        const x = pad.left + ((i - viewStart) / viewSpan) * plotW;
        let yOffset = 0;

        // Draw each source's contribution as a stacked segment
        for (let s = sources.length - 1; s >= 0; s--) {
            const amt = sources[s].buckets[i] || 0;
            if (amt <= 0) continue;
            const segH = (amt / maxDmg) * plotH;
            ctx.fillStyle = dmgColors[s % dmgColors.length];
            ctx.fillRect(x, pad.top + plotH - yOffset - segH, Math.max(barW - 0.5, 1), segH);
            yOffset += segH;
        }

        // Draw remainder (minor sources filtered out) in grey
        const accountedFor = sources.reduce((sum, src) => sum + (src.buckets[i] || 0), 0);
        const remainder = buckets[i] - accountedFor;
        if (remainder > 0) {
            const remH = (remainder / maxDmg) * plotH;
            ctx.fillStyle = "rgba(150, 150, 150, 0.4)";
            ctx.fillRect(x, pad.top + plotH - yOffset - remH, Math.max(barW - 0.5, 1), remH);
        }
    }

    // Time labels
    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    const interval = timeAxisInterval(viewSpan);
    const firstTick = Math.ceil(viewStart / interval) * interval;
    for (let t = firstTick; t <= viewEnd; t += interval) {
        const x = pad.left + ((t - viewStart) / viewSpan) * plotW;
        ctx.fillText(formatTime(t), x, h - 4);
    }

    // Label
    ctx.fillStyle = "#888";
    ctx.textAlign = "right";
    ctx.font = "11px sans-serif";
    ctx.fillText("Raid Damage Taken", pad.left - 10, pad.top + 14);
}

function renderDamageSources(sources, duration) {
    const container = document.getElementById("damage-sources");
    container.innerHTML = "";

    if (!sources || sources.length === 0) return;

    for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        const color = dmgColors[i % dmgColors.length];

        // Check if any segment is in view
        const hasVisible = source.segments.some(s => s.end >= viewStart && s.start <= viewEnd);
        if (!hasVisible) continue;

        const lane = document.createElement("div");
        lane.className = "damage-source-lane";

        for (const seg of source.segments) {
            if (seg.end < viewStart || seg.start > viewEnd) continue;

            const el = document.createElement("a");
            el.className = "damage-source-segment";
            el.href = `https://www.wowhead.com/spell=${source.gameID}`;
            el.dataset.wowhead = `spell=${source.gameID}`;

            const startPct = timeToPercent(Math.max(seg.start, viewStart));
            const endPct = timeToPercent(Math.min(seg.end, viewEnd));
            const widthPct = Math.max(endPct - startPct, 0.4);

            el.style.left = `${startPct}%`;
            el.style.width = `${widthPct}%`;
            el.style.backgroundColor = color;
            el.title = `${source.name}: ${formatDamage(seg.total)} (${formatTime(seg.start)} - ${formatTime(seg.end)})`;

            const iconSrc = iconUrl(source.icon);
            if (iconSrc) {
                const img = document.createElement("img");
                img.className = "spell-icon";
                img.src = iconSrc;
                img.alt = "";
                img.style.width = "16px";
                img.style.height = "16px";
                el.appendChild(img);
            }

            const label = document.createElement("span");
            label.className = "seg-label";
            label.textContent = source.name;
            el.appendChild(label);

            lane.appendChild(el);
        }

        container.appendChild(lane);
    }

    refreshTooltips();
}

function renderCastTimeline(casts, duration) {
    const container = document.getElementById("cast-timeline");
    container.innerHTML = "";

    const groups = {};
    for (const cast of casts) {
        const key = cast.gameID;
        if (!groups[key]) groups[key] = { name: cast.ability, icon: cast.abilityIcon, gameID: cast.gameID, events: [] };
        groups[key].events.push(cast);
    }

    const sorted = Object.values(groups).sort((a, b) => a.events[0].time - b.events[0].time);

    const colors = [
        "#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#1abc9c",
        "#3498db", "#9b59b6", "#e91e63", "#00bcd4", "#ff9800",
        "#8bc34a", "#795548", "#607d8b", "#ff5722", "#673ab7",
    ];

    // Time axis
    const axis = document.createElement("div");
    axis.className = "time-axis";
    const viewSpan = viewEnd - viewStart;
    const interval = timeAxisInterval(viewSpan);
    const firstTick = Math.ceil(viewStart / interval) * interval;
    for (let t = firstTick; t <= viewEnd; t += interval) {
        const tick = document.createElement("span");
        tick.className = "time-tick";
        tick.style.left = `${timeToPercent(t)}%`;
        tick.textContent = formatTime(t);
        axis.appendChild(tick);
    }
    container.appendChild(axis);

    // Lanes
    sorted.forEach((group, idx) => {
        const { name, icon, gameID, events } = group;

        // Check if any events in view
        const hasVisible = events.some(e => e.time >= viewStart && e.time <= viewEnd);
        if (!hasVisible) return;

        const lane = document.createElement("div");
        lane.className = "cast-lane";

        const label = document.createElement("div");
        label.className = "lane-label";

        const iconSrc = iconUrl(icon);
        if (iconSrc) {
            const img = document.createElement("img");
            img.className = "spell-icon";
            img.src = iconSrc;
            img.alt = name;
            label.appendChild(img);
        }

        const link = document.createElement("a");
        link.href = `https://www.wowhead.com/spell=${gameID}`;
        link.textContent = name;
        link.dataset.wowhead = `spell=${gameID}`;
        label.appendChild(link);

        lane.appendChild(label);

        const eventsDiv = document.createElement("div");
        eventsDiv.className = "lane-events";

        const color = colors[idx % colors.length];

        for (const event of events) {
            if (event.time < viewStart || event.time > viewEnd) continue;
            const marker = document.createElement("div");
            marker.className = "cast-marker";
            marker.style.left = `${timeToPercent(event.time)}%`;
            marker.style.backgroundColor = color;

            const tooltip = document.createElement("span");
            tooltip.className = "tooltip";
            tooltip.textContent = `${name} @ ${formatTime(event.time)} (${event.source})`;
            marker.appendChild(tooltip);

            eventsDiv.appendChild(marker);
        }

        lane.appendChild(eventsDiv);
        container.appendChild(lane);
    });

    refreshTooltips();
}

function renderDeaths(deaths) {
    const container = document.getElementById("death-list");
    const visible = deaths.filter(d => d.time >= viewStart && d.time <= viewEnd);
    if (visible.length === 0) {
        container.innerHTML = "";
        return;
    }

    let html = "<h3>Deaths</h3>";
    for (const d of visible) {
        html += `<div class="death-entry">
            <span class="death-time">${formatTime(d.time)}</span>
            <span class="death-name">${d.player}</span>
        </div>`;
    }
    container.innerHTML = html;
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDamage(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return n.toString();
}

function timeAxisInterval(span) {
    if (span <= 15) return 1;
    if (span <= 30) return 2;
    if (span <= 60) return 5;
    if (span <= 180) return 15;
    if (span <= 600) return 30;
    return 60;
}

function difficultyName(id) {
    const names = {
        1: "LFR", 3: "Normal", 4: "Heroic", 5: "Mythic",
        14: "Normal", 15: "Heroic", 16: "Mythic", 17: "LFR",
    };
    return names[id] || `Difficulty ${id}`;
}

// --- Event listeners ---

document.getElementById("report-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadReport();
});

// Attach zoom/pan to the timeline container
const tlContainer = document.getElementById("timeline-container");
tlContainer.addEventListener("wheel", handleWheel, { passive: false });
tlContainer.addEventListener("mousedown", handleMouseDown);
document.addEventListener("mousemove", handleMouseMove);
document.addEventListener("mouseup", handleMouseUp);

// Double-click to reset zoom
tlContainer.addEventListener("dblclick", (e) => {
    if (!e.target.closest("a")) resetZoom();
});
