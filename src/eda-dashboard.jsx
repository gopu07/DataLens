import { useState, useRef, useCallback, useMemo } from "react";
import { useCSVParser } from "./hooks/useCSVParser";
import {
  toNum, computeCorrelation, mutualInfoProxy, freqCount, fmt, downloadCSV
} from "./utils/mathUtils";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ScatterChart, Scatter, Cell, ReferenceLine
} from "recharts";

// ─── CONFIG (loaded from .env) ──────────────────────────────────────────────
const GROQ_API_KEY = import.meta.env.VITE_GROQ_API_KEY;
const GROQ_MODEL   = import.meta.env.VITE_GROQ_MODEL || "llama-3.3-70b-versatile";

// ─── THEME ─────────────────────────────────────────────────────────────────
const T = {
  bg: "#07080d", surface: "rgba(255,255,255,0.03)", border: "rgba(255,255,255,0.07)",
  accent: "#00f5d4", pink: "#f72585", purple: "#7209b7", blue: "#4cc9f0",
  orange: "#fb8500", green: "#06d6a0", text: "#e8eaf0", muted: "rgba(255,255,255,0.4)", faint: "rgba(255,255,255,0.07)",
};
const PALETTE = [T.accent, T.pink, T.blue, T.orange, T.purple, T.green, "#f9c74f", "#43aa8b"];

// ─── PROGRESSIVE LOADER ────────────────────────────────────────────────────
const STAGE_META = {
  initializing:           { label: "Initializing",       icon: "⚙️",  order: 0 },
  parsing:                { label: "Streaming CSV",       icon: "📡",  order: 1 },
  computing_stats:        { label: "Computing Statistics",icon: "📊",  order: 2 },
  computing_correlations: { label: "Correlations",        icon: "🔗",  order: 3 },
  finalizing:             { label: "Finalizing",          icon: "✅",  order: 4 },
  complete:               { label: "Rendering",           icon: "🎨",  order: 5 },
};

const ProgressLoader = ({ progress, fileName }) => {
  const stages = Object.entries(STAGE_META);
  const currentOrder = STAGE_META[progress?.stage]?.order ?? 0;
  const pct = progress?.percent > 0 ? progress.percent : null;

  return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans', system-ui, sans-serif", padding: 32 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap');
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes fadeUp { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
        .spin { animation: spin 1.2s linear infinite; }
        .fadein { animation: fadeUp 0.4s ease; }`}
      </style>

      {/* Spinning ring */}
      <div className="spin" style={{ width: 72, height: 72, borderRadius: "50%", border: `3px solid ${T.faint}`, borderTop: `3px solid ${T.accent}`, marginBottom: 28 }} />

      <div style={{ color: "#fff", fontSize: 20, fontWeight: 700, marginBottom: 6 }}>
        {STAGE_META[progress?.stage]?.icon} {STAGE_META[progress?.stage]?.label ?? "Processing"}
      </div>

      <div style={{ color: T.muted, fontSize: 12, fontFamily: "monospace", marginBottom: 28 }}>
        {progress?.detail || fileName}
      </div>

      {/* Stage pipeline */}
      <div style={{ display: "flex", alignItems: "center", gap: 0, marginBottom: 32 }}>
        {stages.slice(0, 5).map(([key, meta], idx) => {
          const done = meta.order < currentOrder;
          const active = meta.order === currentOrder;
          return (
            <div key={key} style={{ display: "flex", alignItems: "center" }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 14, fontWeight: 700, transition: "all 0.3s",
                  background: done ? T.accent : active ? T.accent + "33" : T.faint,
                  border: `2px solid ${done || active ? T.accent : T.border}`,
                  color: done ? "#000" : active ? T.accent : T.muted,
                  boxShadow: active ? `0 0 16px ${T.accent}55` : "none",
                }}>
                  {done ? "✓" : meta.icon}
                </div>
                <div style={{ fontSize: 9, fontFamily: "monospace", color: active ? T.accent : done ? T.muted : "rgba(255,255,255,0.2)", whiteSpace: "nowrap", letterSpacing: 0.5 }}>
                  {meta.label}
                </div>
              </div>
              {idx < 4 && <div style={{ width: 36, height: 2, background: done ? T.accent : T.faint, margin: "0 2px", marginBottom: 20, transition: "background 0.4s" }} />}
            </div>
          );
        })}
      </div>

      {/* Sub-progress bar (shown when percent > 0) */}
      {pct !== null && (
        <div style={{ width: 320, marginBottom: 12 }}>
          <div style={{ height: 4, borderRadius: 2, background: T.faint, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct}%`, background: `linear-gradient(90deg, ${T.accent}, ${T.blue})`, borderRadius: 2, transition: "width 0.3s" }} />
          </div>
          <div style={{ textAlign: "right", fontSize: 10, fontFamily: "monospace", color: T.muted, marginTop: 4 }}>{pct}%</div>
        </div>
      )}

      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.15)", fontFamily: "monospace", letterSpacing: 1 }}>Processing in Web Worker · UI is fully interactive</div>
    </div>
  );
};

// ─── UI ATOMS ──────────────────────────────────────────────────────────────
const StatCard = ({ label, value, sub, accent = T.accent, warn }) => (
  <div style={{ background: T.surface, border: `1px solid ${warn ? T.orange + "55" : T.border}`, borderRadius: 12, padding: "16px 20px", position: "relative", overflow: "hidden" }}>
    <div style={{ position: "absolute", top: 0, left: 0, width: 3, height: "100%", background: accent, borderRadius: "12px 0 0 12px" }} />
    <div style={{ color: T.muted, fontSize: 10, fontFamily: "monospace", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
    <div style={{ color: "#fff", fontSize: 20, fontWeight: 700 }}>{value}</div>
    {sub && <div style={{ color: T.muted, fontSize: 10, marginTop: 3, fontFamily: "monospace" }}>{sub}</div>}
  </div>
);

const SectionTitle = ({ icon, children }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "32px 0 14px" }}>
    <div style={{ width: 4, height: 20, background: T.accent, borderRadius: 2, flexShrink: 0 }} />
    <span style={{ color: "#fff", fontSize: 14, fontWeight: 700 }}>{icon && <span style={{ marginRight: 6 }}>{icon}</span>}{children}</span>
  </div>
);

const Card = ({ children, style = {} }) => (
  <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, padding: 20, ...style }}>{children}</div>
);

const CardLabel = ({ children }) => (
  <div style={{ color: T.muted, fontSize: 10, fontFamily: "monospace", letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 14 }}>{children}</div>
);

const Badge = ({ children, color = T.accent }) => (
  <span style={{ background: color + "22", border: `1px solid ${color}55`, color, borderRadius: 6, padding: "2px 8px", fontSize: 10, fontFamily: "monospace", fontWeight: 700 }}>{children}</span>
);

const ScoreBar = ({ score }) => {
  const color = score > 75 ? T.green : score > 50 ? T.orange : T.pink;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 5, borderRadius: 3, background: T.faint }}>
        <div style={{ width: `${score}%`, height: "100%", borderRadius: 3, background: color, transition: "width 0.5s" }} />
      </div>
      <span style={{ fontSize: 11, fontFamily: "monospace", color, fontWeight: 700, width: 30, textAlign: "right" }}>{score}</span>
    </div>
  );
};

const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#111827", border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 14px", fontSize: 11, fontFamily: "monospace", color: "#fff" }}>
      {label && <div style={{ color: T.muted, marginBottom: 4 }}>{label}</div>}
      {payload.map((p, i) => <div key={i} style={{ color: p.color || T.accent }}>{p.name}: {typeof p.value === "number" ? fmt(p.value, 3) : p.value}</div>)}
    </div>
  );
};

const Btn = ({ children, onClick, disabled, variant = "primary", small }) => {
  const bg = variant === "primary" ? `linear-gradient(135deg, ${T.accent}, #00b4d8)` : "rgba(255,255,255,0.07)";
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: disabled ? "rgba(255,255,255,0.04)" : bg, border: "none", borderRadius: 8,
      padding: small ? "5px 12px" : "10px 22px", color: disabled ? T.muted : variant === "primary" ? "#000" : "#fff",
      fontWeight: 700, fontSize: small ? 11 : 13, cursor: disabled ? "not-allowed" : "pointer", fontFamily: "inherit", transition: "opacity 0.2s"
    }}>{children}</button>
  );
};

const Sel = ({ value, onChange, options }) => (
  <select value={value} onChange={e => onChange(e.target.value)} style={{ background: "rgba(255,255,255,0.06)", border: `1px solid ${T.border}`, borderRadius: 7, padding: "6px 10px", color: "#fff", fontSize: 12, fontFamily: "monospace", outline: "none", colorScheme: "dark" }}>
    {options.map(o => <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>)}
  </select>
);

// ─── GROQ ──────────────────────────────────────────────────────────────────
async function groqCall(prompt, maxTokens = 800) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens })
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.choices?.[0]?.message?.content || "";
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
export default function DataLens() {
  const [data, setData] = useState(null);
  const [fileName, setFileName] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef();

  const [activeTab, setActiveTab] = useState("overview");
  const [activeCol, setActiveCol] = useState(null);
  const [scatterX, setScatterX] = useState("");
  const [scatterY, setScatterY] = useState("");
  const [targetCol, setTargetCol] = useState("");

  const [aiInsight, setAiInsight] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [prepCode, setPrepCode] = useState("");
  const [prepLoading, setPrepLoading] = useState(false);
  const [question, setQuestion] = useState("");
  const [qaAnswer, setQaAnswer] = useState("");
  const [qaLoading, setQaLoading] = useState(false);

  const { isProcessing, progress, error: parseError, parseFile: parseCsvWorker } = useCSVParser();

  const processFile = useCallback((file) => {
    if (!file) return;
    setFileName(file.name);
    const ext = file.name.split(".").pop().toLowerCase();
    if (ext !== "csv") { alert("Only CSV files are supported."); return; }
    parseCsvWorker(file, (result) => {
      setData(result);
      setActiveCol(result.headers[0]);
      setScatterX(result.numericCols[0] || "");
      setScatterY(result.numericCols[1] || result.numericCols[0] || "");
      setTargetCol(result.headers[result.headers.length - 1]);
      setAiInsight(""); setPrepCode(""); setQaAnswer(""); setActiveTab("overview");
    });
  }, [parseCsvWorker]);

  const onDrop = useCallback(e => { e.preventDefault(); setDragging(false); processFile(e.dataTransfer.files[0]); }, [processFile]);

  const buildSummary = useCallback(() => {
    if (!data) return "";
    const colLines = data.headers.map(h => {
      const c = data.columns[h];
      if (c.type === "numeric" && c.stats)
        return `${h} [numeric]: mean=${fmt(c.stats.mean)}, std=${fmt(c.stats.std)}, min=${fmt(c.stats.min)}, max=${fmt(c.stats.max)}, skew=${fmt(c.stats.skewness)}, outliers=${c.stats.outlierCount}, missing=${c.missingPct}%, quality=${c.qualityScore}/100, shape=${c.stats.shape}`;
      const top3 = (c.freq || []).slice(0, 3).map(f => `${f.name}(${f.value})`).join(", ");
      return `${h} [${c.type}]: unique=${c.unique}, top: ${top3}, missing=${c.missingPct}%, quality=${c.qualityScore}/100${c.storedAsString ? ", STORED AS STRING (should be numeric)" : ""}`;
    }).join("\n");
    return `File: ${fileName}\nRows: ${data.rows.length}, Cols: ${data.headers.length}, Duplicates: ${data.dupeRows.length}\n\n${colLines}`;
  }, [data, fileName]);

  const generateInsight = async () => {
    setAiLoading(true); setAiInsight("");
    try { setAiInsight(await groqCall(`You are a senior data scientist. Analyze this dataset and provide:\n1. What this dataset likely represents\n2. Top 3 most interesting findings with specific numbers\n3. Key data quality issues to fix before ML\n4. Two concrete next-step recommendations\n\nBe specific and concise. Use bullet points.\n\n${buildSummary()}`, 700)); }
    catch (e) { setAiInsight("Error: " + e.message); }
    setAiLoading(false);
  };

  const generatePrepCode = async () => {
    setPrepLoading(true); setPrepCode("");
    try {
      const raw = await groqCall(`You are a data scientist. Write a complete pandas preprocessing script in Python for this dataset.\nInclude: loading CSV, fixing dtypes, handling missing values (specific strategy per column), removing duplicates, outlier treatment (IQR capping), encoding categoricals, and df.info() at end.\nOutput ONLY clean Python code with brief inline comments. No markdown.\n\nDataset:\n${buildSummary()}`, 1000);
      setPrepCode(raw.replace(/```python|```/g, "").trim());
    } catch (e) { setPrepCode("Error: " + e.message); }
    setPrepLoading(false);
  };

  const askQuestion = async () => {
    if (!question.trim()) return;
    setQaLoading(true); setQaAnswer("");
    try { setQaAnswer(await groqCall(`Answer the user's question based on this dataset summary. Be specific and concise.\n\nDataset:\n${buildSummary()}\n\nQuestion: ${question}`, 500)); }
    catch (e) { setQaAnswer("Error: " + e.message); }
    setQaLoading(false);
  };

  const scatterData = useMemo(() => {
    if (!data || !scatterX || !scatterY) return [];
    return data.rows.slice(0, 400).map(r => ({ x: toNum(r[scatterX]), y: toNum(r[scatterY]) })).filter(p => p.x !== null && p.y !== null);
  }, [data, scatterX, scatterY]);

  const featureImportance = useMemo(() => {
    if (!data || !targetCol || !data.columns[targetCol]) return [];
    const tc = data.columns[targetCol];
    return data.headers.filter(h => h !== targetCol).map(h => {
      const c = data.columns[h];
      return { name: h, score: +mutualInfoProxy(tc.values, c.values, tc.type, c.type).toFixed(3), type: c.type };
    }).sort((a, b) => b.score - a.score).slice(0, 15);
  }, [data, targetCol]);

  const classImbalance = useMemo(() => {
    if (!data || !targetCol || !data.columns[targetCol]) return null;
    const col = data.columns[targetCol]; if (col.type !== "categorical") return null;
    const freq = freqCount(col.values); if (freq.length < 2) return null;
    const total = freq.reduce((s, f) => s + f.value, 0);
    const ratios = freq.map(f => ({ ...f, pct: ((f.value / total) * 100).toFixed(1) }));
    const ratio = (freq[0].value / freq[freq.length - 1].value).toFixed(1);
    return { ratios, imbalanceRatio: ratio, isImbalanced: freq[0].value / freq[freq.length - 1].value > 3 };
  }, [data, targetCol]);

  const getOutlierRows = h => {
    if (!data || !data.columns[h]?.stats) return [];
    const { lowerFence, upperFence } = data.columns[h].stats;
    return data.rows.filter(r => { const v = toNum(r[h]); return v !== null && (v < lowerFence || v > upperFence); });
  };

  const corrColor = v => { const a = Math.abs(v); if (a > 0.7) return v > 0 ? T.accent + "bb" : T.pink + "bb"; if (a > 0.4) return v > 0 ? T.accent + "44" : T.pink + "44"; return T.faint; };

  const TABS = [
    { id: "overview", label: "📊 Overview" }, { id: "columns", label: "🔬 Columns" },
    { id: "outliers", label: "⚠️ Outliers" }, { id: "correlations", label: "🔗 Correlations" },
    { id: "target", label: "🎯 Target" }, { id: "quality", label: "🛡 Quality" },
    { id: "ai", label: "✦ AI" }
  ];

  // ── PROGRESSIVE LOADER (shown while processing)
  if (isProcessing) return <ProgressLoader progress={progress} fileName={fileName} />;

  // ── UPLOAD / ERROR SCREEN
  if (!data) return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap');*{box-sizing:border-box}::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.1);border-radius:3px}select,input,textarea{outline:none}@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}.fadein{animation:fadeUp 0.5s ease}`}</style>

      {/* 200MB backend suggestion error */}
      {parseError && parseError.includes('too large') ? (
        <div className="fadein" style={{ maxWidth: 520, padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🗄️</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#fff", marginBottom: 10 }}>File Too Large for Browser</div>
          <div style={{ color: T.muted, fontSize: 13, lineHeight: 1.7, marginBottom: 24 }}>{parseError}</div>
          <div style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${T.border}`, borderRadius: 14, padding: 20, textAlign: "left" }}>
            <div style={{ color: T.accent, fontWeight: 700, fontSize: 12, marginBottom: 12, letterSpacing: 1, fontFamily: "monospace" }}>BACKEND OPTIONS</div>
            {[
              { icon: "🐍", label: "Python + Pandas/Polars", cmd: "pandas.read_csv(file, chunksize=50_000)" },
              { icon: "⚡", label: "DuckDB (SQL on files)", cmd: "SELECT * FROM read_csv_auto('file.csv')" },
              { icon: "🟢", label: "Node.js stream", cmd: "createReadStream(file).pipe(csvParser())" },
            ].map(({ icon, label, cmd }) => (
              <div key={label} style={{ marginBottom: 14 }}>
                <div style={{ color: T.text, fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{icon} {label}</div>
                <code style={{ fontSize: 11, color: T.accent, fontFamily: "monospace", background: T.faint, padding: "4px 8px", borderRadius: 5, display: "block" }}>{cmd}</code>
              </div>
            ))}
          </div>
          <button onClick={() => { window.location.reload(); }} style={{ marginTop: 20, background: T.faint, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 18px", color: T.muted, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>← Try a different file</button>
        </div>
      ) : (
        <div className="fadein" style={{ textAlign: "center", maxWidth: 480, padding: 24 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>⬡</div>
          <div style={{ fontSize: 30, fontWeight: 700, color: "#fff", marginBottom: 6, letterSpacing: -0.5 }}>DataLens</div>
          <div style={{ color: T.muted, fontSize: 12, fontFamily: "monospace", marginBottom: 36, letterSpacing: 1 }}>AI-POWERED EDA DASHBOARD</div>
          <div onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} onClick={() => fileRef.current.click()}
            style={{ border: `2px dashed ${dragging ? T.accent : "rgba(255,255,255,0.18)"}`, borderRadius: 20, padding: "56px 40px", cursor: "pointer", background: dragging ? T.accent + "08" : "rgba(255,255,255,0.02)", transition: "all 0.3s" }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>📂</div>
            <div style={{ color: "#fff", fontSize: 15, fontWeight: 600, marginBottom: 5 }}>Drop your dataset here</div>
            <div style={{ color: T.muted, fontSize: 12, fontFamily: "monospace" }}>CSV · up to 200 MB · auto-sampled for performance</div>
          </div>
          <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={e => processFile(e.target.files[0])} />
          {parseError && <div style={{ marginTop: 18, padding: "12px 16px", background: T.pink + "18", border: `1px solid ${T.pink}44`, borderRadius: 10, color: T.pink, fontSize: 12, fontFamily: "monospace", textAlign: "left" }}>⚠ {parseError}</div>}
          <div style={{ marginTop: 16, color: T.muted, fontSize: 11, fontFamily: "monospace" }}>All processing runs in-browser · AI powered by Groq</div>
        </div>
      )}
    </div>
  );

  const col = activeCol ? data.columns[activeCol] : null;
  const totalMissing = data.headers.reduce((s, h) => s + data.columns[h].missing, 0);

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap');*{box-sizing:border-box}select,input,textarea{outline:none;color-scheme:dark}::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.1);border-radius:3px}@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}.pulse{animation:pulse 1.4s infinite}.fadein{animation:fadeUp 0.35s ease}`}</style>

      {/* HEADER */}
      <div style={{ borderBottom: `1px solid ${T.border}`, padding: "13px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, background: "rgba(7,8,13,0.97)", backdropFilter: "blur(16px)", zIndex: 200 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 28, height: 28, background: `linear-gradient(135deg,${T.accent},${T.purple})`, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>⬡</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: "#fff", letterSpacing: -0.2 }}>DataLens</div>
            <div style={{ fontSize: 9, color: T.muted, fontFamily: "monospace", letterSpacing: 1 }}>EDA DASHBOARD</div>
          </div>
          <div style={{ padding: "3px 12px", background: T.faint, borderRadius: 20, fontSize: 11, fontFamily: "monospace", color: T.muted }}>
            📁 {fileName} · {data.meta?.isSampled ? `${data.meta.statsSampleSize.toLocaleString()} of ${data.meta.totalRows.toLocaleString()} rows` : `${data.rows.length.toLocaleString()} rows`} · {data.headers.length} cols
          </div>
          {data.meta?.isSampled && (
            <div style={{ padding: "3px 10px", background: T.orange + "22", border: `1px solid ${T.orange}44`, borderRadius: 20, fontSize: 10, fontFamily: "monospace", color: T.orange }}>sampled</div>
          )}
        </div>
        <Btn variant="ghost" small onClick={() => { setData(null); setFileName(""); }}>↩ New file</Btn>
      </div>

      {/* TAB BAR */}
      <div style={{ display: "flex", gap: 0, padding: "0 28px", borderBottom: `1px solid ${T.border}`, background: "rgba(7,8,13,0.8)", position: "sticky", top: 54, zIndex: 100, backdropFilter: "blur(12px)", overflowX: "auto" }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{ background: "transparent", border: "none", borderBottom: activeTab === t.id ? `2px solid ${T.accent}` : "2px solid transparent", padding: "10px 16px", color: activeTab === t.id ? T.accent : T.muted, fontWeight: activeTab === t.id ? 700 : 400, fontSize: 12, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap", transition: "all 0.15s" }}>{t.label}</button>
        ))}
      </div>

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "26px 24px" }} className="fadein">

        {/* ══ OVERVIEW ══════════════════════════════════════════════════════ */}
        {activeTab === "overview" && <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
            <StatCard label="Rows" value={data.rows.length.toLocaleString()} />
            <StatCard label="Columns" value={data.headers.length} />
            <StatCard label="Numeric Cols" value={data.numericCols.length} accent={T.blue} />
            <StatCard label="Categorical" value={data.headers.filter(h => data.columns[h].type === "categorical").length} accent={T.pink} />
            <StatCard label="Missing Values" value={totalMissing.toLocaleString()} accent={totalMissing > 0 ? T.orange : T.green} warn={totalMissing > 0} />
            <StatCard label="Duplicate Rows" value={data.dupeRows.length} accent={data.dupeRows.length > 0 ? T.orange : T.green} warn={data.dupeRows.length > 0} />
          </div>

          {/* type issues */}
          {data.headers.some(h => data.columns[h].storedAsString) && (
            <div style={{ marginTop: 18, padding: "14px 18px", background: T.orange + "12", border: `1px solid ${T.orange}44`, borderRadius: 12 }}>
              <div style={{ fontWeight: 700, color: T.orange, marginBottom: 8, fontSize: 13 }}>⚠️ Type Mismatch Detected</div>
              {data.headers.filter(h => data.columns[h].storedAsString).map(h => (
                <div key={h} style={{ fontSize: 11, fontFamily: "monospace", color: T.text, marginBottom: 4 }}>
                  <span style={{ color: T.orange }}>{h}</span> — stored as text but values are numeric → <code style={{ color: T.accent }}>pd.to_numeric(df['{h}'], errors='coerce')</code>
                </div>
              ))}
            </div>
          )}

          {/* duplicates */}
          {data.dupeRows.length > 0 && (
            <div style={{ marginTop: 14, padding: "12px 18px", background: T.orange + "10", border: `1px solid ${T.orange}33`, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div style={{ fontSize: 13 }}><span style={{ color: T.orange, fontWeight: 700 }}>{data.dupeRows.length} exact duplicate rows</span> found → <code style={{ color: T.accent, fontSize: 12 }}>df.drop_duplicates(inplace=True)</code></div>
              <Btn small variant="ghost" onClick={() => downloadCSV(data.dupeRows.map(i => data.rows[i]), data.headers, "duplicates.csv")}>⬇ Export dupes</Btn>
            </div>
          )}

          {/* high cardinality */}
          {data.headers.some(h => data.columns[h].type === "categorical" && data.columns[h].unique > 30 && data.columns[h].unique < data.rows.length) && (
            <div style={{ marginTop: 14, padding: "14px 18px", background: T.purple + "12", border: `1px solid ${T.purple}44`, borderRadius: 12 }}>
              <div style={{ fontWeight: 700, color: T.purple, marginBottom: 8, fontSize: 13 }}>🃏 High Cardinality Warning</div>
              {data.headers.filter(h => data.columns[h].type === "categorical" && data.columns[h].unique > 30 && data.columns[h].unique < data.rows.length).map(h => (
                <div key={h} style={{ fontSize: 11, fontFamily: "monospace", marginBottom: 3 }}>
                  <span style={{ color: T.purple }}>{h}</span>: {data.columns[h].unique} unique values — one-hot encoding creates {data.columns[h].unique} features. Consider target encoding or frequency encoding.
                </div>
              ))}
            </div>
          )}

          <SectionTitle icon="📋">Data Preview</SectionTitle>
          <div style={{ overflowX: "auto", borderRadius: 12, border: `1px solid ${T.border}` }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: "monospace" }}>
              <thead>
                <tr style={{ background: "rgba(255,255,255,0.04)" }}>
                  <th style={{ padding: "9px 12px", color: T.muted, textAlign: "left", borderBottom: `1px solid ${T.border}`, fontWeight: 600 }}>#</th>
                  {data.headers.map(h => (
                    <th key={h} style={{ padding: "9px 12px", textAlign: "left", color: T.muted, borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap", fontWeight: 600 }}>
                      {h} <Badge color={data.columns[h].type === "numeric" ? T.blue : data.columns[h].type === "datetime" ? T.green : T.pink}>{data.columns[h].type[0].toUpperCase()}</Badge>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.slice(0, 7).map((row, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${T.faint}` }}>
                    <td style={{ padding: "7px 12px", color: T.muted }}>{i + 1}</td>
                    {data.headers.map(h => (
                      <td key={h} style={{ padding: "7px 12px", color: row[h] === "" ? "rgba(255,255,255,0.18)" : T.text, whiteSpace: "nowrap", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis" }}>
                        {row[h] === "" ? "∅" : String(row[h]).slice(0, 30)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <SectionTitle icon="🕳">Missing Values Map</SectionTitle>
          <Card>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))", gap: 14 }}>
              {data.headers.map(h => {
                const pct = parseFloat(data.columns[h].missingPct);
                return (
                  <div key={h}>
                    <div style={{ fontSize: 11, fontFamily: "monospace", color: T.muted, marginBottom: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={h}>{h}</div>
                    <div style={{ height: 5, borderRadius: 3, background: T.faint }}>
                      <div style={{ height: "100%", borderRadius: 3, width: `${Math.min(100, pct)}%`, background: pct > 20 ? T.pink : pct > 5 ? T.orange : T.accent }} />
                    </div>
                    <div style={{ fontSize: 10, fontFamily: "monospace", color: pct > 5 ? T.orange : T.muted, marginTop: 3 }}>{pct}% missing</div>
                  </div>
                );
              })}
            </div>
          </Card>
        </>}

        {/* ══ COLUMNS ═══════════════════════════════════════════════════════ */}
        {activeTab === "columns" && <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 20 }}>
            {data.headers.map(h => (
              <button key={h} onClick={() => setActiveCol(h)} style={{ background: activeCol === h ? T.accent : T.faint, border: `1px solid ${activeCol === h ? T.accent : T.border}`, borderRadius: 8, padding: "5px 13px", color: activeCol === h ? "#000" : T.muted, cursor: "pointer", fontSize: 12, fontFamily: "monospace", fontWeight: activeCol === h ? 700 : 400, transition: "all 0.15s" }}>{h}</button>
            ))}
          </div>

          {col && (
            <div style={{ display: "grid", gridTemplateColumns: "290px 1fr", gap: 16 }}>
              <Card>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                  <span style={{ fontWeight: 700, fontSize: 14, color: "#fff" }}>{activeCol}</span>
                  <Badge color={col.type === "numeric" ? T.blue : col.type === "datetime" ? T.green : T.pink}>{col.type}</Badge>
                  {col.storedAsString && <Badge color={T.orange}>type mismatch</Badge>}
                </div>
                <ScoreBar score={col.qualityScore} />
                <div style={{ color: T.muted, fontSize: 9, fontFamily: "monospace", marginBottom: 12, marginTop: 3 }}>QUALITY SCORE</div>
                {[
                  ["Total Rows", data.rows.length], ["Unique Values", col.unique],
                  ["Missing", `${col.missing} (${col.missingPct}%)`],
                  ...(col.stats ? [
                    ["Mean", fmt(col.stats.mean)], ["Median", fmt(col.stats.median)], ["Std Dev", fmt(col.stats.std)],
                    ["Min", fmt(col.stats.min)], ["Max", fmt(col.stats.max)],
                    ["Q1", fmt(col.stats.q1)], ["Q3", fmt(col.stats.q3)], ["IQR", fmt(col.stats.iqr)],
                    ["Skewness", fmt(col.stats.skewness)], ["Kurtosis", fmt(col.stats.kurtosis)],
                    ["Shape", col.stats.shape], ["Outliers (IQR)", col.stats.outlierCount],
                  ] : [])
                ].map(([label, value]) => (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between", borderBottom: `1px solid ${T.faint}`, padding: "6px 0" }}>
                    <span style={{ color: T.muted, fontSize: 11, fontFamily: "monospace" }}>{label}</span>
                    <span style={{ color: "#fff", fontSize: 11, fontFamily: "monospace", fontWeight: 600, textAlign: "right", maxWidth: 150 }}>{value}</span>
                  </div>
                ))}
                {col.stats?.outlierCount > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <Btn small variant="ghost" onClick={() => { downloadCSV(getOutlierRows(activeCol), data.headers, `outliers_${activeCol}.csv`); }}>⬇ Export {col.stats.outlierCount} outlier rows</Btn>
                  </div>
                )}
              </Card>

              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <Card>
                  <CardLabel>{col.type === "numeric" ? "Distribution Histogram" : "Top Value Frequencies"}</CardLabel>
                  <ResponsiveContainer width="100%" height={195}>
                    {col.type === "numeric" && col.histogram ? (
                      <BarChart data={col.histogram} margin={{ top: 0, right: 0, left: -26, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={T.faint} />
                        <XAxis dataKey="range" tick={{ fill: T.muted, fontSize: 9, fontFamily: "monospace" }} />
                        <YAxis tick={{ fill: T.muted, fontSize: 9, fontFamily: "monospace" }} />
                        <Tooltip content={<TT />} />
                        <Bar dataKey="count" fill={T.accent} radius={[3, 3, 0, 0]} />
                      </BarChart>
                    ) : (
                      <BarChart data={col.freq || []} layout="vertical" margin={{ top: 0, right: 20, left: 10, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={T.faint} />
                        <XAxis type="number" tick={{ fill: T.muted, fontSize: 9, fontFamily: "monospace" }} />
                        <YAxis type="category" dataKey="name" tick={{ fill: T.muted, fontSize: 10, fontFamily: "monospace" }} width={90} />
                        <Tooltip content={<TT />} />
                        <Bar dataKey="value" radius={[0, 3, 3, 0]}>{(col.freq || []).map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}</Bar>
                      </BarChart>
                    )}
                  </ResponsiveContainer>
                </Card>

                {col.stats && (
                  <Card>
                    <CardLabel>Box Plot (IQR Fence Method)</CardLabel>
                    <div style={{ padding: "10px 16px 0" }}>
                      {(() => {
                        const s = col.stats;
                        const range = s.max - s.min || 1;
                        const pct = v => ((v - s.min) / range * 100).toFixed(1) + "%";
                        const clamp = v => Math.max(0, Math.min(100, (v - s.min) / range * 100));
                        return (
                          <div style={{ position: "relative", height: 90 }}>
                            <div style={{ position: "absolute", top: 52, left: 0, right: 0, height: 1, background: T.faint }} />
                            <div style={{ position: "absolute", top: 28, left: pct(s.q1), width: `${clamp(s.q3) - clamp(s.q1)}%`, height: 28, background: T.accent + "28", border: `1.5px solid ${T.accent}`, borderRadius: 5 }} />
                            <div style={{ position: "absolute", top: 26, left: pct(s.median), width: 2.5, height: 32, background: T.accent, borderRadius: 2 }} />
                            <div style={{ position: "absolute", top: 41, left: pct(Math.max(s.min, s.lowerFence)), width: `${Math.max(0, clamp(s.q1) - clamp(Math.max(s.min, s.lowerFence)))}%`, height: 1, background: T.muted }} />
                            <div style={{ position: "absolute", top: 41, left: pct(s.q3), width: `${Math.max(0, clamp(Math.min(s.max, s.upperFence)) - clamp(s.q3))}%`, height: 1, background: T.muted }} />
                            {s.outlierVals.slice(0, 50).map((v, i) => (
                              <div key={i} style={{ position: "absolute", top: 36, left: `calc(${pct(v)} - 3px)`, width: 6, height: 6, borderRadius: "50%", background: T.pink, opacity: 0.75 }} />
                            ))}
                            {[["min", s.min], ["Q1", s.q1], ["med", s.median], ["Q3", s.q3], ["max", s.max]].map(([label, v]) => (
                              <div key={label} style={{ position: "absolute", top: 62, left: `calc(${pct(v)} - 14px)`, fontSize: 9, fontFamily: "monospace", color: T.muted, textAlign: "center", width: 28 }}>
                                <div style={{ color: T.accent, fontWeight: 700 }}>{label}</div>
                                <div>{fmt(v, 1)}</div>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                      <div style={{ marginTop: 14, fontSize: 11, color: T.muted, fontFamily: "monospace" }}>
                        <span style={{ color: T.pink }}>●</span> {col.stats.outlierCount} outliers · Fences: [{fmt(col.stats.lowerFence)}, {fmt(col.stats.upperFence)}] · Distribution: {col.stats.shape}
                      </div>
                    </div>
                  </Card>
                )}
              </div>
            </div>
          )}
        </>}

        {/* ══ OUTLIERS ══════════════════════════════════════════════════════ */}
        {activeTab === "outliers" && <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(250px,1fr))", gap: 14 }}>
            {data.numericCols.map(h => {
              const s = data.columns[h].stats; if (!s) return null;
              const pct = ((s.outlierCount / s.count) * 100).toFixed(1);
              return (
                <Card key={h}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>{h}</div>
                    <Badge color={s.outlierCount > 0 ? T.pink : T.green}>{s.outlierCount} outliers</Badge>
                  </div>
                  <div style={{ fontSize: 11, fontFamily: "monospace", color: T.muted, marginBottom: 8 }}>{pct}% of values · Fence: [{fmt(s.lowerFence, 2)}, {fmt(s.upperFence, 2)}]</div>
                  {s.outlierCount > 0 && <>
                    <div style={{ fontSize: 11, fontFamily: "monospace", color: T.text, marginBottom: 6 }}>Sample: {s.outlierVals.slice(0, 5).map(v => fmt(v, 2)).join(", ")}{s.outlierVals.length > 5 ? " ..." : ""}</div>
                    <div style={{ fontSize: 11, fontFamily: "monospace", color: T.muted, marginBottom: 10 }}>Fix: {Math.abs(s.skewness) > 1 ? "Log transform or winsorize" : "Cap at IQR fences"}</div>
                    <Btn small variant="ghost" onClick={() => downloadCSV(getOutlierRows(h), data.headers, `outliers_${h}.csv`)}>⬇ Export rows</Btn>
                  </>}
                </Card>
              );
            })}
          </div>

          <SectionTitle icon="📦">Outlier Count by Column</SectionTitle>
          <Card>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data.numericCols.map(h => ({ name: h, outliers: data.columns[h].stats?.outlierCount || 0 })).sort((a, b) => b.outliers - a.outliers)} margin={{ top: 0, right: 20, left: -10, bottom: 36 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.faint} />
                <XAxis dataKey="name" tick={{ fill: T.muted, fontSize: 10, fontFamily: "monospace" }} angle={-30} textAnchor="end" />
                <YAxis tick={{ fill: T.muted, fontSize: 10, fontFamily: "monospace" }} />
                <Tooltip content={<TT />} />
                <Bar dataKey="outliers" radius={[4, 4, 0, 0]} fill={T.pink} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </>}

        {/* ══ CORRELATIONS ══════════════════════════════════════════════════ */}
        {activeTab === "correlations" && <>
          {data.numericCols.length < 2
            ? <div style={{ color: T.muted, padding: 40, textAlign: "center", fontFamily: "monospace" }}>Need at least 2 numeric columns.</div>
            : <>
              <SectionTitle icon="🔥">Correlation Heatmap</SectionTitle>
              <Card style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "separate", borderSpacing: 3, fontSize: 11, fontFamily: "monospace" }}>
                  <thead>
                    <tr>
                      <th style={{ padding: "4px 8px", color: T.muted }}></th>
                      {data.numericCols.map(c => <th key={c} style={{ padding: "4px 8px", color: T.muted, fontWeight: 600, whiteSpace: "nowrap", fontSize: 10 }}>{c.slice(0, 12)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {data.numericCols.map((row, i) => (
                      <tr key={row}>
                        <td style={{ padding: "4px 8px", color: T.muted, fontWeight: 600, whiteSpace: "nowrap", fontSize: 10 }}>{row.slice(0, 12)}</td>
                        {data.corrMatrix[i].map((val, j) => (
                          <td key={j} title={`${row} × ${data.numericCols[j]}: ${val}`} style={{ padding: "6px 10px", textAlign: "center", background: corrColor(val), borderRadius: 5, color: Math.abs(val) > 0.7 ? "#fff" : T.muted, fontWeight: Math.abs(val) > 0.7 ? 700 : 400 }}>{fmt(val, 2)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ marginTop: 12, display: "flex", gap: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 12, height: 12, background: T.accent, borderRadius: 2 }} /><span style={{ fontSize: 10, color: T.muted, fontFamily: "monospace" }}>Strong positive (&gt;0.7)</span></div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 12, height: 12, background: T.pink, borderRadius: 2 }} /><span style={{ fontSize: 10, color: T.muted, fontFamily: "monospace" }}>Strong negative (&lt;-0.7)</span></div>
                </div>
              </Card>

              <SectionTitle icon="🔍">Scatter Explorer</SectionTitle>
              <Card>
                <div style={{ display: "flex", gap: 14, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
                  {[["X Axis", scatterX, setScatterX], ["Y Axis", scatterY, setScatterY]].map(([label, val, set]) => (
                    <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 11, fontFamily: "monospace", color: T.muted }}>{label}:</span>
                      <Sel value={val} onChange={set} options={data.numericCols} />
                    </div>
                  ))}
                  <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, color: T.muted, fontFamily: "monospace" }}>r =</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: T.accent, fontFamily: "monospace" }}>{scatterX && scatterY ? fmt(computeCorrelation(data.columns[scatterX].values, data.columns[scatterY].values), 3) : "—"}</span>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={250}>
                  <ScatterChart margin={{ top: 0, right: 20, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={T.faint} />
                    <XAxis dataKey="x" name={scatterX} tick={{ fill: T.muted, fontSize: 10, fontFamily: "monospace" }} />
                    <YAxis dataKey="y" name={scatterY} tick={{ fill: T.muted, fontSize: 10, fontFamily: "monospace" }} />
                    <Tooltip content={<TT />} cursor={{ strokeDasharray: "3 3" }} />
                    <Scatter data={scatterData} fill={T.accent} fillOpacity={0.5} />
                  </ScatterChart>
                </ResponsiveContainer>
              </Card>

              <SectionTitle icon="🏆">Strongest Correlations</SectionTitle>
              <Card>
                {(() => {
                  const pairs = [];
                  data.numericCols.forEach((a, i) => data.numericCols.forEach((b, j) => { if (j <= i) return; pairs.push({ a, b, r: data.corrMatrix[i][j] }); }));
                  return pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r)).slice(0, 10).map(({ a, b, r }, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: `1px solid ${T.faint}` }}>
                      <span style={{ color: T.muted, fontFamily: "monospace", fontSize: 11, width: 20 }}>{i + 1}</span>
                      <span style={{ fontFamily: "monospace", fontSize: 12, flex: 1 }}><span style={{ color: T.accent }}>{a}</span> × <span style={{ color: T.blue }}>{b}</span></span>
                      <div style={{ width: 110, height: 5, background: T.faint, borderRadius: 3 }}>
                        <div style={{ width: `${Math.abs(r) * 100}%`, height: "100%", borderRadius: 3, background: r > 0 ? T.accent : T.pink }} />
                      </div>
                      <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, color: r > 0 ? T.accent : T.pink, width: 50, textAlign: "right" }}>{fmt(r, 3)}</span>
                    </div>
                  ));
                })()}
              </Card>
            </>
          }
        </>}

        {/* ══ TARGET ════════════════════════════════════════════════════════ */}
        {activeTab === "target" && <>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, color: T.muted, fontFamily: "monospace" }}>Target column:</span>
            <Sel value={targetCol} onChange={setTargetCol} options={data.headers} />
            <Badge color={data.columns[targetCol]?.type === "numeric" ? T.blue : T.pink}>{data.columns[targetCol]?.type}</Badge>
          </div>

          {classImbalance && <>
            <SectionTitle icon="⚖️">Class Distribution</SectionTitle>
            <Card>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
                <Badge color={classImbalance.isImbalanced ? T.pink : T.green}>{classImbalance.isImbalanced ? "Imbalanced" : "Balanced"}</Badge>
                <span style={{ fontSize: 12, fontFamily: "monospace", color: T.muted }}>Ratio: {classImbalance.imbalanceRatio}:1</span>
                {classImbalance.isImbalanced && <span style={{ fontSize: 12, color: T.orange }}>⚠ Consider SMOTE / class_weight='balanced'</span>}
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
                {classImbalance.ratios.map((r, i) => (
                  <div key={r.name} style={{ background: T.faint, borderRadius: 10, padding: "10px 16px", textAlign: "center", minWidth: 80 }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: PALETTE[i % PALETTE.length] }}>{r.pct}%</div>
                    <div style={{ fontSize: 11, fontFamily: "monospace", color: T.muted, marginTop: 3 }}>{String(r.name).slice(0, 14)}</div>
                    <div style={{ fontSize: 10, color: T.muted, fontFamily: "monospace" }}>{r.value} rows</div>
                  </div>
                ))}
              </div>
              <ResponsiveContainer width="100%" height={170}>
                <BarChart data={classImbalance.ratios} margin={{ top: 0, right: 20, left: -15, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={T.faint} />
                  <XAxis dataKey="name" tick={{ fill: T.muted, fontSize: 11, fontFamily: "monospace" }} />
                  <YAxis tick={{ fill: T.muted, fontSize: 10, fontFamily: "monospace" }} />
                  <Tooltip content={<TT />} />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>{classImbalance.ratios.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}</Bar>
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </>}

          <SectionTitle icon="🎯">Feature Importance (vs Target)</SectionTitle>
          <Card>
            <div style={{ marginBottom: 12, fontSize: 12, color: T.muted, fontFamily: "monospace" }}>
              Metric: Pearson |r| for num↔num · Correlation ratio η for cat↔num · Cramér's V for cat↔cat
            </div>
            {featureImportance.length === 0
              ? <div style={{ color: T.muted, fontFamily: "monospace", fontSize: 13 }}>Select a target column above.</div>
              : <>
                <ResponsiveContainer width="100%" height={Math.max(180, featureImportance.length * 30)}>
                  <BarChart data={featureImportance} layout="vertical" margin={{ top: 0, right: 70, left: 10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={T.faint} />
                    <XAxis type="number" domain={[0, 1]} tick={{ fill: T.muted, fontSize: 10, fontFamily: "monospace" }} />
                    <YAxis type="category" dataKey="name" tick={{ fill: T.muted, fontSize: 11, fontFamily: "monospace" }} width={120} />
                    <Tooltip content={<TT />} />
                    <Bar dataKey="score" radius={[0, 4, 4, 0]} label={{ position: "right", fill: T.accent, fontSize: 10, fontFamily: "monospace", formatter: v => fmt(v, 3) }}>
                      {featureImportance.map((f, i) => <Cell key={i} fill={f.score > 0.5 ? T.accent : f.score > 0.25 ? T.blue : T.muted} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 5 }}>
                  {featureImportance.slice(0, 5).map(f => (
                    <div key={f.name} style={{ fontSize: 12, fontFamily: "monospace", color: T.muted }}>
                      <span style={{ color: f.score > 0.5 ? T.accent : T.text }}>{f.name}</span>: {f.score > 0.5 ? "🔴 Strong predictor" : f.score > 0.25 ? "🟡 Moderate signal" : "⚪ Weak signal"} ({fmt(f.score, 3)})
                    </div>
                  ))}
                </div>
              </>
            }
          </Card>
        </>}

        {/* ══ QUALITY ═══════════════════════════════════════════════════════ */}
        {activeTab === "quality" && <>
          <SectionTitle icon="📊">Quality Score by Column</SectionTitle>
          <Card style={{ marginBottom: 20 }}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={[...data.headers].sort((a, b) => data.columns[a].qualityScore - data.columns[b].qualityScore).map(h => ({ name: h, score: data.columns[h].qualityScore }))} margin={{ top: 0, right: 20, left: -10, bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.faint} />
                <XAxis dataKey="name" tick={{ fill: T.muted, fontSize: 9, fontFamily: "monospace" }} angle={-35} textAnchor="end" />
                <YAxis domain={[0, 100]} tick={{ fill: T.muted, fontSize: 10, fontFamily: "monospace" }} />
                <Tooltip content={<TT />} />
                <ReferenceLine y={75} stroke={T.green} strokeDasharray="4 4" label={{ value: "Good", fill: T.green, fontSize: 10 }} />
                <ReferenceLine y={50} stroke={T.orange} strokeDasharray="4 4" label={{ value: "Fair", fill: T.orange, fontSize: 10 }} />
                <Bar dataKey="score" radius={[4, 4, 0, 0]}>
                  {[...data.headers].sort((a, b) => data.columns[a].qualityScore - data.columns[b].qualityScore).map((h, i) => <Cell key={i} fill={data.columns[h].qualityScore > 75 ? T.green : data.columns[h].qualityScore > 50 ? T.orange : T.pink} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(215px,1fr))", gap: 12 }}>
            {[...data.headers].sort((a, b) => data.columns[a].qualityScore - data.columns[b].qualityScore).map(h => {
              const c = data.columns[h]; const score = c.qualityScore;
              const issues = [];
              if (parseFloat(c.missingPct) > 5) issues.push(`${c.missingPct}% missing`);
              if (c.stats?.outlierCount > 0) issues.push(`${c.stats.outlierCount} outliers`);
              if (c.storedAsString) issues.push("type mismatch");
              if (c.type === "categorical" && c.unique > 50) issues.push("high cardinality");
              if (c.stats && Math.abs(c.stats.skewness) > 2) issues.push("high skew");
              return (
                <Card key={h}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 130 }}>{h}</div>
                    <Badge color={c.type === "numeric" ? T.blue : T.pink}>{c.type[0].toUpperCase()}</Badge>
                  </div>
                  <ScoreBar score={score} />
                  <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                    {issues.length === 0
                      ? <div style={{ fontSize: 10, fontFamily: "monospace", color: T.green }}>✓ No issues detected</div>
                      : issues.map(iss => <div key={iss} style={{ fontSize: 10, fontFamily: "monospace", color: T.orange }}>⚠ {iss}</div>)}
                  </div>
                </Card>
              );
            })}
          </div>
        </>}

        {/* ══ AI ════════════════════════════════════════════════════════════ */}
        {activeTab === "ai" && <>
          <SectionTitle icon="✦">Dataset Insights</SectionTitle>
          <Card>
            <div style={{ color: T.muted, fontSize: 12, marginBottom: 14 }}>AI analyzes your dataset summary and surfaces the most important findings.</div>
            <Btn onClick={generateInsight} disabled={aiLoading}><span className={aiLoading ? "pulse" : ""}>{aiLoading ? "⏳ Analyzing..." : "✦ Generate Insights"}</span></Btn>
            {aiInsight && (
              <div style={{ marginTop: 18, padding: 18, background: T.accent + "08", border: `1px solid ${T.accent}22`, borderRadius: 10 }}>
                <div style={{ color: T.accent, fontSize: 10, fontFamily: "monospace", marginBottom: 10, letterSpacing: 1 }}>GROQ · {GROQ_MODEL.toUpperCase()}</div>
                <div style={{ color: T.text, fontSize: 13, lineHeight: 1.85, whiteSpace: "pre-wrap" }}>{aiInsight}</div>
              </div>
            )}
          </Card>

          <SectionTitle icon="🐍">Preprocessing Code Generator</SectionTitle>
          <Card>
            <div style={{ color: T.muted, fontSize: 12, marginBottom: 14 }}>Generates a ready-to-run pandas script tailored to your dataset's specific issues — missing values, outliers, type fixes, encoding.</div>
            <Btn onClick={generatePrepCode} disabled={prepLoading}><span className={prepLoading ? "pulse" : ""}>{prepLoading ? "⏳ Generating..." : "🐍 Generate Pandas Code"}</span></Btn>
            {prepCode && (
              <div style={{ marginTop: 18, position: "relative" }}>
                <button onClick={() => navigator.clipboard.writeText(prepCode)} style={{ position: "absolute", top: 10, right: 10, background: T.faint, border: `1px solid ${T.border}`, borderRadius: 6, padding: "4px 10px", color: T.muted, fontSize: 11, cursor: "pointer", fontFamily: "monospace" }}>📋 Copy</button>
                <pre style={{ background: "#0d1117", border: `1px solid ${T.border}`, borderRadius: 10, padding: "18px 18px 18px 18px", margin: 0, overflowX: "auto", fontSize: 12, fontFamily: "monospace", color: "#c9d1d9", lineHeight: 1.75 }}>{prepCode}</pre>
              </div>
            )}
          </Card>

          <SectionTitle icon="💬">Natural Language Q&A</SectionTitle>
          <Card>
            <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
              <input value={question} onChange={e => setQuestion(e.target.value)} onKeyDown={e => e.key === "Enter" && askQuestion()}
                placeholder="e.g. Which feature is most correlated with the target?"
                style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 14px", color: "#fff", fontSize: 13, fontFamily: "inherit" }} />
              <Btn onClick={askQuestion} disabled={qaLoading || !question.trim()}>{qaLoading ? "..." : "Ask"}</Btn>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              {["Which feature is most important?", "What preprocessing is needed?", "Any data quality issues?", "Is the target balanced?", "Which columns to drop?"].map(q => (
                <button key={q} onClick={() => setQuestion(q)} style={{ background: T.faint, border: `1px solid ${T.border}`, borderRadius: 20, padding: "4px 12px", color: T.muted, fontSize: 11, cursor: "pointer", fontFamily: "monospace" }}>{q}</button>
              ))}
            </div>
            {qaAnswer && (
              <div style={{ padding: 16, background: T.pink + "08", border: `1px solid ${T.pink}22`, borderRadius: 10, color: T.text, fontSize: 13, lineHeight: 1.85, whiteSpace: "pre-wrap" }}>{qaAnswer}</div>
            )}
          </Card>
        </>}

      </div>
    </div>
  );
}
