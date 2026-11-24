CREATE TABLE "action_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"action" text NOT NULL,
	"nonce_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_requests_status_ck" CHECK ("action_requests"."status" in ('pending', 'confirmed', 'expired', 'failed', 'succeeded'))
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "target" jsonb;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD COLUMN "poll_secret_hash" text;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD COLUMN "requester_ip_hash" text;--> statement-breakpoint
ALTER TABLE "action_requests" ADD CONSTRAINT "action_requests_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_requests" ADD CONSTRAINT "action_requests_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_requests_device_created_idx" ON "action_requests" USING btree ("device_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pairing_codes_poll_secret_uq" ON "pairing_codes" USING btree ("poll_secret_hash");--> statement-breakpoint
CREATE INDEX "pairing_codes_ip_created_idx" ON "pairing_codes" USING btree ("requester_ip_hash","created_at");--> statement-breakpoint
-- Backfill action targets from stored webhook payloads (same rules as src/lib/github.ts + sentry.ts).
-- Run ids are capped at 18 digits so the ::bigint cast can never overflow.
UPDATE "alerts" SET "target" = jsonb_strip_nulls(jsonb_build_object(
	'repo', "payload"->'repository'->>'full_name',
	'runId', COALESCE(
		CASE WHEN jsonb_typeof("payload"->'workflow_run'->'id') = 'number'
			AND ("payload"->'workflow_run'->>'id') ~ '^[0-9]{1,18}$'
			THEN ("payload"->'workflow_run'->>'id')::bigint END,
		substring("payload"->'workflow_run'->>'html_url' from '/actions/runs/([0-9]{1,18})(?:[/?#]|$)')::bigint
	)
))
WHERE "source" = 'github' AND "kind" = 'workflow_run.failure' AND "target" IS NULL;--> statement-breakpoint
-- Sentry: `issue` webhooks use data.issue (web_url, else permalink); `event_alert`/`error` use
-- data.event|data.error (project: string `project` field, else the API url; org: web_url host, else API url).
UPDATE "alerts" SET "target" = jsonb_strip_nulls(jsonb_build_object(
	'issueId', COALESCE(
		"payload"->'data'->'issue'->>'id',
		COALESCE("payload"->'data'->'event', "payload"->'data'->'error')->>'issue_id',
		substring(COALESCE("payload"->'data'->'issue'->>'web_url', "payload"->'data'->'issue'->>'permalink', COALESCE("payload"->'data'->'event', "payload"->'data'->'error')->>'web_url') from '/issues/([0-9]+)/'),
		substring("dedup_key" from '^issue:([0-9]+)$')
	),
	'project', COALESCE(
		"payload"->'data'->'issue'->'project'->>'slug',
		CASE WHEN jsonb_typeof(COALESCE("payload"->'data'->'event', "payload"->'data'->'error')->'project') = 'string'
			THEN COALESCE("payload"->'data'->'event', "payload"->'data'->'error')->>'project' END,
		substring(COALESCE("payload"->'data'->'event', "payload"->'data'->'error')->>'url' from '/projects/[^/]+/([^/]+)/')
	),
	'org', COALESCE(
		NULLIF(NULLIF(substring(COALESCE(
			"payload"->'data'->'issue'->>'web_url',
			"payload"->'data'->'issue'->>'permalink',
			COALESCE("payload"->'data'->'event', "payload"->'data'->'error')->>'web_url'
		) from '^https://([a-z0-9-]+)\.sentry\.io/'), 'us'), 'de'),
		substring(COALESCE("payload"->'data'->'event', "payload"->'data'->'error')->>'url' from '/projects/([^/]+)/[^/]+/')
	)
))
WHERE "source" = 'sentry' AND "target" IS NULL;--> statement-breakpoint
-- Keep only usable targets (a GitHub run id / Sentry issue id is mandatory).
UPDATE "alerts" SET "target" = NULL
WHERE "target" IS NOT NULL AND NOT ("target" ? 'runId' OR "target" ? 'issueId');