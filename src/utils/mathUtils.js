// ─── SHARED MATH UTILITIES ─────────────────────────────────────────────────
// Single source of truth for all computation functions.
// Imported by both the Web Worker and the main thread.

// ── Type Conversion ────────────────────────────────────────────────────────
export const toNum = (v) =>
  v !== null && v !== "" && v !== undefined && !isNaN(Number(v)) ? Number(v) : null;

// ── Type Detection ─────────────────────────────────────────────────────────
export function detectType(values) {
  const nonNull = values.filter((v) => v !== null && v !== undefined && v !== "");
  if (!nonNull.length) return "empty";
  // Sample up to 500 values for type detection (perf optimization)
  const sample = nonNull.length > 500 ? nonNull.slice(0, 500) : nonNull;
  const nums = sample.filter((v) => toNum(v) !== null);
  if (nums.length / sample.length > 0.85) return "numeric";
  const dates = sample.filter((v) => !isNaN(Date.parse(v)) && isNaN(Number(v)));
  if (dates.length / sample.length > 0.7) return "datetime";
  return "categorical";
}

// ── Statistics (Welford's Online Algorithm + sort for quartiles) ────────────
export function computeStats(values) {
  const nums = values.map(toNum).filter((v) => v !== null);
  if (!nums.length) return null;

  // Single pass for mean, variance (Welford's)
  let n = 0, mean = 0, m2 = 0, m3 = 0, m4 = 0;
  let minVal = Infinity, maxVal = -Infinity;
  for (let i = 0; i < nums.length; i++) {
    const x = nums[i];
    if (x < minVal) minVal = x;
    if (x > maxVal) maxVal = x;
    n++;
    const delta = x - mean;
    const deltaN = delta / n;
    const deltaN2 = deltaN * deltaN;
    const term1 = delta * deltaN * (n - 1);
    mean += deltaN;
    m4 += term1 * deltaN2 * (n * n - 3 * n + 3) + 6 * deltaN2 * m2 - 4 * deltaN * m3;
    m3 += term1 * deltaN * (n - 2) - 3 * deltaN * m2;
    m2 += term1;
  }

  const variance = n > 1 ? m2 / n : 0;
  const std = Math.sqrt(variance);

  // Sort for quartiles (unavoidable, but we only sort once)
  nums.sort((a, b) => a - b);
  const median = n % 2 === 0 ? (nums[n / 2 - 1] + nums[n / 2]) / 2 : nums[Math.floor(n / 2)];
  const q1 = nums[Math.floor(n * 0.25)];
  const q3 = nums[Math.floor(n * 0.75)];
  const iqr = q3 - q1;

  const skewness = std && n > 2 ? (m3 / n) / (std * std * std) : 0;
  const kurtosis = std && n > 3 ? (m4 / n) / (variance * variance) - 3 : 0;

  const lowerFence = q1 - 1.5 * iqr;
  const upperFence = q3 + 1.5 * iqr;
  const outlierVals = nums.filter((v) => v < lowerFence || v > upperFence);

  let shape = "approx. normal";
  if (Math.abs(skewness) > 1) shape = skewness > 0 ? "right-skewed" : "left-skewed";
  else if (Math.abs(skewness) > 0.5)
    shape = skewness > 0 ? "slightly right-skewed" : "slightly left-skewed";

  return {
    mean, median, std,
    min: minVal, max: maxVal,
    q1, q3, iqr,
    skewness, kurtosis,
    lowerFence, upperFence,
    outlierCount: outlierVals.length,
    outlierVals: outlierVals.slice(0, 200), // Cap stored outliers for memory
    count: n, shape,
  };
}

// ── Histogram (safe for large arrays — no spread operator) ─────────────────
export function computeHistogram(values, bins = 15) {
  const nums = values.map(toNum).filter((v) => v !== null);
  if (!nums.length) return [];

  // Manual min/max instead of Math.min(...nums) which stack-overflows on 100K+ elements
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] < min) min = nums[i];
    if (nums[i] > max) max = nums[i];
  }

  const step = (max - min) / bins || 1;
  const buckets = Array.from({ length: bins }, (_, i) => ({
    range: (min + i * step).toFixed(2),
    count: 0,
  }));
  for (let i = 0; i < nums.length; i++) {
    const idx = Math.min(Math.floor((nums[i] - min) / step), bins - 1);
    buckets[idx].count++;
  }
  return buckets;
}

// ── Pearson Correlation — O(n) Single-Pass (Welford's online) ──────────────
// No intermediate arrays created. Processes raw value arrays directly.
export function computeCorrelation(a, b) {
  let n = 0;
  let meanX = 0, meanY = 0;
  let m2x = 0, m2y = 0, cov = 0;

  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = toNum(a[i]);
    const y = toNum(b[i]);
    if (x === null || y === null) continue;

    n++;
    const dx = x - meanX;
    const dy = y - meanY;
    meanX += dx / n;
    meanY += dy / n;
    // Note: use updated meanX but old meanY for numerical stability (Welford's)
    cov += dx * (y - meanY);
    m2x += dx * (x - meanX);
    m2y += dy * (y - meanY);
  }

  if (n < 3) return 0;
  const den = Math.sqrt(m2x * m2y);
  return den ? +(cov / den).toFixed(4) : 0;
}

// ── Frequency Count ────────────────────────────────────────────────────────
export function freqCount(values) {
  const counts = {};
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== "" && v !== null && v !== undefined) counts[v] = (counts[v] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([name, value]) => ({ name, value }));
}

// ── Mutual Information Proxy ───────────────────────────────────────────────
export function mutualInfoProxy(targetVals, featureVals, targetType, featureType) {
  if (targetType === "numeric" && featureType === "numeric")
    return Math.abs(computeCorrelation(featureVals, targetVals));

  if (featureType === "numeric") {
    const groups = {};
    for (let i = 0; i < featureVals.length; i++) {
      const t = targetVals[i];
      const v = featureVals[i];
      if (t === "" || v === "") continue;
      const n = toNum(v);
      if (n === null) continue;
      if (!groups[t]) groups[t] = [];
      groups[t].push(n);
    }
    const allNums = Object.values(groups).flat();
    if (allNums.length < 3) return 0;
    const gm = allNums.reduce((s, v) => s + v, 0) / allNums.length;
    const ssBetween = Object.values(groups).reduce((s, g) => {
      const m = g.reduce((a, v) => a + v, 0) / g.length;
      return s + g.length * (m - gm) ** 2;
    }, 0);
    const ssTotal = allNums.reduce((s, v) => s + (v - gm) ** 2, 0);
    return ssTotal ? Math.sqrt(ssBetween / ssTotal) : 0;
  }

  if (targetType === "numeric")
    return mutualInfoProxy(featureVals, targetVals, "categorical", "numeric");

  // Categorical × Categorical — Cramér's V
  const n = targetVals.length;
  const table = {};
  const rowCounts = {};
  const colCounts = {};
  for (let i = 0; i < n; i++) {
    const t = targetVals[i];
    const f = featureVals[i];
    if (t === "" || f === "") continue;
    if (!table[t]) table[t] = {};
    table[t][f] = (table[t][f] || 0) + 1;
    rowCounts[t] = (rowCounts[t] || 0) + 1;
    colCounts[f] = (colCounts[f] || 0) + 1;
  }
  const rows = Object.keys(rowCounts).slice(0, 20);
  const cols = Object.keys(colCounts).slice(0, 20);
  let chi2 = 0;
  for (const rv of rows) {
    for (const cv of cols) {
      const obs = (table[rv] || {})[cv] || 0;
      const exp = (rowCounts[rv] * colCounts[cv]) / n;
      if (exp > 0) chi2 += (obs - exp) ** 2 / exp;
    }
  }
  const minDim = Math.min(rows.length, cols.length) - 1;
  return minDim > 0 ? Math.min(1, Math.sqrt(chi2 / (n * minDim))) : 0;
}

// ── Data Quality Score ─────────────────────────────────────────────────────
export function dataQualityScore(col) {
  let score = 100;
  score -= parseFloat(col.missingPct) * 1.5;
  if (col.stats) {
    score -= (col.stats.outlierCount / col.stats.count) * 100 * 2;
    if (Math.abs(col.stats.skewness) > 2) score -= 10;
  }
  if (col.type === "categorical") {
    if (col.unique > 50) score -= 15;
    if (col.unique === col.totalRows) score -= 30;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ── Duplicate Detection ────────────────────────────────────────────────────
export function detectDuplicates(rows) {
  const seen = new Map();
  const dupeIndices = [];
  for (let i = 0; i < rows.length; i++) {
    const k = JSON.stringify(rows[i]);
    if (seen.has(k)) dupeIndices.push(i);
    else seen.set(k, i);
  }
  return dupeIndices;
}

// ── Formatting ─────────────────────────────────────────────────────────────
export const fmt = (n, d = 2) =>
  n === undefined || n === null || isNaN(n) ? "—" : Number(n).toFixed(d);

// ── CSV Download ───────────────────────────────────────────────────────────
export function downloadCSV(rows, headers, filename) {
  const csv = [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => `"${r[h] ?? ""}"`).join(",")),
  ].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = filename;
  a.click();
}
