// ─── ADAPTIVE SAMPLING ENGINE ──────────────────────────────────────────────
// Automatically determines sample sizes based on file size.
// Uses separate budgets for Statistics, Correlation, and Charts.

const MB = 1024 * 1024;

// File size → per-task sample budget
const TIERS = [
  { maxSize: 1 * MB,   stats: Infinity, correlation: Infinity, charts: Infinity, label: "tiny"   },
  { maxSize: 10 * MB,  stats: 15000,    correlation: 8000,     charts: 2000,     label: "small"  },
  { maxSize: 50 * MB,  stats: 10000,    correlation: 5000,     charts: 1500,     label: "medium" },
  { maxSize: 200 * MB, stats: 8000,     correlation: 3000,     charts: 1000,     label: "large"  },
];

// Hard limit — reject files this large with a backend suggestion
export const MAX_FILE_SIZE = 200 * MB;

/**
 * Given a file size in bytes, returns the sampling config
 * @param {number} fileSize - file.size in bytes
 * @returns {{ stats: number, correlation: number, charts: number, label: string, useAllRows: boolean }}
 */
export function getSamplingConfig(fileSize) {
  for (const tier of TIERS) {
    if (fileSize <= tier.maxSize) {
      return {
        stats: tier.stats,
        correlation: tier.correlation,
        charts: tier.charts,
        label: tier.label,
        useAllRows: tier.stats === Infinity,
      };
    }
  }
  // Fallback for files near the 200MB limit
  return {
    stats: 5000,
    correlation: 2000,
    charts: 800,
    label: "xlarge",
    useAllRows: false,
  };
}

/**
 * Vitter's Algorithm R — proper reservoir sampling.
 * Called during streaming to decide whether to keep or replace a row.
 *
 * @param {Array} reservoir - current reservoir array
 * @param {Object} item - the incoming row
 * @param {number} itemIndex - 1-based index of the item in the stream (total seen so far)
 * @param {number} maxSize - reservoir capacity
 */
export function reservoirInsert(reservoir, item, itemIndex, maxSize) {
  if (reservoir.length < maxSize) {
    reservoir.push(item);
  } else {
    // Replace with probability maxSize/itemIndex
    const j = Math.floor(Math.random() * itemIndex);
    if (j < maxSize) {
      reservoir[j] = item;
    }
  }
}
