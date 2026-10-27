from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel


class RunCreate(BaseModel):
    repo_url: str
    bug_description: str
    target_test: str
    full_suite_test: Optional[str] = None
    client_id: Optional[str] = None


class Run(RunCreate):
    run_id: str
    status: str = "pending"
    winner_node_id: Optional[str] = None
    confidence_score: Optional[float] = None
    adversarial_runs: int = 0
    adversarial_survived: int = 0
    full_suite_result: Optional[Literal["pass", "fail", "error", "skipped"]] = None
    confidence_report: Optional[str] = None
    total_cost_usd: float = 0.0
    total_wall_time_seconds: float = 0.0
    created_at: datetime
    completed_at: Optional[datetime] = None


class Node(BaseModel):
    node_id: str
    run_id: str
    parent_node_id: Optional[str] = None
    branch_type: Literal["root", "search", "stability", "adversarial", "full_suite"]
    checkpoint_id: Optional[str] = None
    hypothesis: Optional[str] = None
    patch_diff: Optional[str] = None
    test_command: Optional[str] = None
    test_result: Optional[Literal["pass", "fail", "error"]] = None
    test_output: Optional[str] = None
    model_used: Optional[str] = None
    tokens_in: int = 0
    tokens_out: int = 0
    estimated_cost_usd: float = 0.0
    status: str = "pending"
    is_stable: Optional[bool] = None
    stability_runs: int = 0
    stability_passes: int = 0
