/* Progressive enhancement of Upptime 1.x. Native routes, incidents and charts stay intact. */
(function () {
  "use strict";
  var DAY = 86400000;
  var RAW = "https://raw.githubusercontent.com/EmoexAI/status/master/history/";
  var ISSUES = "https://api.github.com/repos/EmoexAI/status/issues";

  function parseHistory(text) {
    function field(name) {
      var match = text.match(new RegExp("^" + name + ":\\s*(.+)$", "m"));
      return match ? match[1].trim() : "";
    }
    var status = field("status");
    var updated = Date.parse(field("lastUpdated"));
    var started = Date.parse(field("startTime"));
    var response = Number(field("responseTime"));
    if (!/^(up|down|degraded)$/.test(status) || !Number.isFinite(updated) || !Number.isFinite(started)) {
      throw new Error("History unavailable");
    }
    return { status: status, updated: updated, started: started, response: response };
  }

  // Use the last 90 *completed* UTC days. Today's partial data must not
  // become a full green day; days before monitoring/after the last check are gaps.
  function daysFor(site, history, now) {
    var end = Math.floor(now / DAY) * DAY;
    var map = site && site.dailyMinutesDown;
    var valid = map && typeof map === "object" && !Array.isArray(map);
    return Array.from({ length: 90 }, function (_, i) {
      var start = end - (90 - i) * DAY;
      var key = new Date(start).toISOString().slice(0, 10);
      var raw = valid && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : 0;
      var known = valid && history && start >= history.started && start + DAY <= history.updated &&
        typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1440;
      return { date: key, minutes: known ? raw : null,
        state: !known ? "unknown" : raw >= 1440 ? "down" : raw > 0 ? "partial" : "up" };
    });
  }

  function downtimeFor(slug, recent, open, now) {
    if (recent === null || open === null) return null;
    var unique = new Map();
    recent.concat(open).forEach(function (issue) { unique.set(issue.number, issue); });
    var intervals = Array.from(unique.values()).filter(function (issue) {
      return issue.labels.some(function (label) { return label.name === slug; });
    }).map(function (issue) {
      return [Date.parse(issue.created_at), issue.closed_at ? Date.parse(issue.closed_at) : now];
    }).sort(function (a, b) { return a[0] - b[0]; });
    if (intervals.some(function (range) { return !Number.isFinite(range[0]) || !Number.isFinite(range[1]) || range[1] < range[0]; })) return null;
    var merged = [];
    intervals.forEach(function (range) {
      var previous = merged[merged.length - 1];
      if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
      else merged.push(range.slice());
    });
    var map = {};
    var end = Math.floor(now / DAY) * DAY;
    for (var day = end - 90 * DAY; day < end; day += DAY) {
      var milliseconds = merged.reduce(function (total, range) {
        return total + Math.max(0, Math.min(day + DAY, range[1]) - Math.max(day, range[0]));
      }, 0);
      map[new Date(day).toISOString().slice(0, 10)] = Math.round(milliseconds / 60000);
    }
    return { dailyMinutesDown: map };
  }

  function overall(histories, openIssues, now) {
    var known = histories.filter(Boolean);
    if (known.some(function (h) { return h.status === "down"; }) ||
        (openIssues || []).some(function (i) { return !i.title.toLowerCase().includes("degraded"); })) return "down";
    if (known.some(function (h) { return h.status === "degraded"; }) || (openIssues || []).length) return "degraded";
    if (now && known.some(function (h) { return now - h.updated > DAY; })) return "unknown";
    if (!histories.length || known.length !== histories.length || openIssues === null) return "unknown";
    return "up";
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { parseHistory: parseHistory, daysFor: daysFor, downtimeFor: downtimeFor, overall: overall };
    return;
  }
  if (window.__emoexStatus) return;
  window.__emoexStatus = true;

  function node(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function read(url, json) {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 10000);
    return fetch(url, { signal: controller.signal }).then(function (res) {
      if (!res.ok) throw new Error("Data unavailable");
      return json ? res.json() : res.text();
    }).finally(function () { clearTimeout(timeout); });
  }
  function list(url) {
    return read(url, true).then(function (items) {
      if (!Array.isArray(items)) throw new Error("Incident data unavailable");
      return items.filter(function (i) { return !i.pull_request && typeof i.title === "string"; });
    });
  }
  var openIssues = null;
  var recentIssues = null;
  var histories = {};
  var requested = {};
  var dataStarted = false;
  var generation = 0;
  var pendingRender = false;
  var now = Date.now();
  var cutoff = Math.floor(now / DAY) * DAY - 90 * DAY;

  function recentPage(page, result) {
    return list(ISSUES + "?state=all&labels=status&sort=updated&direction=desc&per_page=100&page=" + page).then(function (items) {
      result = result.concat(items.filter(function (i) {
        return i.state === "open" || Date.parse(i.closed_at) >= cutoff;
      }));
      if (items.length === 100 && Date.parse(items[items.length - 1].updated_at) >= cutoff) {
        // A bound prevents runaway work; mark unavailable rather than claim complete history.
        if (page >= 10) throw new Error("Incident history incomplete");
        return recentPage(page + 1, result);
      }
      return result;
    });
  }
  function schedule() {
    if (pendingRender) return;
    pendingRender = true;
    setTimeout(function () { pendingRender = false; render(); }, 0);
  }
  function startData() {
    if (dataStarted) return;
    dataStarted = true;
    now = Date.now(); cutoff = Math.floor(now / DAY) * DAY - 90 * DAY;
    var version = generation;
    list(ISSUES + "?state=open&labels=status&per_page=100").then(function (items) {
      if (version !== generation) return;
      // Don't infer healthy from a truncated set.
      if (items.length < 100) openIssues = items;
      schedule();
    }).catch(schedule);
    recentPage(1, []).then(function (items) { if (version !== generation) return; recentIssues = items; schedule(); }).catch(schedule);
  }
  function loadHistory(slug) {
    if (requested[slug]) return;
    requested[slug] = true;
    var version = generation;
    read(RAW + encodeURIComponent(slug) + ".yml", false).then(function (text) {
      if (version !== generation) return;
      histories[slug] = parseHistory(text);
      schedule();
    }).catch(schedule);
  }
  var savedTheme = "system";
  try { savedTheme = localStorage.getItem("emoex-status-theme") || "system"; } catch (_) {}
  if (!/^(light|dark|system)$/.test(savedTheme)) savedTheme = "system";
  function applyTheme(value) {
    document.documentElement.dataset.theme = value;
    try { localStorage.setItem("emoex-status-theme", value); } catch (_) {}
  }
  applyTheme(savedTheme);
  function themeControl() {
    var nav = document.querySelector("nav .container");
    if (!nav || nav.querySelector(".theme-control")) return;
    var label = node("label", "theme-control");
    label.appendChild(node("span", "", "Appearance"));
    var select = node("select");
    select.setAttribute("aria-label", "Appearance");
    [["system", "System"], ["light", "Light"], ["dark", "Dark"]].forEach(function (pair) {
      var option = node("option", "", pair[1]); option.value = pair[0]; select.appendChild(option);
    });
    select.value = savedTheme;
    select.addEventListener("change", function () { savedTheme = select.value; applyTheme(savedTheme); });
    label.appendChild(select); nav.appendChild(label);
  }
  function stamp(ms) { return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); }
  var labels = { up: "Operational", down: "Down", degraded: "Degraded", unknown: "Status unavailable" };
  function renderRow(article, slug) {
    var history = histories[slug];
    var site = downtimeFor(slug, recentIssues, openIssues, now);
    // Never trust the summary's daily refresh for the latest status.
    var state = history ? (history.status === "up" && now - history.updated > DAY ? "unknown" : history.status) : "unknown";
    var signature = JSON.stringify([history || null, site || null, recentIssues]);
    if (article.dataset.signature === signature) return;
    article.dataset.signature = signature;
    article.classList.add("enhanced");
    ["up", "down", "degraded"].forEach(function (c) { article.classList.remove(c); });
    article.classList.add(state);
    article.querySelectorAll(".service-state, .service-detail").forEach(function (el) { el.remove(); });
    var badge = node("span", "service-state", labels[state]); badge.dataset.state = state; article.appendChild(badge);
    var detail = node("div", "service-detail");
    var days = daysFor(site, history, now);
    var complete = days.every(function (d) { return d.minutes !== null; });
    var percent = complete ? (100 * (1 - days.reduce(function (n, d) { return n + d.minutes; }, 0) / (90 * 1440))).toFixed(2) + "%" : "Unavailable";
    var metrics = node("div", "service-metrics");
    var uptime = node("span"); uptime.appendChild(node("strong", "", percent)); uptime.appendChild(document.createTextNode(" uptime · 90 days"));
    var response = node("span", "", "Latest response · ");
    if (history) response.title = "Last checked " + stamp(history.updated);
    response.appendChild(node("strong", "", history && Number.isFinite(history.response) ? history.response + " ms" : "Unavailable"));
    metrics.append(uptime, response); detail.appendChild(metrics);
    var bars = node("div", "uptime-bars"); bars.setAttribute("aria-hidden", "true");
    days.forEach(function (d) {
      var cell = node("span", "uptime-day " + d.state);
      cell.title = d.date + ": " + (d.minutes === null ? "No complete record" : d.minutes + " min recorded downtime"); bars.appendChild(cell);
    });
    detail.appendChild(bars);
    var axis = node("div", "uptime-axis"); axis.append(node("span", "", days[0].date), node("span", "", days[89].date + " · UTC")); detail.appendChild(axis);
    // One keyboard/touch-accessible disclosure replaces 90 tiny focus targets.
    var info = node("details", "uptime-info"); info.appendChild(node("summary", "", "Daily records"));
    var records = node("ul"); days.forEach(function (d) { records.appendChild(node("li", "", d.date + ": " + (d.minutes === null ? "No complete record" : d.minutes + " min recorded downtime"))); });
    info.appendChild(records);
    var footer = node("div", "service-footer"); footer.appendChild(info);
    var incidentLine = node("p", "service-incidents");
    var reports = recentIssues && openIssues ? Array.from(new Map(recentIssues.concat(openIssues).map(function (i) { return [i.number, i]; })).values()) : null;
    var matches = reports && reports.filter(function (i) {
      return i.labels.some(function (l) { return l.name === slug; });
    }).sort(function (a, b) { return Date.parse(b.created_at) - Date.parse(a.created_at); }).slice(0, 3);
    if (matches && matches.length) {
      incidentLine.appendChild(document.createTextNode("Recent incidents: "));
      matches.forEach(function (issue, index) {
        if (index) incidentLine.appendChild(document.createTextNode(" · "));
        var link = node("a", "", "#" + issue.number + " " + (issue.state === "open" ? "Open" : "Resolved"));
        link.href = "/incident/" + Number(issue.number); link.title = issue.title; incidentLine.appendChild(link);
      });
    } else incidentLine.textContent = reports ? "No incidents reported in the past 90 days." : "Incident reports unavailable.";
    footer.appendChild(incidentLine); detail.appendChild(footer);

    article.appendChild(detail);
  }
  function resetData() {
    generation++; dataStarted = false; histories = {}; requested = {};
    openIssues = null; recentIssues = null;
  }
  function render() {
    themeControl();
    var main = document.querySelector("main.container");
    var live = main && main.querySelector(".live-status");
    if (!live) {
      if (dataStarted) resetData();
      if (main) {
        main.querySelectorAll(".overview, .history-note").forEach(function (el) { el.remove(); });
        main.classList.remove("status-enhanced");
      }
      return;
    }
    startData();
    var rows = Array.from(live.querySelectorAll("article.graph"));
    var slugs = rows.map(function (article) {
      var link = article.querySelector("h4 a");
      var slug = link && new URL(link.href, location.href).pathname.split("/").filter(Boolean).pop();
      if (!slug || !/^[a-z0-9-]+$/.test(slug)) return null;
      loadHistory(slug); renderRow(article, slug); return slug;
    }).filter(Boolean);
    main.classList.add("status-enhanced");
    var heading = main.querySelector(":scope > .f h2");
    if (heading && heading.textContent !== "Services") heading.textContent = "Services";
    if (heading && !heading.parentNode.querySelector(".services-range")) heading.parentNode.appendChild(node("span", "services-range", "90-day history"));
    var overview = main.querySelector(".overview");
    if (!overview) {
      overview = node("div", "overview"); overview.setAttribute("role", "status");
      var header = main.querySelector(":scope > header");
      if (header) header.after(overview); else main.prepend(overview);
    }
    var values = slugs.map(function (s) { return histories[s] || null; });
    var state = overall(values, openIssues, now);
    var checked = values.filter(Boolean).map(function (h) { return h.updated; });
    var caption = checked.length ? "Latest recorded checks · " + stamp(Math.min.apply(null, checked)) : "Recorded check data is unavailable. Try refreshing this page.";
    if (values.some(function (h) { return h && now - h.updated > DAY; })) caption += " Some check records are out of date.";
    if (openIssues === null) caption += " Incident status is unavailable.";
    var title = { up: "All systems operational", down: "Service disruption", degraded: "Degraded performance", unknown: "Status data unavailable" }[state];
    var sig = title + caption;
    if (overview.dataset.signature !== sig) {
      overview.dataset.signature = sig; overview.dataset.state = state; overview.replaceChildren();
      var icon = node("span", "overview-icon", { up: "✓", down: "!", degraded: "!", unknown: "?" }[state]); icon.setAttribute("aria-hidden", "true");
      var copy = node("div"); copy.append(node("h2", "", title), node("p", "", caption)); overview.append(icon, copy);
    }
    if (!main.querySelector(".history-note")) {
      var note = node("p", "history-note", "History covers the last 90 completed UTC days. Bars show recorded downtime; gaps mean no complete record. Current status uses the latest recorded check.");
      live.after(note);
    }
  }
  // Svelte can replace the container during hydration or SPA navigation.
  // Reapply only when signatures change, avoiding an observer mutation loop.
  try {
    var observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && Date.now() - now >= 600000) { resetData(); schedule(); }
    });
    setInterval(function () {
      if (!document.hidden && document.querySelector(".live-status")) { resetData(); schedule(); }
    }, 600000);
    schedule();
  } catch (_) { /* Native Upptime remains usable when enhancement isn't supported. */ }
})();
