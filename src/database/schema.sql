

BEGIN;

-- 1. TEAM
CREATE TABLE IF NOT EXISTS team (
    team_id BIGSERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. USER
CREATE TABLE IF NOT EXISTS app_user (
    user_id BIGSERIAL PRIMARY KEY,
    team_id BIGINT REFERENCES team(team_id) ON DELETE SET NULL,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'engineer',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. SERVICE
CREATE TABLE IF NOT EXISTS service (
    service_id BIGSERIAL PRIMARY KEY,
    team_id BIGINT REFERENCES team(team_id) ON DELETE RESTRICT,
    name VARCHAR(150) NOT NULL UNIQUE,
    description TEXT,
    criticality VARCHAR(20) NOT NULL DEFAULT 'medium'
        CHECK (criticality IN ('low', 'medium', 'high', 'critical')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 4. ENVIRONMENT
CREATE TABLE IF NOT EXISTS environment (
    environment_id BIGSERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 5. INCIDENT
CREATE TABLE IF NOT EXISTS incident (
    incident_id BIGSERIAL PRIMARY KEY,
    service_id BIGINT NOT NULL
        REFERENCES service(service_id) ON DELETE RESTRICT,
    environment_id BIGINT NOT NULL
        REFERENCES environment(environment_id) ON DELETE RESTRICT,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    severity VARCHAR(20) NOT NULL DEFAULT 'SEV3'
        CHECK (severity IN ('SEV1', 'SEV2', 'SEV3', 'SEV4', 'SEV5')),
    priority VARCHAR(20) NOT NULL DEFAULT 'P3'
        CHECK (priority IN ('P1', 'P2', 'P3', 'P4', 'P5')),
    status VARCHAR(30) NOT NULL DEFAULT 'open'
        CHECK (status IN (
            'open', 'acknowledged', 'investigating',
            'mitigated', 'resolved', 'closed'
        )),
    detected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    acknowledged_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    created_by BIGINT NOT NULL
        REFERENCES app_user(user_id) ON DELETE RESTRICT,
    resolved_by BIGINT
        REFERENCES app_user(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_incident_acknowledged_time
        CHECK (
            acknowledged_at IS NULL
            OR acknowledged_at >= detected_at
        ),

    CONSTRAINT chk_incident_resolved_time
        CHECK (
            resolved_at IS NULL
            OR resolved_at >= detected_at
        )
);

-- 6. ON-CALL SCHEDULE
CREATE TABLE IF NOT EXISTS on_call_schedule (
    schedule_id BIGSERIAL PRIMARY KEY,
    team_id BIGINT NOT NULL
        REFERENCES team(team_id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    rotation_type VARCHAR(50) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE,
    CONSTRAINT chk_schedule_dates
        CHECK (end_date IS NULL OR end_date >= start_date)
);

-- 7. ON-CALL ASSIGNMENT
CREATE TABLE IF NOT EXISTS on_call_assignment (
    assignment_id BIGSERIAL PRIMARY KEY,
    schedule_id BIGINT NOT NULL
        REFERENCES on_call_schedule(schedule_id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL
        REFERENCES app_user(user_id) ON DELETE RESTRICT,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    CONSTRAINT chk_on_call_time
        CHECK (end_time > start_time)
);

-- 8. INCIDENT ASSIGNMENT
CREATE TABLE IF NOT EXISTS incident_assignment (
    assignment_id BIGSERIAL PRIMARY KEY,
    incident_id BIGINT NOT NULL
        REFERENCES incident(incident_id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL
        REFERENCES app_user(user_id) ON DELETE RESTRICT,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    unassigned_at TIMESTAMPTZ,
    assignment_type VARCHAR(50) NOT NULL DEFAULT 'responder',
    CONSTRAINT chk_incident_assignment_time
        CHECK (
            unassigned_at IS NULL
            OR unassigned_at >= assigned_at
        )
);

-- 9. INCIDENT UPDATE
CREATE TABLE IF NOT EXISTS incident_update (
    update_id BIGSERIAL PRIMARY KEY,
    incident_id BIGINT NOT NULL
        REFERENCES incident(incident_id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL
        REFERENCES app_user(user_id) ON DELETE RESTRICT,
    status VARCHAR(30),
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 10. ESCALATION POLICY
CREATE TABLE IF NOT EXISTS escalation_policy (
    policy_id BIGSERIAL PRIMARY KEY,
    team_id BIGINT NOT NULL
        REFERENCES team(team_id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- 11. ESCALATION LEVEL
CREATE TABLE IF NOT EXISTS escalation_level (
    level_id BIGSERIAL PRIMARY KEY,
    policy_id BIGINT NOT NULL
        REFERENCES escalation_policy(policy_id) ON DELETE CASCADE,
    level_number INT NOT NULL CHECK (level_number >= 1),
    target_type VARCHAR(50) NOT NULL,
    target_id BIGINT NOT NULL,
    wait_minutes INT NOT NULL DEFAULT 5 CHECK (wait_minutes >= 0),
    CONSTRAINT uq_escalation_policy_level
        UNIQUE (policy_id, level_number)
);

-- 12. TAG
CREATE TABLE IF NOT EXISTS tag (
    tag_id BIGSERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT
);

-- 13. INCIDENT TAG
CREATE TABLE IF NOT EXISTS incident_tag (
    incident_id BIGINT NOT NULL
        REFERENCES incident(incident_id) ON DELETE CASCADE,
    tag_id BIGINT NOT NULL
        REFERENCES tag(tag_id) ON DELETE CASCADE,
    PRIMARY KEY (incident_id, tag_id)
);



CREATE INDEX IF NOT EXISTS idx_user_team
    ON app_user(team_id);

CREATE INDEX IF NOT EXISTS idx_service_team
    ON service(team_id);

CREATE INDEX IF NOT EXISTS idx_incident_service
    ON incident(service_id);

CREATE INDEX IF NOT EXISTS idx_incident_environment
    ON incident(environment_id);

CREATE INDEX IF NOT EXISTS idx_incident_created_by
    ON incident(created_by);

CREATE INDEX IF NOT EXISTS idx_incident_resolved_by
    ON incident(resolved_by);

CREATE INDEX IF NOT EXISTS idx_incident_status
    ON incident(status);

CREATE INDEX IF NOT EXISTS idx_incident_severity
    ON incident(severity);

CREATE INDEX IF NOT EXISTS idx_incident_priority
    ON incident(priority);

CREATE INDEX IF NOT EXISTS idx_incident_detected_at
    ON incident(detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_incident_status_severity
    ON incident(status, severity, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_on_call_schedule_team
    ON on_call_schedule(team_id);

CREATE INDEX IF NOT EXISTS idx_on_call_assignment_schedule
    ON on_call_assignment(schedule_id);

CREATE INDEX IF NOT EXISTS idx_on_call_assignment_user
    ON on_call_assignment(user_id);

CREATE INDEX IF NOT EXISTS idx_on_call_assignment_times
    ON on_call_assignment(start_time, end_time);

CREATE INDEX IF NOT EXISTS idx_incident_assignment_incident
    ON incident_assignment(incident_id);

CREATE INDEX IF NOT EXISTS idx_incident_assignment_user
    ON incident_assignment(user_id);

CREATE INDEX IF NOT EXISTS idx_incident_update_incident_time
    ON incident_update(incident_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_incident_update_user
    ON incident_update(user_id);

CREATE INDEX IF NOT EXISTS idx_escalation_policy_team
    ON escalation_policy(team_id);

CREATE INDEX IF NOT EXISTS idx_escalation_level_policy
    ON escalation_level(policy_id);

CREATE INDEX IF NOT EXISTS idx_incident_tag_tag
    ON incident_tag(tag_id);

COMMIT;