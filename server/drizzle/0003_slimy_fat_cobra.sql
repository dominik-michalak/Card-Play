CREATE TYPE "public"."achievement_id" AS ENUM('first_win', 'war_chain_3', 'macao_clean_finish', 'macao_comeback', 'poker_all_in_win', 'poker_eliminator', 'fair_play_10', 'streak_5');--> statement-breakpoint
CREATE TABLE "user_achievements" (
	"user_id" uuid NOT NULL,
	"achievement_id" "achievement_id" NOT NULL,
	"unlocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_achievements_user_id_achievement_id_pk" PRIMARY KEY("user_id","achievement_id")
);
--> statement-breakpoint
ALTER TABLE "game_record_players" ADD COLUMN "forfeited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;