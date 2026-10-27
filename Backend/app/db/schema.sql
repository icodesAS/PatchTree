-- ==============================================================================
-- PatchTree PostgreSQL Schema for Supabase
-- Tables: runs, nodes
-- ==============================================================================

-- 1. Runs Table
CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    repo_url TEXT NOT NULL,
    bug_description TEXT NOT NULL,
    target_test TEXT NOT NULL,
    full_suite_test TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    winner_node_id TEXT,
    confidence_score DOUBLE PRECISION,
    adversarial_runs INTEGER DEFAULT 0,
    adversarial_survived INTEGER DEFAULT 0,
    full_suite_result TEXT,
    confidence_report TEXT,
    total_cost_usd DOUBLE PRECISION DEFAULT 0.0,
    total_wall_time_seconds DOUBLE PRECISION DEFAULT 0.0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    completed_at TIMESTAMPTZ,
    client_id TEXT
);

-- 2. Nodes Table
CREATE TABLE IF NOT EXISTS nodes (
    node_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    parent_node_id TEXT,
    branch_type TEXT NOT NULL,
    checkpoint_id TEXT,
    hypothesis TEXT,
    patch_diff TEXT,
    test_command TEXT,
    test_result TEXT,
    test_output TEXT,
    model_used TEXT,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    estimated_cost_usd DOUBLE PRECISION DEFAULT 0.0,
    status TEXT NOT NULL DEFAULT 'pending',
    is_stable BOOLEAN,
    stability_runs INTEGER DEFAULT 0,
    stability_passes INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
);

-- Indexes for performant tree exploration and history queries
CREATE INDEX IF NOT EXISTS idx_nodes_run_id ON nodes(run_id);
CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_client_id ON runs(client_id);
CREATE INDEX IF NOT EXISTS idx_nodes_parent_id ON nodes(parent_node_id);
