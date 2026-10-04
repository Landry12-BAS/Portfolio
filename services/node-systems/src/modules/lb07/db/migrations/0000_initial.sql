CREATE TABLE "lb07"."evidence" (
	"run_id" uuid NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"engine" text NOT NULL,
	"step_index" integer,
	"image" "bytea",
	"text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_run_id_id_pk" PRIMARY KEY("run_id","id"),
	CONSTRAINT "evidence_kind_check" CHECK ("lb07"."evidence"."kind" in ('screenshot', 'snapshot')),
	CONSTRAINT "evidence_content_check" CHECK (("lb07"."evidence"."kind" = 'screenshot') = ("lb07"."evidence"."image" is not null))
);
--> statement-breakpoint
CREATE TABLE "lb07"."findings" (
	"run_id" uuid NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"engine" text NOT NULL,
	"step_index" integer,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"rule" text,
	"path" text,
	"evidence_ids" jsonb NOT NULL,
	CONSTRAINT "findings_run_id_id_pk" PRIMARY KEY("run_id","id"),
	CONSTRAINT "findings_kind_check" CHECK ("lb07"."findings"."kind" in ('expectation_failed', 'console_error', 'failed_request', 'accessibility', 'blocked_navigation')),
	CONSTRAINT "findings_engine_check" CHECK ("lb07"."findings"."engine" in ('chromium', 'firefox-ua'))
);
--> statement-breakpoint
CREATE TABLE "lb07"."reports" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"report" jsonb NOT NULL,
	"test_source" text NOT NULL,
	"verdict" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_verdict_check" CHECK ("lb07"."reports"."verdict" in ('kept', 'passing', 'discarded_not_red', 'discarded_not_green', 'not_verified'))
);
--> statement-breakpoint
CREATE TABLE "lb07"."run_steps" (
	"run_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"plan" integer DEFAULT 0 NOT NULL,
	"step" jsonb NOT NULL,
	"status" text NOT NULL,
	"outcome" text,
	"duration_ms" integer,
	CONSTRAINT "run_steps_run_id_index_pk" PRIMARY KEY("run_id","index"),
	CONSTRAINT "run_steps_status_check" CHECK ("lb07"."run_steps"."status" in ('pending', 'running', 'passed', 'failed', 'finding', 'blocked', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "lb07"."runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_key" text NOT NULL,
	"origin" text NOT NULL,
	"sample_id" text,
	"goal" text NOT NULL,
	"bugs" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"failure_code" text,
	"reading" text,
	"working" jsonb,
	"final_plan" jsonb,
	"model_calls" integer DEFAULT 0 NOT NULL,
	"replans" integer DEFAULT 0 NOT NULL,
	"findings_count" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "runs_origin_check" CHECK ("lb07"."runs"."origin" in ('sample', 'custom')),
	CONSTRAINT "runs_sample_check" CHECK (("lb07"."runs"."origin" = 'sample') = ("lb07"."runs"."sample_id" is not null)),
	CONSTRAINT "runs_state_check" CHECK ("lb07"."runs"."state" in ('queued', 'planning', 'running', 'replanning', 'cross_checking', 'reporting', 'verifying', 'done', 'failed')),
	CONSTRAINT "runs_failure_check" CHECK (("lb07"."runs"."state" = 'failed') = ("lb07"."runs"."failure_code" is not null)),
	CONSTRAINT "runs_goal_check" CHECK (char_length("lb07"."runs"."goal") between 1 and 300)
);
--> statement-breakpoint
CREATE TABLE "lb07"."usage_counters" (
	"session_key" text NOT NULL,
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"used" integer NOT NULL,
	CONSTRAINT "usage_counters_session_key_day_kind_pk" PRIMARY KEY("session_key","day","kind"),
	CONSTRAINT "usage_counters_kind_check" CHECK ("lb07"."usage_counters"."kind" in ('run'))
);
--> statement-breakpoint
ALTER TABLE "lb07"."evidence" ADD CONSTRAINT "evidence_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "lb07"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lb07"."findings" ADD CONSTRAINT "findings_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "lb07"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lb07"."reports" ADD CONSTRAINT "reports_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "lb07"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lb07"."run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "lb07"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_session_idx" ON "lb07"."runs" USING btree ("session_key","created_at");--> statement-breakpoint
CREATE INDEX "runs_expires_idx" ON "lb07"."runs" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "runs_state_idx" ON "lb07"."runs" USING btree ("state","updated_at");