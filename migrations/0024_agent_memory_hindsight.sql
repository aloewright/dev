-- Local mirror/audit of Hindsight retains. hindsight_id = server-assigned operation
-- id; bank_key = the stable bank this retain landed in (u:<userId>:p:<projectId>).
-- The agent_memories table is a write-through ledger; Hindsight is the recall source.
ALTER TABLE agent_memories ADD COLUMN hindsight_id TEXT;
ALTER TABLE agent_memories ADD COLUMN bank_key TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_memories_bank_key ON agent_memories (bank_key);
