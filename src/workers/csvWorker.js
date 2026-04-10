import Papa from 'papaparse';
import {
  toNum, detectType, computeStats, computeHistogram,
  computeCorrelation, freqCount, dataQualityScore, detectDuplicates,
} from '../utils/mathUtils.js';
import { reservoirInsert } from '../utils/samplingConfig.js';

// ─── PROGRESS HELPER ──────────────────────────────────────────────────────
function postProgress(stage, percent, detail = '') {
  self.postMessage({ status: 'progress', stage, percent, detail });
}

// ─── WORKER ENTRY POINT ───────────────────────────────────────────────────
self.onmessage = (e) => {
  const {
    file,
    sampling = { stats: 5000, correlation: 3000, charts: 1000, useAllRows: false },
  } = e.data;

  const ext = file.name.split('.').pop().toLowerCase();
  if (ext !== 'csv') {
    self.postMessage({ status: 'error', error: 'Only CSV files are supported.' });
    return;
  }

  // ── Three independent reservoirs ──────────────────────────────
  const statsSample = [];    // Largest — for accurate stats
  const corrSample = [];     // Medium — for correlation matrix
  const chartSample = [];    // Small — for fast chart rendering

  const statsMax = sampling.useAllRows ? Infinity : sampling.stats;
  const corrMax = sampling.useAllRows ? Infinity : sampling.correlation;
  const chartMax = sampling.useAllRows ? Infinity : sampling.charts;

  let totalRows = 0;
  let headers = [];
  let lastProgressTime = 0;

  // ── STAGE 1: Streaming Parse + Reservoir Sampling ─────────────
  postProgress('parsing', 0, 'Starting CSV stream…');

  Papa.parse(file, {
    header: true,
    dynamicTyping: false,
    skipEmptyLines: true,
    chunk: (results) => {
      const chunkData = results.data;
      if (headers.length === 0 && results.meta.fields) {
        headers = results.meta.fields;
      }

      for (let i = 0; i < chunkData.length; i++) {
        totalRows++;

        // Convert values to strings to match downstream logic
        const row = {};
        for (const key of headers) {
          row[key] = String(chunkData[i][key] ?? '');
        }

        // Feed into all three reservoirs simultaneously (single pass)
        reservoirInsert(statsSample, row, totalRows, statsMax);
        reservoirInsert(corrSample, row, totalRows, corrMax);
        reservoirInsert(chartSample, row, totalRows, chartMax);
      }

      // Throttle progress updates to every 200ms
      const now = Date.now();
      if (now - lastProgressTime > 200) {
        lastProgressTime = now;
        postProgress('parsing', -1, `${totalRows.toLocaleString()} rows streamed…`);
      }
    },

    complete: () => {
      try {
        // ── STAGE 2: Compute Column Stats (using statsSample) ───────
        postProgress('computing_stats', 0, `Analyzing ${statsSample.length.toLocaleString()} rows…`);

        const columns = {};
        const totalHeaders = headers.length;
        headers.forEach((h, hIdx) => {
          const vals = statsSample.map((r) => r[h] ?? '');
          const type = detectType(vals);
          const missing = vals.filter((v) => v === '' || v === null || v === undefined).length;
          const unique = new Set(vals.filter((v) => v !== '')).size;
          const nonEmpty = vals.filter((v) => v !== '');
          const numericInNonEmpty = nonEmpty.filter((v) => toNum(v) !== null).length;
          const storedAsString =
            type === 'categorical' &&
            numericInNonEmpty / Math.max(1, nonEmpty.length) > 0.85;

          const col = {
            type,
            values: vals,
            missing,
            missingPct: ((missing / vals.length) * 100).toFixed(1),
            unique,
            totalRows: statsSample.length,
            storedAsString,
            stats: type === 'numeric' ? computeStats(vals) : null,
            histogram: type === 'numeric' ? computeHistogram(vals) : null,
            freq: type === 'categorical' ? freqCount(vals) : null,
          };
          col.qualityScore = dataQualityScore(col);
          columns[h] = col;

          // Progress per column
          if (hIdx % 3 === 0) {
            postProgress(
              'computing_stats',
              Math.round(((hIdx + 1) / totalHeaders) * 100),
              `Column ${hIdx + 1}/${totalHeaders}: ${h}`
            );
          }
        });

        // ── STAGE 3: Correlation Matrix (using corrSample) ──────────
        const numericCols = headers.filter((h) => columns[h].type === 'numeric');
        postProgress('computing_correlations', 0, `${numericCols.length} numeric columns…`);

        // Build correlation-specific value arrays from corrSample
        const corrValues = {};
        numericCols.forEach((h) => {
          corrValues[h] = corrSample.map((r) => r[h] ?? '');
        });

        const n = numericCols.length;
        const totalPairs = n * n; // declared before the loop so both progress refs below resolve
        // Pre-allocate the full matrix — rows are filled top-to-bottom so
        // corrMatrix[bi] always exists by the time we reference it (bi < ai).
        const corrMatrix = Array.from({ length: n }, () => new Array(n).fill(0));
        let pairsDone = 0;
        for (let ai = 0; ai < n; ai++) {
          for (let bi = 0; bi < n; bi++) {
            pairsDone++;
            if (ai === bi) {
              corrMatrix[ai][bi] = 1;
            } else if (bi < ai) {
              // Symmetric — reuse already-computed mirror value (row bi is fully done)
              corrMatrix[ai][bi] = corrMatrix[bi][ai];
            } else {
              corrMatrix[ai][bi] = computeCorrelation(
                corrValues[numericCols[ai]],
                corrValues[numericCols[bi]]
              );
            }
            if (totalPairs > 0 && pairsDone % 20 === 0) {
              postProgress(
                'computing_correlations',
                Math.round((pairsDone / totalPairs) * 100),
                `Pair ${pairsDone} / ${totalPairs}`
              );
            }
          }
        }

        // ── STAGE 4: Duplicates & Finalize ──────────────────────────
        postProgress('finalizing', 80, 'Detecting duplicates…');
        const dupeRows = detectDuplicates(chartSample);

        // Build chart-specific value arrays
        const chartColumns = {};
        headers.forEach((h) => {
          chartColumns[h] = {
            ...columns[h],
            values: chartSample.map((r) => r[h] ?? ''),
          };
        });

        postProgress('finalizing', 100, 'Done!');

        self.postMessage({
          status: 'complete',
          result: {
            headers,
            rows: chartSample,     // UI gets the small chart sample for rendering
            columns,               // Stats computed on the large stats sample
            chartColumns,          // Chart-specific values from chart sample
            numericCols,
            corrMatrix,
            dupeRows,
            meta: {
              totalRows,
              statsSampleSize: statsSample.length,
              corrSampleSize: corrSample.length,
              chartSampleSize: chartSample.length,
              isSampled: totalRows > chartSample.length,
            },
          },
        });
      } catch (err) {
        self.postMessage({ status: 'error', error: err.message });
      }
    },

    error: (err) => {
      self.postMessage({ status: 'error', error: err.message });
    },
  });
};
