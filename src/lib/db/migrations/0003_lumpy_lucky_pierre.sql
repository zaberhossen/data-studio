ALTER TABLE "dashboards" ADD COLUMN "tabs" jsonb;--> statement-breakpoint
ALTER TABLE "widgets" ADD COLUMN "tab_id" text;