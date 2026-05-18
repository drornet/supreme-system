import { useState, useEffect, useCallback, useRef } from "react";

// ─── CHUNK DATA (split for 5MB storage limit) ─────────────────────────────
// Data is stored in window.storage in chunks; on first load, we seed from CSV data embedded here.
// The initial CSV data is injected via INITIAL_DATA below.

const ADMIN_PASSWORD = "admin123"; // Change this!
const CHUNKS_COUNT = 7;
const CHUNK_SIZE = 1000;

// ─── STATUS COLORS ─────────────────────────────────────────────────────────
const STATUS_COLORS = {
  "פעיל": { bg: "#d1fae5", text: "#065f46", dot: "#10b981" },
  "לא פעיל": { bg: "#fee2e2", text: "#991b1b", dot: "#ef4444" },
  "חדש": { bg: "#dbeafe", text: "#1e40af", dot: "#3b82f6" },
  "חסום לתשלום": { bg: "#fef3c7", text: "#92400e", dot: "#f59e0b" },
};

const STATUS_ICONS = { "פעיל": "✓", "לא פעיל": "✗", "חדש": "★", "חסום לתשלום": "⚠" };

// ─── INITIAL DATA (loaded from CSV, embedded as JS) ────────────────────────
// This is loaded once into storage; subsequent runs use storage.
async function loadInitialData() {
  // Load all chunks from storage
  const chunks = [];
  for (let i = 0; i < CHUNKS_COUNT; i++) {
    try {
      const res = await window.storage.get(`suppliers_chunk_${i}`);
      if (res && res.value) chunks.push(JSON.parse(res.value));
    } catch (e) { /* chunk missing */ }
  }
  if (chunks.length > 0) return chunks.flat();
  return null; // not seeded yet
}

async function saveSuppliers(suppliers) {
  const chunks = [];
  for (let i = 0; i < suppliers.length; i += CHUNK_SIZE) {
    chunks.push(suppliers.slice(i, i + CHUNK_SIZE));
  }
  for (let i = 0; i < chunks.length; i++) {
    await window.storage.set(`suppliers_chunk_${i}`, JSON.stringify(chunks[i]));
  }
  // Clear extra chunks if list shrank
  for (let i = chunks.length; i < CHUNKS_COUNT + 5; i++) {
    try { await window.storage.delete(`suppliers_chunk_${i}`); } catch {}
  }
}

async function loadExtras() {
  try {
    const res = await window.storage.get("supplier_extras");
    return res ? JSON.parse(res.value) : {};
  } catch { return {}; }
}

async function saveExtras(extras) {
  await window.storage.set("supplier_extras", JSON.stringify(extras));
}

async function loadRecommendations() {
  try {
    const res = await window.storage.get("supplier_recommendations");
    return res ? JSON.parse(res.value) : {};
  } catch { return {}; }
}

async function saveRecommendations(recs) {
  await window.storage.set("supplier_recommendations", JSON.stringify(recs));
}

// ─── PARSE PHONE ────────────────────────────────────────────────────────────
function formatPhone(phone) {
  if (!phone || phone === "nan" || phone === "NaN") return "";
  const s = String(phone).trim().replace(/[^\d\-+]/g, "");
  return s || "";
}

// ─── SEED CSV DATA (first run only) ────────────────────────────────────────
// We dynamically fetch the data from a built-in endpoint.
// Since we can't embed 1.3MB here, we provide a fetch-from-self approach.
// The app will prompt admin to upload CSV on first run.

// ─── MAIN APP ──────────────────────────────────────────────────────────────
export default function SupplierPhonebook() {
  const [screen, setScreen] = useState("login"); // login | main | detail | admin
  const [role, setRole] = useState(null); // user | admin
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");

  const [suppliers, setSuppliers] = useState([]);
  const [extras, setExtras] = useState({}); // { supplierId: { files, paymentDesc, website, notes } }
  const [recommendations, setRecommendations] = useState({}); // { supplierId: [{ author, text, date, rating }] }
  const [loading, setLoading] = useState(false);
  const [seeded, setSeeded] = useState(false);

  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("הכל");
  const [filterType, setFilterType] = useState("הכל");
  const [filterDomain, setFilterDomain] = useState("הכל");

  const [selectedSupplier, setSelectedSupplier] = useState(null);
  const [detailTab, setDetailTab] = useState("info"); // info | files | recommendations | payment
  
  // Recommendation form
  const [recAuthor, setRecAuthor] = useState("");
  const [recText, setRecText] = useState("");
  const [recRating, setRecRating] = useState(5);
  
  // Admin edit
  const [editMode, setEditMode] = useState(false);
  const [editData, setEditData] = useState({});
  
  // File upload
  const fileInputRef = useRef(null);
  const csvInputRef = useRef(null);

  // ─── LOAD DATA ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (screen !== "main" && screen !== "detail" && screen !== "admin") return;
    (async () => {
      setLoading(true);
      const data = await loadInitialData();
      if (data) {
        setSuppliers(data);
        setSeeded(true);
      }
      const ex = await loadExtras();
      setExtras(ex);
      const recs = await loadRecommendations();
      setRecommendations(recs);
      setLoading(false);
    })();
  }, [screen]);

  // ─── LOGIN ──────────────────────────────────────────────────────────────
  function handleLogin(asRole) {
    if (asRole === "user") {
      setRole("user");
      setScreen("main");
    } else {
      if (password === ADMIN_PASSWORD) {
        setRole("admin");
        setScreen("main");
        setLoginError("");
      } else {
        setLoginError("סיסמה שגויה");
      }
    }
  }

  // ─── CSV IMPORT ─────────────────────────────────────────────────────────
  async function handleCSVImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    setLoading(true);
    const text = await file.text();
    const lines = text.split("\n").filter(Boolean);
    const headers = lines[0].split(",").map(h => h.replace(/"/g, "").trim());
    
    const fieldMap = {
      "מספר": "id", "שם ספק": "name", "שם לועזי": "nameEn",
      "סטטוס": "status", "טלפון": "phone", "אימייל": "email",
      "עיר": "city", "תחום": "domain", "סוג": "type", "לטיפול": "handler"
    };
    
    const parsed = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      const obj = {};
      headers.forEach((h, idx) => {
        const key = fieldMap[h] || h;
        obj[key] = (cols[idx] || "").replace(/"/g, "").trim();
      });
      if (obj.id && obj.name) parsed.push(obj);
    }
    
    await saveSuppliers(parsed);
    setSuppliers(parsed);
    setSeeded(true);
    setLoading(false);
    alert(`✅ יובאו ${parsed.length} ספקים בהצלחה`);
  }

  function parseCsvLine(line) {
    const result = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQuotes = !inQuotes; }
      else if (line[i] === "," && !inQuotes) { result.push(current); current = ""; }
      else { current += line[i]; }
    }
    result.push(current);
    return result;
  }

  // ─── FILTER ─────────────────────────────────────────────────────────────
  const uniqueStatuses = ["הכל", ...new Set(suppliers.map(s => s.status).filter(Boolean))];
  const uniqueTypes = ["הכל", ...new Set(suppliers.map(s => s.type).filter(Boolean))].sort();
  const uniqueDomains = ["הכל", ...new Set(suppliers.map(s => s.domain).filter(Boolean))].sort();

  const filtered = suppliers.filter(s => {
    const q = search.toLowerCase();
    const matchSearch = !q || 
      (s.name || "").toLowerCase().includes(q) ||
      (s.phone || "").includes(q) ||
      (s.email || "").toLowerCase().includes(q) ||
      (s.city || "").includes(q) ||
      (s.id || "").includes(q);
    const matchStatus = filterStatus === "הכל" || s.status === filterStatus;
    const matchType = filterType === "הכל" || s.type === filterType;
    const matchDomain = filterDomain === "הכל" || s.domain === filterDomain;
    return matchSearch && matchStatus && matchType && matchDomain;
  });

  // ─── OPEN DETAIL ────────────────────────────────────────────────────────
  function openDetail(supplier) {
    setSelectedSupplier(supplier);
    setDetailTab("info");
    setEditMode(false);
    setEditData({ ...supplier, ...(extras[supplier.id] || {}) });
    setScreen("detail");
  }

  // ─── SAVE SUPPLIER EDIT ─────────────────────────────────────────────────
  async function saveSupplierEdit() {
    const { id, name, nameEn, status, phone, email, city, domain, type, handler,
            website, paymentDesc, notes } = editData;
    
    // Update supplier base data
    const updated = suppliers.map(s =>
      s.id === id ? { ...s, name, nameEn, status, phone, email, city, domain, type, handler } : s
    );
    await saveSuppliers(updated);
    setSuppliers(updated);
    
    // Update extras
    const newExtras = { ...extras, [id]: { ...extras[id], website, paymentDesc, notes } };
    await saveExtras(newExtras);
    setExtras(newExtras);
    
    setSelectedSupplier(updated.find(s => s.id === id));
    setEditMode(false);
  }

  // ─── ADD SUPPLIER ────────────────────────────────────────────────────────
  async function addSupplier() {
    const newId = "NEW_" + Date.now();
    const newS = { id: newId, name: "ספק חדש", nameEn: "", status: "חדש", phone: "", email: "", city: "", domain: "", type: "", handler: "" };
    const updated = [newS, ...suppliers];
    await saveSuppliers(updated);
    setSuppliers(updated);
    openDetail(newS);
    setEditMode(true);
  }

  // ─── DELETE SUPPLIER ─────────────────────────────────────────────────────
  async function deleteSupplier(id) {
    if (!confirm("האם למחוק ספק זה?")) return;
    const updated = suppliers.filter(s => s.id !== id);
    await saveSuppliers(updated);
    setSuppliers(updated);
    setScreen("main");
  }

  // ─── FILE UPLOAD ─────────────────────────────────────────────────────────
  async function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const base64 = ev.target.result;
      const sid = selectedSupplier.id;
      const newFiles = [...(extras[sid]?.files || []), {
        name: file.name,
        data: base64,
        size: file.size,
        date: new Date().toLocaleDateString("he-IL"),
        type: file.type
      }];
      const newExtras = { ...extras, [sid]: { ...extras[sid], files: newFiles } };
      await saveExtras(newExtras);
      setExtras(newExtras);
      setEditData(ed => ({ ...ed, files: newFiles }));
    };
    reader.readAsDataURL(file);
  }

  async function deleteFile(sid, idx) {
    const newFiles = (extras[sid]?.files || []).filter((_, i) => i !== idx);
    const newExtras = { ...extras, [sid]: { ...extras[sid], files: newFiles } };
    await saveExtras(newExtras);
    setExtras(newExtras);
  }

  // ─── RECOMMENDATIONS ─────────────────────────────────────────────────────
  async function submitRecommendation() {
    if (!recAuthor.trim() || !recText.trim()) return;
    const sid = selectedSupplier.id;
    const newRec = { author: recAuthor, text: recText, rating: recRating, date: new Date().toLocaleDateString("he-IL") };
    const newRecs = { ...recommendations, [sid]: [...(recommendations[sid] || []), newRec] };
    await saveRecommendations(newRecs);
    setRecommendations(newRecs);
    setRecAuthor(""); setRecText(""); setRecRating(5);
  }

  async function deleteRecommendation(sid, idx) {
    const newRecs = { ...recommendations, [sid]: recommendations[sid].filter((_, i) => i !== idx) };
    await saveRecommendations(newRecs);
    setRecommendations(newRecs);
  }

  // ─── RENDER ──────────────────────────────────────────────────────────────

  if (screen === "login") return <LoginScreen
    password={password} setPassword={setPassword}
    onLogin={handleLogin} error={loginError} />;

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#0f172a", flexDirection: "column", gap: 16 }}>
      <div style={{ width: 48, height: 48, border: "4px solid #334155", borderTop: "4px solid #6366f1", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <p style={{ color: "#94a3b8", fontFamily: "Heebo, sans-serif" }}>טוען נתונים...</p>
    </div>
  );

  if (screen === "detail" && selectedSupplier) {
    const sid = selectedSupplier.id;
    const ex = extras[sid] || {};
    const recs = recommendations[sid] || [];
    const sc = STATUS_COLORS[selectedSupplier.status] || STATUS_COLORS["לא פעיל"];
    const phone = formatPhone(selectedSupplier.phone);

    return (
      <div dir="rtl" style={{ minHeight: "100vh", background: "#0f172a", fontFamily: "Heebo, sans-serif", color: "#e2e8f0" }}>
        <style>{globalStyles}</style>
        
        {/* Header */}
        <div style={{ background: "linear-gradient(135deg, #1e293b, #0f172a)", borderBottom: "1px solid #1e293b", padding: "16px 20px", position: "sticky", top: 0, zIndex: 10, display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => setScreen("main")} style={btnIcon}>←</button>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{selectedSupplier.name}</h1>
              <span style={{ ...statusBadge, background: sc.bg, color: sc.text }}>
                {STATUS_ICONS[selectedSupplier.status]} {selectedSupplier.status}
              </span>
            </div>
            <p style={{ margin: 0, fontSize: 12, color: "#64748b" }}>מס׳ {selectedSupplier.id}</p>
          </div>
          {role === "admin" && !editMode && (
            <button onClick={() => setEditMode(true)} style={btnPrimary}>✏️ עריכה</button>
          )}
          {role === "admin" && editMode && (
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={saveSupplierEdit} style={{ ...btnPrimary, background: "#059669" }}>💾 שמור</button>
              <button onClick={() => setEditMode(false)} style={{ ...btnPrimary, background: "#475569" }}>ביטול</button>
            </div>
          )}
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid #1e293b", padding: "0 20px", gap: 4, overflowX: "auto" }}>
          {[
            { id: "info", label: "📋 פרטים" },
            { id: "payment", label: "💰 תשלום" },
            { id: "files", label: `📎 קבצים${ex.files?.length ? ` (${ex.files.length})` : ""}` },
            { id: "recommendations", label: `⭐ המלצות${recs.length ? ` (${recs.length})` : ""}` },
          ].map(tab => (
            <button key={tab.id} onClick={() => setDetailTab(tab.id)}
              style={{ ...tabBtn, ...(detailTab === tab.id ? tabBtnActive : {}) }}>
              {tab.label}
            </button>
          ))}
        </div>

        <div style={{ padding: 20, maxWidth: 700, margin: "0 auto" }}>

          {/* INFO TAB */}
          {detailTab === "info" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {editMode ? (
                <div style={{ display: "grid", gap: 12 }}>
                  {[
                    ["name", "שם ספק"], ["nameEn", "שם לועזי"], ["phone", "טלפון"], ["email", "אימייל"],
                    ["city", "עיר"], ["domain", "תחום"], ["type", "סוג"], ["handler", "לטיפול"]
                  ].map(([key, label]) => (
                    <div key={key}>
                      <label style={labelStyle}>{label}</label>
                      <input value={editData[key] || ""} onChange={e => setEditData(ed => ({ ...ed, [key]: e.target.value }))}
                        style={inputStyle} />
                    </div>
                  ))}
                  <div>
                    <label style={labelStyle}>סטטוס</label>
                    <select value={editData.status || ""} onChange={e => setEditData(ed => ({ ...ed, status: e.target.value }))} style={inputStyle}>
                      {["פעיל", "לא פעיל", "חדש", "חסום לתשלום"].map(s => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>אתר אינטרנט</label>
                    <input value={editData.website || ""} onChange={e => setEditData(ed => ({ ...ed, website: e.target.value }))}
                      placeholder="https://..." style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>הערות</label>
                    <textarea value={editData.notes || ""} onChange={e => setEditData(ed => ({ ...ed, notes: e.target.value }))}
                      style={{ ...inputStyle, height: 80, resize: "vertical" }} />
                  </div>
                </div>
              ) : (
                <>
                  {/* Contact Cards */}
                  <div style={{ display: "grid", gap: 12 }}>
                    {phone && (
                      <a href={`tel:${phone}`} style={contactCard}>
                        <span style={{ fontSize: 24 }}>📱</span>
                        <div>
                          <div style={{ fontSize: 13, color: "#64748b" }}>טלפון</div>
                          <div style={{ fontSize: 16, fontWeight: 600, direction: "ltr", textAlign: "right" }}>{phone}</div>
                        </div>
                      </a>
                    )}
                    {selectedSupplier.email && selectedSupplier.email !== "nan" && (
                      <a href={`mailto:${selectedSupplier.email}`} style={contactCard}>
                        <span style={{ fontSize: 24 }}>✉️</span>
                        <div>
                          <div style={{ fontSize: 13, color: "#64748b" }}>אימייל</div>
                          <div style={{ fontSize: 15 }}>{selectedSupplier.email}</div>
                        </div>
                      </a>
                    )}
                    {ex.website && (
                      <a href={ex.website} target="_blank" rel="noopener noreferrer" style={{ ...contactCard, background: "linear-gradient(135deg, #1e3a5f, #1e293b)" }}>
                        <span style={{ fontSize: 24 }}>🌐</span>
                        <div>
                          <div style={{ fontSize: 13, color: "#64748b" }}>אתר אינטרנט</div>
                          <div style={{ fontSize: 15, color: "#6366f1" }}>{ex.website}</div>
                        </div>
                      </a>
                    )}
                  </div>

                  {/* Info Grid */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    {[
                      ["🏙️", "עיר", selectedSupplier.city],
                      ["🏷️", "סוג", selectedSupplier.type],
                      ["🔧", "תחום", selectedSupplier.domain],
                      ["👤", "לטיפול", selectedSupplier.handler],
                    ].filter(([,, v]) => v).map(([icon, label, value]) => (
                      <div key={label} style={infoCard}>
                        <span style={{ fontSize: 18 }}>{icon}</span>
                        <div>
                          <div style={{ fontSize: 11, color: "#64748b" }}>{label}</div>
                          <div style={{ fontSize: 14, fontWeight: 500 }}>{value}</div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {ex.notes && (
                    <div style={{ background: "#1e293b", borderRadius: 12, padding: 16, border: "1px solid #334155" }}>
                      <div style={{ fontSize: 13, color: "#64748b", marginBottom: 8 }}>📝 הערות</div>
                      <div style={{ fontSize: 14, lineHeight: 1.6 }}>{ex.notes}</div>
                    </div>
                  )}

                  {role === "admin" && (
                    <button onClick={() => deleteSupplier(sid)} style={{ ...btnPrimary, background: "#dc2626", width: "100%", marginTop: 16 }}>
                      🗑️ מחק ספק
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {/* PAYMENT TAB */}
          {detailTab === "payment" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ background: "#1e293b", borderRadius: 12, padding: 16, border: "1px solid #334155" }}>
                <h3 style={{ margin: "0 0 12px", color: "#f59e0b" }}>💰 תיאור תשלום</h3>
                {editMode ? (
                  <textarea
                    value={editData.paymentDesc || ""}
                    onChange={e => setEditData(ed => ({ ...ed, paymentDesc: e.target.value }))}
                    placeholder="הזן תיאור תשלום, תנאי שיחה, מחירים..."
                    style={{ ...inputStyle, height: 150, resize: "vertical" }}
                  />
                ) : (
                  ex.paymentDesc
                    ? <div style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{ex.paymentDesc}</div>
                    : <div style={{ color: "#475569", fontStyle: "italic" }}>לא הוזן מידע תשלום</div>
                )}
              </div>
            </div>
          )}

          {/* FILES TAB */}
          {detailTab === "files" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {role === "admin" && (
                <div>
                  <input ref={fileInputRef} type="file" onChange={handleFileUpload} style={{ display: "none" }} />
                  <button onClick={() => fileInputRef.current?.click()} style={{ ...btnPrimary, width: "100%" }}>
                    📎 העלאת קובץ
                  </button>
                </div>
              )}
              {(ex.files || []).length === 0
                ? <div style={{ textAlign: "center", color: "#475569", padding: 32 }}>אין קבצים מצורפים</div>
                : (ex.files || []).map((file, idx) => (
                  <div key={idx} style={{ ...infoCard, justifyContent: "space-between" }}>
                    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                      <span style={{ fontSize: 24 }}>{getFileIcon(file.type)}</span>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 500 }}>{file.name}</div>
                        <div style={{ fontSize: 12, color: "#64748b" }}>{file.date} · {formatSize(file.size)}</div>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <a href={file.data} download={file.name} style={{ ...btnPrimary, fontSize: 12, padding: "6px 12px", textDecoration: "none" }}>⬇ הורד</a>
                      {role === "admin" && (
                        <button onClick={() => deleteFile(sid, idx)} style={{ ...btnPrimary, background: "#dc2626", fontSize: 12, padding: "6px 12px" }}>✗</button>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          )}

          {/* RECOMMENDATIONS TAB */}
          {detailTab === "recommendations" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {/* Add recommendation form */}
              <div style={{ background: "#1e293b", borderRadius: 12, padding: 16, border: "1px solid #334155" }}>
                <h3 style={{ margin: "0 0 12px", color: "#fbbf24" }}>✍️ הוסף המלצה</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <input value={recAuthor} onChange={e => setRecAuthor(e.target.value)}
                    placeholder="שמך" style={inputStyle} />
                  <textarea value={recText} onChange={e => setRecText(e.target.value)}
                    placeholder="כתוב המלצה..." style={{ ...inputStyle, height: 80, resize: "vertical" }} />
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 14 }}>דירוג:</span>
                    {[1,2,3,4,5].map(n => (
                      <button key={n} onClick={() => setRecRating(n)}
                        style={{ background: "none", border: "none", fontSize: 24, cursor: "pointer", opacity: n <= recRating ? 1 : 0.3 }}>⭐</button>
                    ))}
                  </div>
                  <button onClick={submitRecommendation} style={{ ...btnPrimary, background: "#d97706" }}>שלח המלצה</button>
                </div>
              </div>

              {/* List */}
              {recs.length === 0
                ? <div style={{ textAlign: "center", color: "#475569", padding: 32 }}>אין המלצות עדיין</div>
                : recs.map((rec, idx) => (
                  <div key={idx} style={{ background: "#1e293b", borderRadius: 12, padding: 16, border: "1px solid #334155" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                      <div>
                        <span style={{ fontWeight: 600 }}>{rec.author}</span>
                        <span style={{ marginRight: 8, fontSize: 14, color: "#64748b" }}>{rec.date}</span>
                      </div>
                      <div style={{ display: "flex", gap: 4 }}>
                        {[1,2,3,4,5].map(n => <span key={n} style={{ opacity: n <= rec.rating ? 1 : 0.2 }}>⭐</span>)}
                        {role === "admin" && (
                          <button onClick={() => deleteRecommendation(sid, idx)}
                            style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", marginRight: 8 }}>✗</button>
                        )}
                      </div>
                    </div>
                    <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6 }}>{rec.text}</p>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── MAIN LIST ───────────────────────────────────────────────────────────
  return (
    <div dir="rtl" style={{ minHeight: "100vh", background: "#0f172a", fontFamily: "Heebo, sans-serif", color: "#e2e8f0" }}>
      <style>{globalStyles}</style>

      {/* Header */}
      <div style={{ background: "linear-gradient(135deg, #1e1b4b, #0f172a)", borderBottom: "1px solid #1e293b", padding: "16px 20px", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, background: "linear-gradient(135deg, #818cf8, #c084fc)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              📒 ספר ספקים
            </h1>
            <p style={{ margin: 0, fontSize: 12, color: "#64748b" }}>
              {role === "admin" ? "👑 מנהל" : "👤 משתמש"} · {filtered.length.toLocaleString()} ספקים מתוך {suppliers.length.toLocaleString()}
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {role === "admin" && (
              <>
                <button onClick={addSupplier} style={{ ...btnPrimary, fontSize: 13 }}>+ הוסף</button>
                <div style={{ position: "relative" }}>
                  <input ref={csvInputRef} type="file" accept=".csv" onChange={handleCSVImport} style={{ display: "none" }} />
                  <button onClick={() => csvInputRef.current?.click()} style={{ ...btnPrimary, background: "#059669", fontSize: 13 }}>📥 CSV</button>
                </div>
              </>
            )}
            <button onClick={() => { setScreen("login"); setRole(null); }} style={{ ...btnPrimary, background: "#475569", fontSize: 13 }}>יציאה</button>
          </div>
        </div>

        {/* Search */}
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="🔍 חיפוש לפי שם, טלפון, עיר, אימייל..."
          style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 10, background: "#0f172a" }}
        />

        {/* Filters */}
        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={selectStyle}>
            {uniqueStatuses.map(s => <option key={s}>{s}</option>)}
          </select>
          <select value={filterType} onChange={e => setFilterType(e.target.value)} style={selectStyle}>
            {uniqueTypes.map(s => <option key={s}>{s}</option>)}
          </select>
          <select value={filterDomain} onChange={e => setFilterDomain(e.target.value)} style={selectStyle}>
            {uniqueDomains.map(s => <option key={s}>{s}</option>)}
          </select>
          {(filterStatus !== "הכל" || filterType !== "הכל" || filterDomain !== "הכל" || search) && (
            <button onClick={() => { setSearch(""); setFilterStatus("הכל"); setFilterType("הכל"); setFilterDomain("הכל"); }}
              style={{ ...btnPrimary, background: "#475569", whiteSpace: "nowrap", fontSize: 13 }}>
              ✕ נקה
            </button>
          )}
        </div>
      </div>

      {/* Empty state */}
      {!seeded && (
        <div style={{ textAlign: "center", padding: 60, color: "#475569" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📂</div>
          <p>אין נתונים. {role === "admin" ? "העלה קובץ CSV כדי להתחיל." : "פנה למנהל המערכת."}</p>
        </div>
      )}

      {/* List */}
      <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10, maxWidth: 900, margin: "0 auto" }}>
        {filtered.slice(0, 200).map(supplier => {
          const phone = formatPhone(supplier.phone);
          const sc = STATUS_COLORS[supplier.status] || STATUS_COLORS["לא פעיל"];
          const recs = recommendations[supplier.id] || [];
          const avgRating = recs.length ? Math.round(recs.reduce((a, r) => a + r.rating, 0) / recs.length) : 0;

          return (
            <div key={supplier.id} onClick={() => openDetail(supplier)}
              style={{ background: "#1e293b", borderRadius: 14, padding: "14px 16px", cursor: "pointer", border: "1px solid #1e293b", transition: "all 0.15s", display: "flex", gap: 14, alignItems: "center" }}
              onMouseEnter={e => e.currentTarget.style.borderColor = "#4f46e5"}
              onMouseLeave={e => e.currentTarget.style.borderColor = "#1e293b"}
            >
              {/* Avatar */}
              <div style={{ width: 44, height: 44, borderRadius: 12, background: `linear-gradient(135deg, ${sc.dot}33, ${sc.dot}11)`, border: `2px solid ${sc.dot}66`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>
                {(supplier.name || "?")[0]}
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 200 }}>{supplier.name}</span>
                  <span style={{ ...statusBadge, background: sc.bg, color: sc.text, fontSize: 11 }}>
                    {STATUS_ICONS[supplier.status]} {supplier.status}
                  </span>
                  {avgRating > 0 && <span style={{ fontSize: 12, color: "#fbbf24" }}>{"⭐".repeat(avgRating)} ({recs.length})</span>}
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {phone && <span style={{ fontSize: 13, color: "#94a3b8", direction: "ltr" }}>📞 {phone}</span>}
                  {supplier.city && <span style={{ fontSize: 13, color: "#94a3b8" }}>📍 {supplier.city}</span>}
                  {supplier.type && <span style={{ fontSize: 12, color: "#6366f1", background: "#1e1b4b", borderRadius: 6, padding: "2px 8px" }}>{supplier.type}</span>}
                  {supplier.domain && <span style={{ fontSize: 12, color: "#64748b" }}>{supplier.domain}</span>}
                </div>
              </div>

              <span style={{ color: "#334155", fontSize: 20 }}>›</span>
            </div>
          );
        })}

        {filtered.length > 200 && (
          <div style={{ textAlign: "center", padding: 16, color: "#64748b", fontSize: 14 }}>
            מוצגים 200 מתוך {filtered.length} תוצאות. צמצם את החיפוש לראות יותר.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── LOGIN SCREEN ────────────────────────────────────────────────────────────
function LoginScreen({ password, setPassword, onLogin, error }) {
  return (
    <div dir="rtl" style={{ minHeight: "100vh", background: "#0f172a", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Heebo, sans-serif" }}>
      <style>{globalStyles}</style>
      <div style={{ background: "#1e293b", borderRadius: 20, padding: 40, width: "90%", maxWidth: 420, border: "1px solid #334155", textAlign: "center" }}>
        <div style={{ fontSize: 56, marginBottom: 8 }}>📒</div>
        <h1 style={{ margin: "0 0 4px", background: "linear-gradient(135deg, #818cf8, #c084fc)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", fontSize: 26, fontWeight: 800 }}>ספר ספקים</h1>
        <p style={{ color: "#64748b", marginBottom: 32, fontSize: 14 }}>מערכת ניהול ספקים ודרכי התקשרות</p>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <button onClick={() => onLogin("user")} style={{ ...btnPrimary, width: "100%", padding: "14px 20px", fontSize: 16, background: "linear-gradient(135deg, #4f46e5, #7c3aed)" }}>
            👤 כניסה כמשתמש
          </button>

          <div style={{ borderTop: "1px solid #334155", margin: "8px 0" }} />

          <div style={{ textAlign: "right" }}>
            <label style={{ fontSize: 14, color: "#94a3b8", display: "block", marginBottom: 6 }}>סיסמת מנהל</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === "Enter" && onLogin("admin")}
              placeholder="הכנס סיסמה..."
              style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 10 }}
            />
            {error && <p style={{ color: "#ef4444", fontSize: 13, margin: "0 0 10px" }}>{error}</p>}
            <button onClick={() => onLogin("admin")} style={{ ...btnPrimary, width: "100%", padding: "14px 20px", fontSize: 16, background: "linear-gradient(135deg, #059669, #047857)" }}>
              👑 כניסה כמנהל
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function getFileIcon(type) {
  if (!type) return "📄";
  if (type.includes("pdf")) return "📕";
  if (type.includes("image")) return "🖼️";
  if (type.includes("word") || type.includes("document")) return "📝";
  if (type.includes("sheet") || type.includes("excel")) return "📊";
  if (type.includes("zip") || type.includes("compressed")) return "🗜️";
  return "📄";
}

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

// ─── STYLES ──────────────────────────────────────────────────────────────────
const globalStyles = `
  @import url('https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;600;700;800&display=swap');
  * { box-sizing: border-box; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: #0f172a; }
  ::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
  input, textarea, select { outline: none; }
  a { color: inherit; text-decoration: none; }
`;

const btnPrimary = {
  background: "linear-gradient(135deg, #4f46e5, #6366f1)",
  color: "#fff",
  border: "none",
  borderRadius: 10,
  padding: "8px 16px",
  cursor: "pointer",
  fontSize: 14,
  fontFamily: "Heebo, sans-serif",
  fontWeight: 600,
  whiteSpace: "nowrap",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

const btnIcon = {
  background: "#334155",
  color: "#e2e8f0",
  border: "none",
  borderRadius: 10,
  width: 38,
  height: 38,
  cursor: "pointer",
  fontSize: 18,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const statusBadge = {
  fontSize: 12,
  padding: "2px 10px",
  borderRadius: 999,
  fontWeight: 600,
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
};

const inputStyle = {
  background: "#1e293b",
  border: "1px solid #334155",
  borderRadius: 10,
  padding: "10px 14px",
  fontSize: 14,
  color: "#e2e8f0",
  fontFamily: "Heebo, sans-serif",
  width: "100%",
};

const selectStyle = {
  ...inputStyle,
  cursor: "pointer",
  flexShrink: 0,
};

const labelStyle = {
  display: "block",
  fontSize: 13,
  color: "#64748b",
  marginBottom: 6,
};

const contactCard = {
  display: "flex",
  gap: 14,
  alignItems: "center",
  background: "#1e293b",
  border: "1px solid #334155",
  borderRadius: 12,
  padding: "14px 16px",
  transition: "border-color 0.15s",
  cursor: "pointer",
};

const infoCard = {
  display: "flex",
  gap: 12,
  alignItems: "center",
  background: "#1e293b",
  border: "1px solid #334155",
  borderRadius: 12,
  padding: "12px 14px",
};

const tabBtn = {
  background: "none",
  border: "none",
  borderBottom: "2px solid transparent",
  color: "#64748b",
  padding: "12px 16px",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: "Heebo, sans-serif",
  fontWeight: 500,
  whiteSpace: "nowrap",
};

const tabBtnActive = {
  color: "#818cf8",
  borderBottomColor: "#818cf8",
};
