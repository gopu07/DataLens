import { useState, useCallback, useRef, useEffect } from 'react';
import { getSamplingConfig, MAX_FILE_SIZE } from '../utils/samplingConfig.js';

/**
 * useCSVParser — React hook for streaming CSV parsing via Web Worker.
 *
 * Returns:
 *   isProcessing: boolean
 *   progress: { stage: string, percent: number, detail: string } | null
 *   error: string | null
 *   parseFile: (file, onSuccess) => void
 */
export const useCSVParser = () => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const workerRef = useRef(null);

  // Cleanup on unmount — terminate any lingering worker
  useEffect(() => {
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, []);

  const parseFile = useCallback((file, onSuccess) => {
    // ── Guard: file size limit ──────────────────────────────
    if (file.size > MAX_FILE_SIZE) {
      setError(
        `File is ${(file.size / (1024 * 1024)).toFixed(0)}MB — too large for browser processing. ` +
        `Please use a backend (Python/Node) for datasets over ${(MAX_FILE_SIZE / (1024 * 1024)).toFixed(0)}MB.`
      );
      return;
    }

    // ── Terminate previous worker if any ────────────────────
    if (workerRef.current) {
      workerRef.current.terminate();
    }

    setIsProcessing(true);
    setProgress({ stage: 'initializing', percent: 0, detail: 'Preparing worker…' });
    setError(null);

    // ── Compute adaptive sampling config from file size ─────
    const sampling = getSamplingConfig(file.size);

    const worker = new Worker(
      new URL('../workers/csvWorker.js', import.meta.url),
      { type: 'module' }
    );
    workerRef.current = worker;

    worker.onmessage = (e) => {
      const { status } = e.data;

      if (status === 'progress') {
        setProgress({
          stage: e.data.stage,
          percent: e.data.percent,
          detail: e.data.detail,
        });
      } else if (status === 'complete') {
        setProgress({ stage: 'complete', percent: 100, detail: 'Rendering…' });
        onSuccess(e.data.result);
        setIsProcessing(false);
        setProgress(null);
        worker.terminate();
        workerRef.current = null;
      } else if (status === 'error') {
        setError(e.data.error);
        setIsProcessing(false);
        setProgress(null);
        worker.terminate();
        workerRef.current = null;
      }
    };

    worker.onerror = () => {
      setError('Worker initialization failed.');
      setIsProcessing(false);
      setProgress(null);
      worker.terminate();
      workerRef.current = null;
    };

    worker.postMessage({ file, sampling });
  }, []);

  return { isProcessing, progress, error, parseFile };
};
