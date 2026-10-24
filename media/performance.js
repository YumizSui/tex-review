/** Local diagnostics contain operation names and timings, never document text. */
export function performanceMonitor(report, clock = () => performance.now()) {
  let lastPhase = 'idle';
  const duration = (phase, milliseconds) => {
    if (milliseconds >= 50) report({ phase, milliseconds });
  };
  return {
    duration,
    measure(phase, operation) {
      if (!/^[a-z][a-z0-9.-]{0,63}$/i.test(phase)) return operation();
      const started = clock();
      try { return operation(); }
      finally { lastPhase = phase.toLowerCase(); duration(lastPhase, clock() - started); }
    },
    observe() {
      if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) if (entry.duration >= 150) report({ phase: 'ui.long-task', milliseconds: entry.duration, recentPhase: lastPhase });
      });
      observer.observe({ type: 'longtask' });
      return observer;
    },
  };
}
