export type ProgressEvent =
  | { type: 'goal_start'; session: string; goal: string }
  | { type: 'wp_start'; wpIndex: number; wpTotal: number; title: string; attempt: number; strategy: string }
  | { type: 'wp_progress'; wpIndex: number; wpTotal: number; detail: string }
  | { type: 'wp_completed'; wpIndex: number; wpTotal: number }
  | { type: 'wp_failed'; wpIndex: number; wpTotal: number; reason: string }
  | { type: 'hard_blocker'; wpIndex: number; wpTotal: number; detail: string }
  | { type: 'goal_end'; completed: number; total: number; attempts: number; cost: number };

function wp(wpIndex: number, wpTotal: number): string {
  return `[WP ${wpIndex}/${wpTotal}]`;
}

export function formatProgressEvent(event: ProgressEvent): string {
  switch (event.type) {
    case 'goal_start':
      return `── session: ${event.session} | goal: ${event.goal} ──`;

    case 'wp_start':
      return `${wp(event.wpIndex, event.wpTotal)} ${event.title} — attempt ${event.attempt} (${event.strategy})`;

    case 'wp_progress':
      return `${wp(event.wpIndex, event.wpTotal)} ✓ progress — ${event.detail}`;

    case 'wp_completed':
      return `${wp(event.wpIndex, event.wpTotal)} ✓ completed`;

    case 'wp_failed':
      return `${wp(event.wpIndex, event.wpTotal)} ✗ failed (${event.reason})`;

    case 'hard_blocker':
      return `${wp(event.wpIndex, event.wpTotal)} ⚠ hard blocker: ${event.detail}`;

    case 'goal_end':
      return `── result: ${event.completed}/${event.total} completed | ${event.attempts} attempts | $${event.cost.toFixed(4)} ──`;
  }
}
