import type { Metric } from 'web-vitals';

export const metricNames = ['TTFB', 'FCP', 'LCP', 'CLS', 'INP'] as const;
export type MetricName = typeof metricNames[number];
export interface Vital {
  value: number;
  rating: Metric['rating'];
  entries: { type: string; startTime: number; duration: number; event?: string; interactionId?: number }[];
}
export interface Snapshot {
  capturedAtMs: number;
  vitals: Record<MetricName, Vital | null>;
  longTasks: { startTime: number; duration: number }[];
  supportedEntryTypes: string[];
}
declare global {
  interface Window { __falkyPerformance: { snapshot(): Snapshot } }
}

/** Serialized into the profiling browser before navigation, never imported by the app. */
export function installMetrics(library: typeof import('web-vitals')) {
  const vitals: Snapshot['vitals'] = { TTFB: null, FCP: null, LCP: null, CLS: null, INP: null };
  const longTasks: Snapshot['longTasks'] = [];
  const supportedEntryTypes = [...PerformanceObserver.supportedEntryTypes];
  const report = (metric: Metric) => {
    if (!(metric.name in vitals)) return;
    vitals[metric.name as MetricName] = {
      value: metric.value, rating: metric.rating,
      entries: metric.entries.map((entry) => ({
        type: entry.entryType, startTime: entry.startTime, duration: entry.duration,
        ...('interactionId' in entry ? { event: entry.name, interactionId: Number(entry.interactionId) } : {}),
      })),
    };
  };
  library.onTTFB(report, { reportAllChanges: true });
  library.onFCP(report, { reportAllChanges: true });
  library.onLCP(report, { reportAllChanges: true });
  library.onCLS(report, { reportAllChanges: true });
  library.onINP(report, { reportAllChanges: true, durationThreshold: 16 });
  const recordTasks = (entries: PerformanceEntry[]) => {
    for (const entry of entries) longTasks.push({ startTime: entry.startTime, duration: entry.duration });
  };
  const observer = supportedEntryTypes.includes('longtask')
    ? new PerformanceObserver((list) => recordTasks(list.getEntries())) : null;
  observer?.observe({ type: 'longtask', buffered: true });
  window.__falkyPerformance = { snapshot: () => {
    if (observer) recordTasks(observer.takeRecords());
    return { capturedAtMs: performance.now(), vitals, longTasks, supportedEntryTypes };
  } };
}

export function summarize(samples: Snapshot[]) {
  return Object.fromEntries(metricNames.map((name) => {
    const values = samples.flatMap((sample) => sample.vitals[name] ? [sample.vitals[name]!.value] : []).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const median = values.length ? (values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2) : null;
    return [name, { unit: name === 'CLS' ? 'score' : 'ms', median,
      min: values[0] ?? null, max: values.at(-1) ?? null,
      measuredRuns: values.length, unavailableRuns: samples.length - values.length }];
  })) as Record<MetricName, { unit: string; median: number | null; min: number | null; max: number | null; measuredRuns: number; unavailableRuns: number }>;
}
