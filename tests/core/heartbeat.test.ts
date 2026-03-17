import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HeartbeatMonitor } from '../../src/core/heartbeat/monitor.js';

describe('HeartbeatMonitor', () => {
  let events: { status: string; summary: string; noOutputSeconds: number }[];

  beforeEach(() => {
    events = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits alive heartbeat when output is recent', () => {
    const monitor = new HeartbeatMonitor({
      intervalMs: 1000,
      stuckThresholdSeconds: 30,
      onHeartbeat: (status, summary, noOutputSeconds) => {
        events.push({ status, summary, noOutputSeconds });
      },
    });

    monitor.start();
    monitor.recordOutput('some log line');

    vi.advanceTimersByTime(1000);
    expect(events.length).toBe(1);
    expect(events[0].status).toBe('alive');
    expect(events[0].noOutputSeconds).toBeLessThan(5);

    monitor.stop();
  });

  it('emits suspected_stuck only once on transition', () => {
    const monitor = new HeartbeatMonitor({
      intervalMs: 1000,
      stuckThresholdSeconds: 5,
      onHeartbeat: (status, summary, noOutputSeconds) => {
        events.push({ status, summary, noOutputSeconds });
      },
    });

    monitor.start();

    // Advance past stuck threshold — multiple ticks
    vi.advanceTimersByTime(10000); // 10 ticks at 1s each

    const stuckEvents = events.filter(e => e.status === 'suspected_stuck');
    // Should only have ONE stuck event (the transition), not repeated spam
    expect(stuckEvents.length).toBe(1);

    monitor.stop();
  });

  it('emits recovered when output resumes after stuck', () => {
    const monitor = new HeartbeatMonitor({
      intervalMs: 1000,
      stuckThresholdSeconds: 3,
      onHeartbeat: (status, summary, noOutputSeconds) => {
        events.push({ status, summary, noOutputSeconds });
      },
    });

    monitor.start();

    // Go stuck
    vi.advanceTimersByTime(4000);
    expect(events.some(e => e.status === 'suspected_stuck')).toBe(true);

    // Resume output
    monitor.recordOutput('new line');
    vi.advanceTimersByTime(1000);

    const recovered = events.filter(e => e.status === 'recovered');
    expect(recovered.length).toBe(1);
    expect(recovered[0].summary).toContain('Output resumed');

    monitor.stop();
  });

  it('emits idle on transition from alive to idle', () => {
    const monitor = new HeartbeatMonitor({
      intervalMs: 1000,
      stuckThresholdSeconds: 6,
      onHeartbeat: (status, summary, noOutputSeconds) => {
        events.push({ status, summary, noOutputSeconds });
      },
    });

    monitor.start();
    monitor.recordOutput('line');

    // First tick: alive
    vi.advanceTimersByTime(1000);
    expect(events[events.length - 1].status).toBe('alive');

    // Advance past idle threshold (half of stuck = 3s)
    vi.advanceTimersByTime(3000);
    const idleEvents = events.filter(e => e.status === 'idle');
    expect(idleEvents.length).toBe(1);

    monitor.stop();
  });
});
