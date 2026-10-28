BEGIN;

CREATE TABLE incident_escalation_execution (
    execution_id BIGSERIAL PRIMARY KEY,
    incident_id BIGINT NOT NULL
        REFERENCES incident(incident_id) ON DELETE CASCADE,
    policy_id BIGINT NOT NULL
        REFERENCES escalation_policy(policy_id) ON DELETE CASCADE,
    level_id BIGINT NOT NULL
        REFERENCES escalation_level(level_id) ON DELETE CASCADE,
    assignment_id BIGINT
        REFERENCES incident_assignment(assignment_id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL
        CHECK (status IN ('failed', 'applied')),
    outcome VARCHAR(50),
    attempt_count INT NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
    last_error TEXT,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    notification_status VARCHAR(20) NOT NULL DEFAULT 'not_required'
        CHECK (notification_status IN ('not_required', 'pending', 'logged', 'failed')),
    notification_attempts INT NOT NULL DEFAULT 0 CHECK (notification_attempts >= 0),
    notification_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_incident_escalation_execution
        UNIQUE (incident_id, policy_id, level_id),
    CONSTRAINT chk_incident_escalation_completion
        CHECK (
            (status = 'applied' AND completed_at IS NOT NULL)
            OR (status = 'failed' AND completed_at IS NULL)
        )
);

CREATE INDEX idx_incident_escalation_execution_incident
    ON incident_escalation_execution(incident_id, policy_id);

CREATE INDEX idx_incident_escalation_notification
    ON incident_escalation_execution(notification_status, execution_id)
    WHERE notification_status IN ('pending', 'failed');

COMMIT;
