CREATE TABLE "lb06"."incident_events" (
	"incident_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"minute" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "incident_events_incident_id_seq_pk" PRIMARY KEY("incident_id","seq"),
	CONSTRAINT "incident_events_seq_check" CHECK ("lb06"."incident_events"."seq" between 1 and 600)
);
--> statement-breakpoint
CREATE TABLE "lb06"."incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_key" text NOT NULL,
	"origin" text NOT NULL,
	"sample_id" text,
	"seed" integer NOT NULL,
	"fault" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"guard" text DEFAULT 'not_needed' NOT NULL,
	"state" text DEFAULT 'baseline' NOT NULL,
	"end_reason" text,
	"minute" integer DEFAULT 0 NOT NULL,
	"next_tick_at" timestamp with time zone NOT NULL,
	"model_calls" integer DEFAULT 0 NOT NULL,
	"cached" integer DEFAULT 0 NOT NULL,
	"proposals_made" integer DEFAULT 0 NOT NULL,
	"pending_proposal" jsonb,
	"rerank" integer DEFAULT 0 NOT NULL,
	"remediations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"remediated_at" integer,
	"investigation" jsonb,
	"alert_minute" integer,
	"recovered_minute" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "incidents_origin_check" CHECK ("lb06"."incidents"."origin" in ('sample', 'custom')),
	CONSTRAINT "incidents_sample_check" CHECK (("lb06"."incidents"."origin" = 'sample') = ("lb06"."incidents"."sample_id" is not null)),
	CONSTRAINT "incidents_fault_check" CHECK ("lb06"."incidents"."fault" in ('bad_deploy', 'slow_payment', 'memory_leak', 'cache_stampede')),
	CONSTRAINT "incidents_guard_check" CHECK ("lb06"."incidents"."guard" in ('not_needed', 'clean', 'flagged', 'unchecked')),
	CONSTRAINT "incidents_state_check" CHECK ("lb06"."incidents"."state" in ('baseline', 'detecting', 'investigating', 'awaiting_approval', 'remediating', 'verifying', 'writing_postmortem', 'closed', 'aborted', 'failed')),
	CONSTRAINT "incidents_end_check" CHECK (("lb06"."incidents"."state" in ('aborted', 'failed')) = ("lb06"."incidents"."end_reason" is not null)),
	CONSTRAINT "incidents_pending_check" CHECK (("lb06"."incidents"."state" = 'awaiting_approval') = ("lb06"."incidents"."pending_proposal" is not null)),
	CONSTRAINT "incidents_calls_check" CHECK ("lb06"."incidents"."model_calls" between 0 and 15),
	CONSTRAINT "incidents_proposals_check" CHECK ("lb06"."incidents"."proposals_made" between 0 and 3)
);
--> statement-breakpoint
CREATE TABLE "lb06"."scenario_cache" (
	"key" text NOT NULL,
	"stage" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scenario_cache_key_stage_pk" PRIMARY KEY("key","stage")
);
--> statement-breakpoint
CREATE TABLE "lb06"."usage_counters" (
	"session_key" text NOT NULL,
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"used" integer NOT NULL,
	CONSTRAINT "usage_counters_session_key_day_kind_pk" PRIMARY KEY("session_key","day","kind"),
	CONSTRAINT "usage_counters_kind_check" CHECK ("lb06"."usage_counters"."kind" in ('incident'))
);
--> statement-breakpoint
ALTER TABLE "lb06"."incident_events" ADD CONSTRAINT "incident_events_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "lb06"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incidents_session_idx" ON "lb06"."incidents" USING btree ("session_key","created_at");--> statement-breakpoint
CREATE INDEX "incidents_expires_idx" ON "lb06"."incidents" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "incidents_state_idx" ON "lb06"."incidents" USING btree ("state","updated_at");