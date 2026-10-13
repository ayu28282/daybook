import React, { useState, useEffect, useRef, useMemo } from "react";

// ── Persistence helpers ──────────────────────────────────────────────
// Browser localStorage. Kept async-compatible so callers can await them.
const load = async (key, fallback) => {
  try {
    const r = localStorage.getItem(key);
    return r != null ? JSON.parse(r) : fallback;
  } catch {
    return fallback;
  }
};
const save = async (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error("save failed", e);
  }
};

// ── Theme ────────────────────────────────────────────────────────────
// Single fixed "Paper" look. Values are injected as CSS variables.
const PAPER_VARS = {
  "--bg": "#f4f0e8", "--surface": "#fdfbf6", "--surface2": "#efe9dd", "--line": "#e0d9cb",
  "--ink": "#2a241d", "--ink-dim": "#7a6f5f", "--ink-faint": "#a89d8a",
  "--accent": "#b35733", "--accent-deep": "#974627", "--on-accent": "#ffffff",
  "--c-uni": "#3a6ea5", "--c-hustle": "#5a8a57", "--c-life": "#8a5bb5", "--c-dot": "#a89d8a",
  "--warn": "#c0463a", "--accent-soft": "rgba(179,87,51,.12)", "--scheme": "light",
};


const DAYMS = 86400000;
const todayKey = () => keyOf(new Date());
const keyOf = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};
const dateOf = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const relativeLabel = (key) => {
  const diff = Math.round((dateOf(key) - dateOf(todayKey())) / DAYMS);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  const d = dateOf(key);
  if (diff > 1 && diff < 7) return DOW[d.getDay()];
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
};

// ── Natural-language quick parse ─────────────────────────────────────
// Turns "essay due fri 3pm #uni" into { text, dateKey, time, tag }
const TAG_COLORS = {
  uni: "var(--c-uni)",
  hustle: "var(--c-hustle)",
  life: "var(--c-life)",
};
const parseQuick = (raw) => {
  let text = raw.trim();
  let dateKey = todayKey();
  let time = null;
  let tag = null;

  // tag
  const tagM = text.match(/#(\w+)/);
  if (tagM) {
    const t = tagM[1].toLowerCase();
    if (TAG_COLORS[t]) tag = t;
    text = text.replace(tagM[0], "").trim();
  }

  // time e.g. 3pm, 14:30, 9 am
  const timeM = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) || text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (timeM) {
    let h = parseInt(timeM[1], 10);
    const min = timeM[2] ? parseInt(timeM[2], 10) : 0;
    const mer = timeM[3] ? timeM[3].toLowerCase() : null;
    if (mer === "pm" && h < 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
    time = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    text = text.replace(timeM[0], "").trim();
  }

  // relative + weekday dates
  const lower = " " + text.toLowerCase() + " ";
  const setDay = (offset) => {
    const d = dateOf(todayKey());
    d.setDate(d.getDate() + offset);
    dateKey = keyOf(d);
  };
  const nextDow = (target, weeksAhead = 0) => {
    const d = dateOf(todayKey());
    let add = (target - d.getDay() + 7) % 7;
    if (add === 0) add = 7;
    add += weeksAhead * 7;
    d.setDate(d.getDate() + add);
    dateKey = keyOf(d);
  };
  const strip = (re) => { text = text.replace(re, " ").replace(/\s+/g, " ").trim(); };

  if (/\btoday\b/i.test(lower)) { setDay(0); strip(/\btoday\b/i); }
  else if (/\btomorrow\b|\btmrw\b|\btmr\b/i.test(lower)) { setDay(1); strip(/\btomorrow\b|\btmrw\b|\btmr\b/i); }
  else {
    const days = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
    for (const [name, idx] of Object.entries(days)) {
      // capture any run of "next" words directly before the weekday, e.g. "next next monday"
      const re = new RegExp(`\\b((?:next\\s+)*)${name}(day)?\\b`, "i");
      const m = text.match(re);
      if (m) {
        const nextCount = (m[1].match(/next/gi) || []).length;
        // "monday" or "next monday" -> coming monday (0 extra weeks). each additional "next" -> +1 week.
        nextDow(idx, Math.max(0, nextCount - 1));
        strip(re);
        break;
      }
    }
  }

  // "in N days"
  const inM = text.match(/\bin (\d{1,2}) days?\b/i);
  if (inM) { setDay(parseInt(inM[1], 10)); strip(/\bin \d{1,2} days?\b/i); }

  return { text: text.replace(/\s+/g, " ").trim(), dateKey, time, tag };
};

// ── App ──────────────────────────────────────────────────────────────
export default function Daybook() {
  const [tasks, setTasks] = useState([]);
  const [history, setHistory] = useState([]); // archived: completed + deleted
  const [lastDeleted, setLastDeleted] = useState(null); // {task, timer} for undo
  const [ready, setReady] = useState(false);
  const [input, setInput] = useState("");
  const [view, setView] = useState("agenda"); // agenda | month
  const [monthCursor, setMonthCursor] = useState(() => {
    const d = new Date(); d.setDate(1); return d;
  });
  const [selectedDay, setSelectedDay] = useState(todayKey());
  const [pickDate, setPickDate] = useState(null); // manual override: "YYYY-MM-DD"
  const [pickTime, setPickTime] = useState(null); // manual override: "HH:MM"
  const [showPicker, setShowPicker] = useState(false);
  const inputRef = useRef(null);
  const pickerRef = useRef(null);

  useEffect(() => {
    const onDoc = (e) => {
      if (showPicker && pickerRef.current && !pickerRef.current.contains(e.target)) {
        setShowPicker(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showPicker]);

  useEffect(() => {
    (async () => {
      const t = await load("daybook:tasks", []);
      const h = await load("daybook:history", []);
      setTasks(t);
      setHistory(h);
      setReady(true);
    })();
  }, []);
  useEffect(() => { if (ready) save("daybook:tasks", tasks); }, [tasks, ready]);
  useEffect(() => { if (ready) save("daybook:history", history); }, [history, ready]);

  const preview = useMemo(() => {
    if (!input.trim()) return null;
    const p = parseQuick(input);
    return {
      ...p,
      dateKey: pickDate || p.dateKey,
      time: pickTime || p.time,
      manualDate: !!pickDate,
      manualTime: !!pickTime,
    };
  }, [input, pickDate, pickTime]);

  const clearPicks = () => { setPickDate(null); setPickTime(null); };

  const addTask = () => {
    if (!input.trim()) return;
    const p = parseQuick(input);
    if (!p.text) return;
    setTasks((prev) => [
      ...prev,
      {
        id: Date.now() + Math.random(),
        text: p.text,
        dateKey: pickDate || p.dateKey,
        time: pickTime || p.time,
        tag: p.tag,
        done: false,
        created: Date.now(),
      },
    ]);
    setInput("");
    clearPicks();
    setShowPicker(false);
    inputRef.current?.focus();
  };

  const toggle = (id) => {
    setTasks((prev) => {
      const t = prev.find((x) => x.id === id);
      if (!t) return prev;
      if (!t.done) {
        // completing -> move to history, remove from active list
        setHistory((h) => [{ ...t, done: true, reason: "done", archivedAt: Date.now() }, ...h]);
        return prev.filter((x) => x.id !== id);
      }
      return prev; // (done tasks live in history, toggled back from there)
    });
  };

  const remove = (id) => {
    setTasks((prev) => {
      const t = prev.find((x) => x.id === id);
      if (!t) return prev;
      setHistory((h) => [{ ...t, reason: "deleted", archivedAt: Date.now() }, ...h]);
      setLastDeleted({ id: t.id, text: t.text });
      setTimeout(() => setLastDeleted((cur) => (cur && cur.id === t.id ? null : cur)), 6000);
      return prev.filter((x) => x.id !== id);
    });
  };

  // bring an archived task back to the active list
  const restore = (id) => {
    setHistory((h) => {
      const t = h.find((x) => x.id === id);
      if (!t) return h;
      const { reason, archivedAt, ...rest } = t;
      setTasks((prev) => [...prev, { ...rest, done: false }]);
      return h.filter((x) => x.id !== id);
    });
    setLastDeleted((cur) => (cur && cur.id === id ? null : cur));
  };

  // permanently remove a single archived task
  const purge = (id) => setHistory((h) => h.filter((x) => x.id !== id));
  // clear the whole history
  const clearHistory = () => setHistory([]);

  const bump = (id, days) => setTasks((p) => p.map((t) => {
    if (t.id !== id) return t;
    const d = dateOf(t.dateKey); d.setDate(d.getDate() + days);
    return { ...t, dateKey: keyOf(d) };
  }));

  // overdue undone tasks roll into "Today" visually
  const counts = useMemo(() => {
    const tk = todayKey();
    let todayOpen = 0, overdue = 0;
    tasks.forEach((t) => {
      if (t.done) return;
      if (t.dateKey === tk) todayOpen++;
      else if (dateOf(t.dateKey) < dateOf(tk)) overdue++;
    });
    return { todayOpen, overdue };
  }, [tasks]);

  return (
    <div className="db-root" style={PAPER_VARS}>
      <style>{css}</style>

      <header className="db-head">
        <div className="db-brand">
          <span className="db-logo">DB</span>
          <div>
            <h1>Daybook</h1>
            <p className="db-sub">{relativeLabel(todayKey())} · {dateOf(todayKey()).getDate()} {MON[dateOf(todayKey()).getMonth()]}</p>
          </div>
        </div>
        <div className="db-glance">
          <div className={"db-pill " + (counts.todayOpen ? "active" : "")}>
            <span className="n">{counts.todayOpen}</span><span className="l">today</span>
          </div>
          {counts.overdue > 0 && (
            <div className="db-pill warn">
              <span className="n">{counts.overdue}</span><span className="l">overdue</span>
            </div>
          )}
        </div>
      </header>

      {/* The capture bar — always first, always focused-feeling */}
      <div className="db-capture" ref={pickerRef}>
        <input
          ref={inputRef}
          className="db-input"
          value={input}
          placeholder="Add anything — “essay fri 3pm #uni”"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addTask()}
          autoFocus
        />
        <button
          className={"db-cal" + (pickDate || pickTime ? " set" : "")}
          onClick={() => setShowPicker((s) => !s)}
          aria-label="Pick date"
          title="Pick exact date & time"
        >📅</button>
        <button className="db-add" onClick={addTask} aria-label="Add">↵</button>

        {showPicker && (
          <div className="db-popover">
            <div className="pop-row">
              <label>Date</label>
              <input
                type="date"
                value={pickDate || (preview ? preview.dateKey : todayKey())}
                onChange={(e) => setPickDate(e.target.value || null)}
              />
            </div>
            <div className="pop-row">
              <label>Time</label>
              <input
                type="time"
                value={pickTime || ""}
                onChange={(e) => setPickTime(e.target.value || null)}
              />
            </div>
            <div className="pop-quick">
              <button onClick={() => setPickDate(todayKey())}>Today</button>
              <button onClick={() => { const d = dateOf(todayKey()); d.setDate(d.getDate() + 1); setPickDate(keyOf(d)); }}>Tomorrow</button>
              <button onClick={() => { const d = dateOf(todayKey()); d.setDate(d.getDate() + 7); setPickDate(keyOf(d)); }}>+1 week</button>
            </div>
            <div className="pop-foot">
              <button className="pop-clear" onClick={clearPicks}>Clear</button>
              <button className="pop-done" onClick={() => setShowPicker(false)}>Done</button>
            </div>
          </div>
        )}
      </div>
      {preview && preview.text && (
        <div className="db-preview">
          <span className={"pv-chip" + (preview.manualDate ? " pv-set" : "")}>
            {relativeLabel(preview.dateKey)}
            {preview.manualDate && <button className="pv-x" onClick={() => setPickDate(null)}>×</button>}
          </span>
          {preview.time && (
            <span className={"pv-chip" + (preview.manualTime ? " pv-set" : "")}>
              {fmtTime(preview.time)}
              {preview.manualTime && <button className="pv-x" onClick={() => setPickTime(null)}>×</button>}
            </span>
          )}
          {preview.tag && <span className="pv-chip" style={{ color: TAG_COLORS[preview.tag] }}>#{preview.tag}</span>}
          <span className="pv-text">{preview.text}</span>
        </div>
      )}

      <nav className="db-tabs">
        <button className={view === "agenda" ? "on" : ""} onClick={() => setView("agenda")}>Agenda</button>
        <button className={view === "month" ? "on" : ""} onClick={() => setView("month")}>Month</button>
        <button className={view === "history" ? "on" : ""} onClick={() => setView("history")}>
          History{history.length > 0 && <span className="tab-badge">{history.length}</span>}
        </button>
      </nav>

      {view === "agenda" && <Agenda tasks={tasks} toggle={toggle} remove={remove} bump={bump} />}
      {view === "month" && <MonthView tasks={tasks} cursor={monthCursor} setCursor={setMonthCursor} selected={selectedDay} setSelected={setSelectedDay} toggle={toggle} remove={remove} bump={bump} />}
      {view === "history" && <History history={history} restore={restore} purge={purge} clearHistory={clearHistory} />}

      {lastDeleted && (
        <div className="db-toast">
          <span>Deleted “{lastDeleted.text.slice(0, 30)}{lastDeleted.text.length > 30 ? "…" : ""}”</span>
          <button onClick={() => restore(lastDeleted.id)}>Undo</button>
        </div>
      )}
    </div>
  );
}

const fmtTime = (t) => {
  if (!t) return "";
  let [h, m] = t.split(":").map(Number);
  const mer = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, "0")}${mer}` : `${h}${mer}`;
};

// ── Agenda view: today + next days, overdue surfaced ─────────────────
function Agenda({ tasks, toggle, remove, bump }) {
  const tk = todayKey();
  const groups = useMemo(() => {
    const overdue = tasks.filter((t) => !t.done && dateOf(t.dateKey) < dateOf(tk));
    const map = {};
    tasks.forEach((t) => {
      if (!t.done && dateOf(t.dateKey) < dateOf(tk)) return; // overdue handled separately
      (map[t.dateKey] ||= []).push(t);
    });
    const keys = Object.keys(map).filter((k) => dateOf(k) >= dateOf(tk)).sort();
    // ensure today shows even if empty
    if (!keys.includes(tk)) keys.unshift(tk);
    return { overdue, keys, map };
  }, [tasks]);

  const sortTasks = (arr) =>
    [...arr].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (!!a.time !== !!b.time) return a.time ? -1 : 1;
      if (a.time && b.time) return a.time.localeCompare(b.time);
      return a.created - b.created;
    });

  return (
    <div className="db-agenda">
      {groups.overdue.length > 0 && (
        <section className="db-day overdue">
          <div className="db-dayhead">
            <span className="dh-rel warn">Overdue</span>
            <span className="dh-line" />
          </div>
          {sortTasks(groups.overdue).map((t) => (
            <Task key={t.id} t={t} toggle={toggle} remove={remove} bump={bump} overdue />
          ))}
        </section>
      )}
      {groups.keys.map((k) => {
        const items = sortTasks(groups.map[k] || []);
        const isToday = k === tk;
        return (
          <section className={"db-day" + (isToday ? " is-today" : "")} key={k}>
            <div className="db-dayhead">
              <span className="dh-rel">{relativeLabel(k)}</span>
              <span className="dh-date">{dateOf(k).getDate()} {MON[dateOf(k).getMonth()]}</span>
              <span className="dh-line" />
            </div>
            {items.length === 0
              ? <p className="db-empty">{isToday ? "Nothing today. Add something above ↑" : "Clear"}</p>
              : items.map((t) => <Task key={t.id} t={t} toggle={toggle} remove={remove} bump={bump} />)}
          </section>
        );
      })}
    </div>
  );
}

// ── A single task row ────────────────────────────────────────────────
function Task({ t, toggle, remove, bump, overdue }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={"db-task" + (t.done ? " done" : "")}>
      <button className="db-check" onClick={() => toggle(t.id)} aria-label="Complete task">
        <span className="tick">✓</span>
      </button>
      <div className="db-taskmain" onClick={() => setOpen((o) => !o)}>
        <span className="db-text">{t.text}</span>
        <span className="db-meta">
          {t.time && <span className="m-time">{fmtTime(t.time)}</span>}
          {t.tag && <span className="m-tag" style={{ background: TAG_COLORS[t.tag] }} />}
        </span>
      </div>
      <button className="db-quickdel" onClick={() => remove(t.id)} aria-label="Delete task" title="Delete">✕</button>
      {open && (
        <div className="db-actions">
          {overdue && <button onClick={() => bump(t.id, todayDelta(t.dateKey))}>→ Today</button>}
          <button onClick={() => bump(t.id, 1)}>+1 day</button>
          <button onClick={() => bump(t.id, 7)}>+1 wk</button>
          <button className="del" onClick={() => remove(t.id)}>Delete</button>
        </div>
      )}
    </div>
  );
}
const todayDelta = (key) => Math.round((dateOf(todayKey()) - dateOf(key)) / DAYMS);

// ── History view: completed + deleted archive ────────────────────────
function History({ history, restore, purge, clearHistory }) {
  const groups = useMemo(() => {
    const g = {};
    history.forEach((t) => {
      const d = new Date(t.archivedAt || Date.now());
      const k = keyOf(d);
      (g[k] ||= []).push(t);
    });
    return Object.keys(g).sort().reverse().map((k) => [k, g[k]]);
  }, [history]);

  if (history.length === 0) {
    return (
      <div className="db-history">
        <p className="db-empty">No history yet. Completed and deleted tasks will appear here so nothing is ever lost.</p>
      </div>
    );
  }

  return (
    <div className="db-history">
      <div className="db-histhead">
        <span className="hh-count">{history.length} item{history.length !== 1 ? "s" : ""}</span>
        <button className="hh-clear" onClick={clearHistory}>Clear all</button>
      </div>
      {groups.map(([k, items]) => (
        <section className="db-day" key={k}>
          <div className="db-dayhead">
            <span className="dh-rel">{relativeLabel(k)}</span>
            <span className="dh-date">{dateOf(k).getDate()} {MON[dateOf(k).getMonth()]}</span>
            <span className="dh-line" />
          </div>
          {items.map((t) => (
            <div className={"db-task histrow " + t.reason} key={t.id}>
              <span className={"hist-badge " + t.reason}>{t.reason === "done" ? "✓" : "✕"}</span>
              <div className="db-taskmain" style={{ cursor: "default" }}>
                <span className="db-text">{t.text}</span>
                <span className="db-meta">
                  {t.tag && <span className="m-tag" style={{ background: TAG_COLORS[t.tag] }} />}
                  <span className="hist-reason">{t.reason === "done" ? "completed" : "deleted"}</span>
                </span>
              </div>
              <div className="hist-actions">
                <button onClick={() => restore(t.id)} title="Restore to Agenda">↩ Restore</button>
                <button className="del" onClick={() => purge(t.id)} title="Remove permanently">Delete</button>
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

// ── Month view ───────────────────────────────────────────────────────
function MonthView({ tasks, cursor, setCursor, selected, setSelected, toggle, remove, bump }) {
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const first = new Date(year, month, 1);
  const startPad = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const byDay = useMemo(() => {
    const m = {};
    tasks.forEach((t) => { (m[t.dateKey] ||= []).push(t); });
    return m;
  }, [tasks]);

  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(keyOf(new Date(year, month, d)));

  const move = (delta) => {
    const c = new Date(cursor); c.setMonth(c.getMonth() + delta); setCursor(c);
  };

  const selItems = (byDay[selected] || []).sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return (a.time || "zz").localeCompare(b.time || "zz");
  });

  return (
    <div className="db-month">
      <div className="db-monthnav">
        <button onClick={() => move(-1)}>‹</button>
        <h2>{cursor.toLocaleString("default", { month: "long" })} {year}</h2>
        <button onClick={() => move(1)}>›</button>
      </div>
      <div className="db-grid db-dow">
        {DOW.map((d) => <span key={d} className="dow">{d}</span>)}
      </div>
      <div className="db-grid">
        {cells.map((k, i) => {
          if (!k) return <span key={i} className="cell empty" />;
          const items = byDay[k] || [];
          const open = items.filter((t) => !t.done).length;
          const isToday = k === todayKey();
          const isSel = k === selected;
          return (
            <button
              key={k}
              className={"cell" + (isToday ? " today" : "") + (isSel ? " sel" : "")}
              onClick={() => setSelected(k)}
            >
              <span className="cell-n">{dateOf(k).getDate()}</span>
              {open > 0 && (
                <span className="dots">
                  {items.slice(0, 3).map((t) => (
                    <i key={t.id} style={{ background: t.tag ? TAG_COLORS[t.tag] : "var(--c-dot)", opacity: t.done ? 0.3 : 1 }} />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="db-selday">
        <h3>{relativeLabel(selected)} <span>{dateOf(selected).getDate()} {MON[dateOf(selected).getMonth()]}</span></h3>
        {selItems.length === 0
          ? <p className="db-empty">Nothing scheduled.</p>
          : selItems.map((t) => <Task key={t.id} t={t} toggle={toggle} remove={remove} bump={bump} />)}
      </div>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────
const css = `
:root{
  --r:14px;
  font-synthesis:none;
}
*{box-sizing:border-box;}
.db-root{
  max-width:640px; margin:0 auto; padding:20px 16px 80px;
  font-family:'Inter',system-ui,-apple-system,sans-serif;
  color:var(--ink);
  color-scheme:var(--scheme);
  -webkit-font-smoothing:antialiased;
}
.db-root *::selection{background:var(--accent);color:var(--on-accent);}

/* header */
.db-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:18px;}
.db-brand{display:flex;align-items:center;gap:12px;}
.db-logo{
  font-family:'Spline Sans Mono',ui-monospace,monospace;
  font-weight:700;font-size:15px;letter-spacing:-1px;
  background:var(--accent);color:var(--on-accent);
  width:42px;height:42px;border-radius:12px;
  display:grid;place-items:center;flex-shrink:0;
}
.db-head h1{font-size:21px;font-weight:680;margin:0;letter-spacing:-.5px;line-height:1;}
.db-sub{margin:3px 0 0;font-size:12.5px;color:var(--ink-dim);}
.db-glance{display:flex;gap:8px;align-items:stretch;}
.db-pill{
  background:var(--surface);border:1px solid var(--line);border-radius:12px;
  padding:6px 12px;display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:54px;
}
.db-pill .n{font-size:19px;font-weight:700;line-height:1;font-family:'Spline Sans Mono',monospace;}
.db-pill .l{font-size:10px;color:var(--ink-faint);text-transform:uppercase;letter-spacing:.5px;margin-top:2px;}
.db-pill.active .n{color:var(--accent);}
.db-pill.warn .n{color:var(--warn);}
.db-pill.warn{border-color:var(--line);}

/* theme picker */
/* capture */
.db-capture{display:flex;gap:8px;margin-bottom:4px;position:relative;}
.db-input{
  flex:1;background:var(--surface);border:1.5px solid var(--line);
  border-radius:var(--r);padding:15px 16px;color:var(--ink);font-size:16px;
  font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s;
}
.db-input::placeholder{color:var(--ink-faint);}
.db-input:focus{border-color:var(--accent);box-shadow:0 0 0 4px var(--accent-soft);}
.db-cal{
  background:var(--surface);border:1.5px solid var(--line);border-radius:var(--r);width:50px;
  font-size:18px;cursor:pointer;transition:all .15s;line-height:1;
}
.db-cal:hover{border-color:var(--ink-faint);}
.db-cal.set{border-color:var(--accent);background:var(--accent-soft);}
.db-add{
  background:var(--accent);border:none;border-radius:var(--r);width:54px;
  font-size:20px;color:var(--on-accent);cursor:pointer;font-weight:700;
  transition:transform .1s,background .15s;
}
.db-add:hover{background:var(--accent-deep);}
.db-add:active{transform:scale(.94);}

/* picker popover */
.db-popover{
  position:absolute;top:calc(100% + 8px);right:0;z-index:20;
  background:var(--surface2);border:1px solid var(--line);border-radius:14px;
  padding:14px;width:260px;box-shadow:0 12px 32px rgba(42,36,29,.14);
  animation:fade .15s ease;
}
.pop-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
.pop-row label{font-size:13px;font-weight:600;color:var(--ink-dim);}
.pop-row input{
  background:var(--surface);border:1px solid var(--line);border-radius:9px;
  padding:8px 10px;color:var(--ink);font-family:inherit;font-size:14px;
  color-scheme:var(--scheme);width:150px;outline:none;
}
.pop-row input:focus{border-color:var(--accent);}
.pop-quick{display:flex;gap:6px;margin:12px 0;}
.pop-quick button{
  flex:1;background:var(--surface);border:1px solid var(--line);color:var(--ink-dim);
  font-size:12px;padding:7px 4px;border-radius:8px;cursor:pointer;font-family:inherit;font-weight:600;transition:all .12s;
}
.pop-quick button:hover{color:var(--ink);border-color:var(--accent);}
.pop-foot{display:flex;gap:8px;padding-top:10px;border-top:1px solid var(--line);}
.pop-clear{flex:1;background:none;border:1px solid var(--line);color:var(--ink-dim);font-size:13px;padding:8px;border-radius:9px;cursor:pointer;font-family:inherit;font-weight:600;}
.pop-clear:hover{color:var(--warn);border-color:var(--warn);}
.pop-done{flex:1;background:var(--accent);border:none;color:var(--on-accent);font-size:13px;padding:8px;border-radius:9px;cursor:pointer;font-family:inherit;font-weight:700;}

.db-preview{
  display:flex;align-items:center;gap:6px;flex-wrap:wrap;
  font-size:12.5px;padding:8px 4px 2px;color:var(--ink-dim);
  animation:fade .15s ease;
}
@keyframes fade{from{opacity:0;transform:translateY(-3px);}to{opacity:1;}}
.pv-chip{display:inline-flex;align-items:center;gap:4px;background:var(--surface2);border:1px solid var(--line);border-radius:7px;padding:2px 8px;font-weight:600;}
.pv-chip.pv-set{border-color:var(--accent);background:var(--accent-soft);}
.pv-x{background:none;border:none;color:var(--ink-dim);font-size:14px;line-height:1;cursor:pointer;padding:0 0 0 1px;}
.pv-x:hover{color:var(--warn);}
.pv-text{color:var(--ink);}

/* tabs */
.db-tabs{display:flex;gap:4px;margin:18px 0 14px;background:var(--surface);padding:4px;border-radius:12px;width:fit-content;border:1px solid var(--line);}
.db-tabs button{
  background:none;border:none;color:var(--ink-dim);padding:7px 18px;border-radius:9px;
  font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .15s;
}
.db-tabs button.on{background:var(--surface2);color:var(--ink);}
.tab-badge{
  display:inline-grid;place-items:center;min-width:17px;height:17px;padding:0 4px;margin-left:6px;
  background:var(--accent-soft);color:var(--accent-deep);border-radius:9px;
  font-size:10.5px;font-weight:700;font-family:'Spline Sans Mono',monospace;vertical-align:1px;
}

/* agenda */
.db-day{margin-bottom:22px;}
.db-dayhead{display:flex;align-items:center;gap:10px;margin-bottom:9px;}
.dh-rel{font-size:15px;font-weight:680;letter-spacing:-.3px;}
.db-day.is-today .dh-rel{color:var(--accent);}
.dh-rel.warn{color:var(--warn);}
.dh-date{font-size:12px;color:var(--ink-faint);font-family:'Spline Sans Mono',monospace;}
.dh-line{flex:1;height:1px;background:var(--line);}
.db-empty{color:var(--ink-faint);font-size:13.5px;font-style:italic;margin:2px 0 0;padding-left:2px;}

.db-task{
  display:flex;align-items:flex-start;gap:11px;padding:11px 12px;
  background:var(--surface);border:1px solid var(--line);border-radius:11px;margin-bottom:7px;
  transition:background .15s,opacity .2s;flex-wrap:wrap;
}
.db-task.done{opacity:.5;}
.db-check{
  flex-shrink:0;width:22px;height:22px;border-radius:7px;border:2px solid var(--ink-faint);
  background:none;cursor:pointer;display:grid;place-items:center;margin-top:1px;transition:all .15s;
}
.db-check .tick{font-size:13px;color:var(--on-accent);opacity:0;transition:opacity .12s;font-weight:900;}
.db-task.done .db-check{background:var(--c-hustle);border-color:var(--c-hustle);}
.db-task.done .db-check .tick{opacity:1;}
.db-taskmain{flex:1;display:flex;justify-content:space-between;align-items:center;gap:10px;cursor:pointer;min-width:0;}
.db-text{font-size:15px;line-height:1.35;word-break:break-word;}
.db-task.done .db-text{text-decoration:line-through;}
.db-meta{display:flex;align-items:center;gap:7px;flex-shrink:0;}
.m-time{font-size:12px;color:var(--ink-dim);font-family:'Spline Sans Mono',monospace;font-weight:600;}
.m-tag{width:8px;height:8px;border-radius:50%;display:block;}
.db-quickdel{
  flex-shrink:0;background:none;border:none;color:var(--ink-faint);font-size:14px;line-height:1;
  cursor:pointer;padding:3px 4px;margin-top:1px;border-radius:6px;opacity:.5;transition:all .12s;
}
.db-quickdel:hover{opacity:1;color:var(--warn);background:var(--accent-soft);}

.db-actions{display:flex;gap:6px;width:100%;padding-top:9px;margin-top:2px;border-top:1px solid var(--line);flex-wrap:wrap;}
.db-actions button{
  background:var(--surface2);border:1px solid var(--line);color:var(--ink-dim);
  font-size:12.5px;padding:5px 11px;border-radius:8px;cursor:pointer;font-family:inherit;font-weight:600;transition:all .12s;
}
.db-actions button:hover{color:var(--ink);border-color:var(--ink-faint);}
.db-actions button.del{margin-left:auto;color:var(--warn);}

/* history */
.db-history{margin-top:2px;}
.db-histhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;}
.hh-count{font-size:13px;color:var(--ink-dim);font-weight:600;}
.hh-clear{background:none;border:1px solid var(--line);color:var(--ink-dim);font-size:12.5px;padding:5px 12px;border-radius:8px;cursor:pointer;font-family:inherit;font-weight:600;transition:all .12s;}
.hh-clear:hover{color:var(--warn);border-color:var(--warn);}
.histrow{align-items:center;opacity:.85;}
.hist-badge{
  flex-shrink:0;width:22px;height:22px;border-radius:7px;display:grid;place-items:center;
  font-size:12px;font-weight:900;color:#fff;
}
.hist-badge.done{background:var(--c-hustle);}
.hist-badge.deleted{background:var(--ink-faint);}
.histrow.done .db-text{text-decoration:line-through;color:var(--ink-dim);}
.histrow.deleted .db-text{color:var(--ink-dim);}
.hist-reason{font-size:11px;color:var(--ink-faint);text-transform:uppercase;letter-spacing:.5px;font-weight:600;}
.hist-actions{display:flex;gap:6px;width:100%;padding-top:9px;margin-top:2px;border-top:1px solid var(--line);}
.hist-actions button{
  background:var(--surface2);border:1px solid var(--line);color:var(--ink-dim);
  font-size:12.5px;padding:5px 11px;border-radius:8px;cursor:pointer;font-family:inherit;font-weight:600;transition:all .12s;
}
.hist-actions button:hover{color:var(--ink);border-color:var(--ink-faint);}
.hist-actions button.del{margin-left:auto;color:var(--warn);}

/* undo toast */
.db-toast{
  position:sticky;bottom:16px;margin:16px auto 0;max-width:420px;
  display:flex;align-items:center;justify-content:space-between;gap:12px;
  background:var(--ink);color:var(--bg);padding:12px 16px;border-radius:12px;
  font-size:13.5px;font-weight:500;box-shadow:0 8px 24px rgba(42,36,29,.22);
  animation:fade .18s ease;
}
.db-toast button{
  background:var(--accent);border:none;color:var(--on-accent);
  font-size:13px;font-weight:700;padding:6px 14px;border-radius:8px;cursor:pointer;font-family:inherit;flex-shrink:0;
}

/* month */
.db-monthnav{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
.db-monthnav h2{font-size:17px;font-weight:680;margin:0;letter-spacing:-.3px;}
.db-monthnav button{background:var(--surface);border:1px solid var(--line);color:var(--ink);width:36px;height:36px;border-radius:10px;font-size:18px;cursor:pointer;transition:all .12s;}
.db-monthnav button:hover{background:var(--surface2);}
.db-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:5px;}
.db-dow{margin-bottom:6px;}
.dow{text-align:center;font-size:11px;color:var(--ink-faint);font-weight:600;text-transform:uppercase;letter-spacing:.5px;}
.cell{
  aspect-ratio:1;background:var(--surface);border:1px solid var(--line);border-radius:10px;
  display:flex;flex-direction:column;align-items:center;justify-content:flex-start;
  padding:6px 0;cursor:pointer;position:relative;transition:all .12s;
}
.cell.empty{background:none;border:none;cursor:default;}
.cell-n{font-size:13.5px;font-weight:600;color:var(--ink-dim);font-family:'Spline Sans Mono',monospace;}
.cell.today{border-color:var(--accent);}
.cell.today .cell-n{color:var(--accent);}
.cell.sel{background:var(--surface2);border-color:var(--ink-faint);}
.cell:hover{border-color:var(--ink-faint);}
.dots{display:flex;gap:3px;margin-top:5px;}
.dots i{width:5px;height:5px;border-radius:50%;display:block;}

.db-selday{margin-top:22px;padding-top:18px;border-top:1px solid var(--line);}
.db-selday h3{font-size:15px;font-weight:680;margin:0 0 11px;letter-spacing:-.3px;}
.db-selday h3 span{color:var(--ink-faint);font-weight:500;font-family:'Spline Sans Mono',monospace;font-size:12px;margin-left:4px;}

@media (max-width:480px){
  .db-glance{flex-direction:column;}
  .db-head h1{font-size:19px;}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;}}
`;
