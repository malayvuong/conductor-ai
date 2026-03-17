export type TaskType = 'debug_fix' | 'scan_review' | 'implement_feature' | 'verify_only';
export type TaskStatus = 'created' | 'running' | 'completed' | 'failed';
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed';
export type StreamType = 'stdout' | 'stderr' | 'system';
export type HeartbeatStatus = 'alive' | 'idle' | 'suspected_stuck' | 'recovered';

export interface Task {
  id: string;
  raw_input: string;
  workspace_path: string;
  engine: string;
  task_type: TaskType | null;
  normalized_json: string | null;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: string;
  task_id: string;
  engine: string;
  command: string;
  args_json: string;
  prompt_final: string;
  status: RunStatus;
  pid: number | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
}

export interface RunLog {
  id: number;
  run_id: string;
  seq: number;
  timestamp: string;
  stream_type: StreamType;
  line: string;
}

export interface HeartbeatEvent {
  id: number;
  run_id: string;
  timestamp: string;
  status: HeartbeatStatus;
  summary: string;
  no_output_seconds: number;
}

export interface RunReport {
  id: string;
  run_id: string;
  summary: string;
  root_cause: string | null;
  fix_applied: string | null;
  files_changed_json: string | null;
  verification_notes: string | null;
  remaining_risks: string | null;
}
