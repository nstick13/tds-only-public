/**
 * Data-access layer barrel. Import from "@/lib/db" rather than reaching into
 * individual files, though the individual modules (stages.ts, members.ts, ...)
 * are fine to import directly when you only need one or two functions.
 *
 * Every league-scoped helper here takes an explicit scope argument — a
 * leagueId, or a stageId, which implies one. There is no ambient "the league"
 * any more, and a helper that guessed would return another league's rows or,
 * more likely, silently return none.
 */
export * from "./stages";
export * from "./stats";
export * from "./players";
export * from "./profiles";
export * from "./members";
export * from "./invites";
export * from "./roster";
export * from "./draftOrder";
export * from "./results";
export * from "./sync";
