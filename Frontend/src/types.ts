export type BranchType = 'root' | 'search' | 'stability' | 'adversarial' | 'full_suite';
export type TestResult = 'pass' | 'fail' | 'error' | 'timeout' | null;
export type RunStatus = 'running' | 'complete' | 'failed';

export interface PatchNode {
  node_id: string;
  run_id: string;
  parent_node_id: string | null;
  checkpoint_id?: string;
  branch_type: BranchType;
  hypothesis: string;
  patch_diff: string;
  test_command: string;
  test_result: TestResult;
  test_output: string;
  model_used: string;
  tokens_in?: number;
  tokens_out?: number;
  is_stable?: boolean;
  stability_passes?: number;
  stability_runs?: number;
  status: string;
  estimated_cost_usd?: number;
  wall_time_seconds?: number;
}

export interface Run {
  run_id: string;
  status: RunStatus;
  winner_node_id?: string | null;
  confidence_score?: number | null;
  adversarial_runs?: number;
  adversarial_survived?: number;
  full_suite_result?: 'pass' | 'fail' | 'error' | 'skipped' | null;
  total_cost_usd?: number;
  total_wall_time_seconds?: number;
  confidence_report?: string | null;
  repo_url?: string;
  bug_description?: string;
  target_test?: string;
  full_suite_test?: string;
  client_id?: string;
  created_at?: string;
  completed_at?: string;
}

export interface RunCreate {
  repo_url: string;
  bug_description: string;
  target_test: string;
  full_suite_test?: string;
  client_id?: string;
}
