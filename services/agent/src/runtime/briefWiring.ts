/**
 * The real clients behind `brief.weekly` (briefHandler.ts): the table, Sonnet
 * through Strands' BedrockModel, the Bedrock Guardrail, and egress to her
 * television. Wiring only — every piece it wires is tested on its own.
 *
 * Read from the runtime's environment (infra/agentcore.tf):
 * AGENTS_GUARDRAIL_ID and _VERSION name the Guardrail (without them every
 * draft is written from the facts, since nothing could check it);
 * WICK_NARRATIVE_MODEL the model, as the Narrator's Lambda has it;
 * WICK_HOUSEHOLD_TZ the household's clock.
 */
import { randomUUID } from 'node:crypto';
import { ApplyGuardrailCommand, BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DEFAULT_POLICY } from '@wick/policy';
import { sendToDevice } from '../egress.js';
import { guardrailFromEnv } from '../agents/brief/guardrail.js';
import { householdRows, type PagedSend } from '../agents/brief/loaders.js';
import { weekStore, type WeekSend } from '../agents/brief/store.js';
import { familyOnly } from '../agents/door/askFamily.js';
import { NARRATIVE_REGION } from '../agents/narrator/prose.js';
import { buildWeekCard, familyNameForWeekCard } from '../agents/narrator/weekCard.js';
import { briefModel, runWeeklyBriefGraph } from '../graphs/weeklyBrief.js';
import { loadHouseholdPolicy, loadHouseholdTimeZone, loadRoster } from '../store/household.js';
import { lookStore, type LookSend } from '../store/looks.js';
import type { BriefHandlerDeps } from './briefHandler.js';

export function briefWeeklyDepsFor(ddb: DynamoDBClient, table: string): (householdId: string) => BriefHandlerDeps {
  const bedrock = new BedrockRuntimeClient({ region: NARRATIVE_REGION });
  const guardrailRef = guardrailFromEnv();
  const paged: PagedSend = (cmd) => ddb.send(cmd as never) as ReturnType<PagedSend>;
  const weeks = weekStore((cmd) => ddb.send(cmd as never) as ReturnType<WeekSend>, table);
  const looks = lookStore((cmd) => ddb.send(cmd as never) as ReturnType<LookSend>, table);

  return (householdId) => {
    const rows = householdRows(paged, table, householdId);
    const sendWeekCard: BriefHandlerDeps['sendWeekCard'] = async (narrative) => {
      // A circle that cannot be read costs the button its name, never the household its week.
      const family = await looks.listFamily(householdId).catch(() => undefined);
      const familyName = family ? familyNameForWeekCard(familyOnly(family).map((member) => member.name)) : undefined;
      await sendToDevice(buildWeekCard(narrative, randomUUID(), Date.now(), familyName), DEFAULT_POLICY);
    };
    return {
      weeks,
      sendWeekCard,
      run: async (input) => runWeeklyBriefGraph(input, {
        writerModel: briefModel(120),
        suggesterModel: briefModel(300),
        loadEvents: rows.loadEvents,
        firstEventAt: rows.firstEventAt,
        loadErrands: rows.loadErrands,
        loadTvActivity: rows.loadTvActivity,
        loadPolicy: () => loadHouseholdPolicy(ddb, table, householdId),
        loadPeople: async () => [
          ...(await loadRoster(ddb, table, householdId)).map((person) => person.name),
          ...(await looks.listFamily(householdId)).map((member) => member.name),
        ],
        guardrail: (request) => bedrock.send(new ApplyGuardrailCommand(request)),
        guardrailRef,
        saveWeek: weeks.save,
        sendWeekCard,
        now: Date.now,
        // This home's own clock: its week is counted, and its days named, in it.
        timeZone: await loadHouseholdTimeZone(ddb, table, householdId),
      }),
    };
  };
}
