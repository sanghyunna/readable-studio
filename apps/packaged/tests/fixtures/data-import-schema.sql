CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      skill_id TEXT,
      design_system_id TEXT,
      pending_prompt TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    , custom_instructions TEXT, applied_plugin_snapshot_id TEXT);
CREATE TABLE templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      source_project_id TEXT,
      files_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT,
      session_mode TEXT NOT NULL DEFAULT 'design',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, applied_plugin_snapshot_id TEXT,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
CREATE TABLE agent_sessions (
      conversation_id TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      stable_prompt_hash TEXT,
      updated_at      INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, agent_id),
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
CREATE TABLE "message_snapshots" (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      agent_id TEXT,
      agent_name TEXT,
      events_json TEXT,
      attachments_json TEXT,
      produced_files_json TEXT,
      feedback_json TEXT,
      pre_turn_file_names_json TEXT,
      session_mode TEXT,
      run_context_json TEXT,
      applied_plugin_snapshot_json TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      position INTEGER NOT NULL,
      created_at INTEGER NOT NULL, run_id TEXT, run_status TEXT, last_run_event_id TEXT, comment_attachments_json TEXT,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
CREATE TABLE preview_comments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      element_id TEXT NOT NULL,
      selector TEXT NOT NULL,
      label TEXT NOT NULL,
      text TEXT NOT NULL,
      position_json TEXT NOT NULL,
      html_hint TEXT NOT NULL,
      selection_kind TEXT,
      member_count INTEGER,
      pod_members_json TEXT,
      style_json TEXT,
      attachments_json TEXT,
      slide_index INTEGER,
      slide_key INTEGER NOT NULL DEFAULT -1,
      note TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(project_id, conversation_id, file_path, element_id, slide_key),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
CREATE TABLE tabs (
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(project_id, name),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
CREATE TABLE tabs_state (
      project_id TEXT PRIMARY KEY,
      updated_at INTEGER NOT NULL,
      state_json TEXT,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
CREATE TABLE deployments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      url TEXT NOT NULL,
      deployment_id TEXT,
      deployment_count INTEGER NOT NULL DEFAULT 1,
      target TEXT NOT NULL DEFAULT 'preview',
      status TEXT NOT NULL DEFAULT 'ready',
      status_message TEXT,
      reachable_at INTEGER,
      provider_metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(project_id, file_name, provider_id),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
CREATE TABLE routines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_kind TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      schedule_json TEXT,
      project_mode TEXT NOT NULL,
      project_id TEXT,
      skill_id TEXT,
      agent_id TEXT,
      context_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
CREATE TABLE routine_runs (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      agent_run_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      summary TEXT,
      error TEXT,
      error_code TEXT,
      FOREIGN KEY(routine_id) REFERENCES routines(id) ON DELETE CASCADE
    );
CREATE TABLE routine_schedule_claims (
      routine_id TEXT NOT NULL,
      slot_at INTEGER NOT NULL,
      claimed_at INTEGER NOT NULL,
      PRIMARY KEY(routine_id, slot_at),
      FOREIGN KEY(routine_id) REFERENCES routines(id) ON DELETE CASCADE
    );
CREATE TABLE project_checkpoints (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      conversation_id TEXT,
      message_id TEXT,
      run_id TEXT,
      kind TEXT NOT NULL,
      root_path_hash TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      manifest_path TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      metadata_json TEXT,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
    );
CREATE TABLE project_checkpoint_restores (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      conversation_id TEXT,
      target_message_id TEXT,
      target_checkpoint_id TEXT,
      safety_checkpoint_id TEXT,
      mode TEXT NOT NULL,
      conflict_policy TEXT NOT NULL,
      file_changes_json TEXT NOT NULL,
      deleted_message_ids_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      metadata_json TEXT,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
CREATE TABLE critique_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      conversation_id TEXT,
      artifact_path TEXT,
      status TEXT NOT NULL CHECK (status IN
        ('shipped','below_threshold','timed_out','interrupted','degraded','failed','legacy','running')),
      score REAL,
      rounds_json TEXT NOT NULL DEFAULT '[]',
      transcript_path TEXT,
      protocol_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
    );
CREATE TABLE installed_plugins (
      id                   TEXT PRIMARY KEY,
      title                TEXT NOT NULL,
      version              TEXT NOT NULL,
      source_kind          TEXT NOT NULL,
      source               TEXT NOT NULL,
      pinned_ref           TEXT,
      source_digest        TEXT,
      source_marketplace_id TEXT,
      source_marketplace_entry_name TEXT,
      source_marketplace_entry_version TEXT,
      marketplace_trust    TEXT,
      resolved_source      TEXT,
      resolved_ref         TEXT,
      manifest_digest      TEXT,
      archive_integrity    TEXT,
      trust                TEXT NOT NULL,
      capabilities_granted TEXT NOT NULL,
      manifest_json        TEXT NOT NULL,
      fs_path              TEXT NOT NULL,
      installed_at         INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL
    );
CREATE TABLE plugin_marketplaces (
      id            TEXT PRIMARY KEY,
      url           TEXT NOT NULL,
      spec_version  TEXT NOT NULL DEFAULT '1.0.0',
      version       TEXT NOT NULL DEFAULT '0.0.0',
      trust         TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      added_at      INTEGER NOT NULL,
      refreshed_at  INTEGER NOT NULL
    );
CREATE TABLE applied_plugin_snapshots (
      id                       TEXT PRIMARY KEY,
      project_id               TEXT NOT NULL,
      conversation_id          TEXT,
      run_id                   TEXT,
      plugin_id                TEXT NOT NULL,
      plugin_spec_version      TEXT NOT NULL DEFAULT '1.0.0',
      plugin_version           TEXT NOT NULL,
      manifest_source_digest   TEXT NOT NULL,
      source_marketplace_id    TEXT,
      source_marketplace_entry_name TEXT,
      source_marketplace_entry_version TEXT,
      marketplace_trust        TEXT,
      resolved_source          TEXT,
      resolved_ref             TEXT,
      archive_integrity        TEXT,
      pinned_ref               TEXT,
      task_kind                TEXT NOT NULL,
      inputs_json              TEXT NOT NULL,
      resolved_context_json    TEXT NOT NULL,
      craft_requires_json      TEXT NOT NULL DEFAULT '[]',
      pipeline_json            TEXT,
      genui_surfaces_json      TEXT NOT NULL DEFAULT '[]',
      capabilities_granted     TEXT NOT NULL,
      capabilities_required    TEXT NOT NULL DEFAULT '[]',
      assets_staged_json       TEXT NOT NULL,
      mcp_servers_json         TEXT NOT NULL DEFAULT '[]',
      plugin_title             TEXT,
      plugin_description       TEXT,
      query_text               TEXT,
      status                   TEXT NOT NULL DEFAULT 'fresh',
      applied_at               INTEGER NOT NULL,
      expires_at               INTEGER,
      FOREIGN KEY (project_id)      REFERENCES projects(id)      ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
    );
CREATE TABLE run_devloop_iterations (
      id                    TEXT PRIMARY KEY,
      run_id                TEXT NOT NULL,
      stage_id              TEXT NOT NULL,
      iteration             INTEGER NOT NULL,
      artifact_diff_summary TEXT,
      critique_summary      TEXT,
      tokens_used           INTEGER,
      ended_at              INTEGER NOT NULL
    );
CREATE TABLE genui_surfaces (
      id                    TEXT PRIMARY KEY,
      project_id            TEXT NOT NULL,
      conversation_id       TEXT,
      run_id                TEXT,
      plugin_snapshot_id    TEXT NOT NULL,
      surface_id            TEXT NOT NULL,
      kind                  TEXT NOT NULL,
      persist               TEXT NOT NULL,
      schema_digest         TEXT,
      value_json            TEXT,
      status                TEXT NOT NULL,
      responded_by          TEXT,
      requested_at          INTEGER NOT NULL,
      responded_at          INTEGER,
      expires_at            INTEGER,
      FOREIGN KEY (project_id)         REFERENCES projects(id)                  ON DELETE CASCADE,
      FOREIGN KEY (plugin_snapshot_id) REFERENCES applied_plugin_snapshots(id)  ON DELETE SET NULL
    );
CREATE TABLE message_event_deltas (
        sequence INTEGER PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES message_snapshots(id) ON DELETE CASCADE,
        event_json TEXT NOT NULL
      );
CREATE INDEX idx_conv_project
      ON conversations(project_id, updated_at DESC);
CREATE INDEX idx_messages_conv
      ON "message_snapshots"(conversation_id, position);
CREATE INDEX idx_preview_comments_conversation
      ON preview_comments(project_id, conversation_id, updated_at DESC);
CREATE INDEX idx_preview_comments_conversation_created
      ON preview_comments(project_id, conversation_id, created_at ASC);
CREATE INDEX idx_tabs_project
      ON tabs(project_id, position);
CREATE INDEX idx_deployments_project
      ON deployments(project_id, updated_at DESC);
CREATE INDEX idx_routine_runs_routine
      ON routine_runs(routine_id, started_at DESC);
CREATE INDEX idx_project_checkpoints_project_time
      ON project_checkpoints(project_id, created_at DESC);
CREATE INDEX idx_project_checkpoints_message_kind
      ON project_checkpoints(project_id, conversation_id, message_id, kind);
CREATE INDEX idx_critique_runs_project
      ON critique_runs(project_id, updated_at DESC);
CREATE INDEX idx_critique_runs_status
      ON critique_runs(status);
CREATE INDEX idx_installed_plugins_source_kind
      ON installed_plugins(source_kind);
CREATE INDEX idx_snapshots_project ON applied_plugin_snapshots(project_id);
CREATE INDEX idx_snapshots_run     ON applied_plugin_snapshots(run_id);
CREATE INDEX idx_snapshots_plugin  ON applied_plugin_snapshots(plugin_id, plugin_version);
CREATE INDEX idx_devloop_run        ON run_devloop_iterations(run_id);
CREATE INDEX idx_devloop_run_stage  ON run_devloop_iterations(run_id, stage_id);
CREATE INDEX idx_genui_proj_surface ON genui_surfaces(project_id, surface_id);
CREATE INDEX idx_genui_conv_surface ON genui_surfaces(conversation_id, surface_id);
CREATE INDEX idx_genui_run          ON genui_surfaces(run_id);
CREATE INDEX idx_marketplaces_version ON plugin_marketplaces(version);
CREATE INDEX idx_message_event_deltas ON message_event_deltas(message_id, sequence);
CREATE VIEW messages AS SELECT s.id, s.conversation_id, s.role, s.content || COALESCE((SELECT group_concat(text, '') FROM
        (SELECT CASE WHEN json_extract(event_json, '$.kind') = 'text'
          THEN json_extract(event_json, '$.text') ELSE '' END AS text
         FROM message_event_deltas WHERE message_id = s.id ORDER BY sequence)), '') AS content, s.agent_id, s.agent_name, CASE WHEN EXISTS
        (SELECT 1 FROM message_event_deltas WHERE message_id = s.id)
        THEN (SELECT json_group_array(json(event)) FROM (
          SELECT value AS event FROM json_each(CASE WHEN json_valid(s.events_json)
            AND json_type(s.events_json) = 'array' THEN s.events_json ELSE '[]' END)
          UNION ALL SELECT event_json FROM (SELECT event_json FROM message_event_deltas
            WHERE message_id = s.id ORDER BY sequence)))
        ELSE s.events_json END AS events_json, s.attachments_json, s.produced_files_json, s.feedback_json, s.pre_turn_file_names_json, s.session_mode, s.run_context_json, s.applied_plugin_snapshot_json, s.started_at, s.ended_at, s.position, s.created_at, s.run_id, s.run_status, s.last_run_event_id, s.comment_attachments_json FROM message_snapshots s;
CREATE TRIGGER messages_insert INSTEAD OF INSERT ON messages BEGIN
        INSERT INTO message_snapshots (id,conversation_id,role,content,agent_id,agent_name,events_json,attachments_json,produced_files_json,feedback_json,pre_turn_file_names_json,session_mode,run_context_json,applied_plugin_snapshot_json,started_at,ended_at,position,created_at,run_id,run_status,last_run_event_id,comment_attachments_json)
        VALUES (NEW.id,NEW.conversation_id,NEW.role,NEW.content,NEW.agent_id,NEW.agent_name,NEW.events_json,NEW.attachments_json,NEW.produced_files_json,NEW.feedback_json,NEW.pre_turn_file_names_json,NEW.session_mode,NEW.run_context_json,NEW.applied_plugin_snapshot_json,NEW.started_at,NEW.ended_at,NEW.position,NEW.created_at,NEW.run_id,NEW.run_status,NEW.last_run_event_id,NEW.comment_attachments_json);
      END;
CREATE TRIGGER messages_update INSTEAD OF UPDATE ON messages BEGIN
        UPDATE message_snapshots SET id = NEW.id,conversation_id = NEW.conversation_id,role = NEW.role,content = NEW.content,agent_id = NEW.agent_id,agent_name = NEW.agent_name,events_json = NEW.events_json,attachments_json = NEW.attachments_json,produced_files_json = NEW.produced_files_json,feedback_json = NEW.feedback_json,pre_turn_file_names_json = NEW.pre_turn_file_names_json,session_mode = NEW.session_mode,run_context_json = NEW.run_context_json,applied_plugin_snapshot_json = NEW.applied_plugin_snapshot_json,started_at = NEW.started_at,ended_at = NEW.ended_at,position = NEW.position,created_at = NEW.created_at,run_id = NEW.run_id,run_status = NEW.run_status,last_run_event_id = NEW.last_run_event_id,comment_attachments_json = NEW.comment_attachments_json
          WHERE id = OLD.id;
        DELETE FROM message_event_deltas WHERE message_id = OLD.id;
      END;
CREATE TRIGGER messages_delete INSTEAD OF DELETE ON messages BEGIN
        DELETE FROM message_snapshots WHERE id = OLD.id;
      END;