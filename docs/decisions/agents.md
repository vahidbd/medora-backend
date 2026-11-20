# AI agents

Rulings for Medora's own AI agents: the runtime, the tool catalogue, approval cards, limits, the safety screen, evals, the launch agents and voice. ADRs 0005, 0008, 0012, 0020, 0029 and 0240 set the rules; these record the choices made while building them. The console's side is in `medora-front`'s copy of this file.

Rulings marked "Decided by: stand-in (Fable 5.2), to confirm with Vahid" were decided while the product owner asked not to be waited on, and are listed in the pull request under "Decisions to confirm".

### AGT1. Four launch agents, each off until a tenant admin switches it on

Decision: the agents are `intake`, `support`, `care_coordinator` and `clinical_copilot` (`AGENT_KINDS`). Each has one settings row per tenant (`platform.agent_settings`), made the first time an admin changes it, and is off until then. Switching one on needs `agents:manage`, a passing eval result for the version that would run (AGT10) and a monthly spend cap. Voice is a channel of the support and care coordinator agents, not a fifth agent. The AI scribe is not built.
Why: AIP-14 and ADR 0012. A row per tenant gives each agent the id the audit log records as the actor.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### AGT2. A tool is a route, called in-process with a credential that never leaves the process

Decision: a route whose config names `agentTool: '<name>'` is a tool (`src/plugins/agent-tools.ts`). Its summary is the tool's description and its params, querystring and body schemas, side by side, are the input. The route must need a permission. An agent runs a tool by calling the route through Fastify's inject with `Authorization: Agent <credential>`, signed by a key made in memory at boot (`src/lib/agent-credential.ts`), lasting two minutes, naming tenant, agent, run, approver and the permissions for that call. The auth plugin accepts it only on routes that need a permission, and only when it holds that permission. Effective permissions are the agent's role narrowed to the staff member it works for or the one who approved the change. The role is worked out from code: the permissions of the routes its tools name (`agentRolePermissions`), never stored and never a membership, and never one of `AGENT_FORBIDDEN_PERMISSIONS` (`staff:manage`, `roles:manage`, `break_glass:review`, ADM-07). The agents service refuses to start if a tool's route needs a forbidden permission, and services that change staff access refuse an agent actor (`person_only`). The audit log records actor type `agent`, the agent's settings row id, and adds `agentRunId` and `approvedBy` to the entry's details.
Why: the route's own permission check, tenancy, gates and audit apply to the agent exactly as to a person, with no second path into the data. A key that is never configured can't leak from configuration.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### AGT3. Settings and run metadata in platform; transcripts and cards in clinical

Decision: `platform.agent_settings`, `platform.agent_tenant_settings` (the tenant-wide switch) and `platform.agent_runs` hold ids, codes, numbers and cost (integer AUD cents, estimated from tokens and a price table in code). `clinical.agent_conversations`, `clinical.agent_messages` (exactly what went to and came from the model, tool calls and results included) and `clinical.agent_proposals` (approval cards) hold the text. Every read of a clinical agent table writes an audit entry. No free text goes into run rows, audit details, events or logs. Nothing is deleted in v1. When per-field encryption (ADR 0010) lands, transcript text and card payloads use it.
Why: patients' free text can carry health information, so all of it goes in the strictest zone rather than splitting by a guess about which text is clinical.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### AGT4. Who may do what with agents

Decision: three permissions, fitted to the staff roles of ADR 0036.
- `agents:manage` (platform zone, owner only) switches agents on and off, sets caps and raises tools to Auto, and pauses or resumes all of a tenant's agents.
- `agents:read` (platform zone: owner, admin, medical director, finance, compliance) shows run metadata, usage and cost, with no text.
- `agents:transcripts` (clinical zone: medical director, prescriber, clinician) shows the model-side transcript, every read audited. Being clinical, the owner and other non-clinical roles reach it only under break-glass.
- The approvals inbox is open to every member (`access: 'member'`) and lists only the cards the viewer could approve: those whose route needs a permission the viewer can use now. Approving runs the route narrowed to the approver, so it passes the route's record check and the approver's own limits. There is no "approve anything" permission.
- Support staff read handed-off conversations in the helpdesk, under their own permission.
Why: the person who approves must be someone who could make the change themselves (ADR 0030), and the people who inherit a conversation must be able to read it. A transcript holds patients' words, so it follows the clinical zone like every other clinical read.
Decided by: stand-in (Fable 5.2), fitted to the staff roles by the AI agents thread, to confirm with Vahid

### AGT5. Kill switches at three levels

Decision: an agent is off when its own setting is off, when its tenant has paused all agents (one flag, so resuming restores each agent's own setting), or when the platform switch `AGENTS_ENABLED` is not `true`. The switches are checked when a run is claimed, before every model call and before every tool call. While an agent is off its pending proposals can be rejected but not approved, and its conversations go to people with reason `agent_off`. Every change to a setting or the tenant switch writes an audit entry and an `agent_settings.changed` or `agent_tenant_settings.changed` event.
Why: AIP-05. "Off" has to stop changes an agent already proposed, not only new runs.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### AGT6. Limits, each ending in a handoff

Decision: per agent per tenant, a monthly spend cap (default A$150, platform maximum A$5,000), runs per day (default 1,000, maximum 10,000) and a refund cap (default A$0, maximum A$500, see AGT7); per conversation, 30 runs a day (`CONVERSATION_DAILY_RUNS`); per run, the definition's step limit (12, or 8 for the copilot) and 120 seconds (`RUN_SECONDS`). Platform maxima are constants in code (`AGENT_LIMIT_MAXIMA`) and database checks. Days and months are in the tenant's time zone (ADR 0017). Spend is checked when a message arrives and before every model call. Cost is estimated in integer AUD cents, rounded up, from the tokens each reply reports, the price table in `runtime/cost.ts` and a fixed A$1.55 per US dollar; the agents service refuses to start if an agent's model has no price. Passing 80% and 100% of the cap emits `agent_spend.threshold_reached` for the owners. Every limit hands the conversation to a person with reason `limit` and an end reason on the run (`spend_cap`, `time_limit`, `step_limit`, `context_window`).
Why: AIP-04. Intake chat is open to the public, so the spend cap needs per-conversation and per-run limits beneath it. A limit that fails silently leaves a patient waiting.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### AGT7. Autonomy ceilings

Decision: every tool that changes data starts at Approve. A tenant may raise a tool to Auto only where its line in `TOOL_POLICY` allows. Auto ceilings at launch: the intake agent booking the patient's own consult (`book_consult`), and the care coordinator sending an approved template (`send_template_message`) and booking a review (`book_review_consult`). Handing off is always Auto and can't be turned off. Everything else, the copilot's output and every refund included, goes on a card. A tool line can carry a tenant limit on an amount (`autoLimit`); the refund line names `amountCents` and the refund cap, so if refunds are ever allowed to run without a person, only refunds within the cap would. Autonomy is read when the tool is called, so lowering it applies to runs already queued.
Why: an Auto change must be one the patient could make themselves, from text the model didn't write. A refund is a staff power triggered by a patient's words, which is the case ADR 0012's untrusted-text rule exists for.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### AGT8. Runs, the claim and the agents service

Decision: a message or job queues a run in `platform.agent_runs`. A separate service from the same image (`medora-agents`, `src/agents.ts`, `railway.agents.json`) claims runs through `platform.claim_agent_runs`, a SECURITY DEFINER function and the only cross-tenant query: `FOR UPDATE SKIP LOCKED`, one running run per conversation, at most 2 per tenant at once, 4 per service, with a 180-second lease. Everything after the claim runs inside `withTenant`, in short transactions before, between and after model calls, never one held across a call. A run whose lease ran out is marked failed and its conversation handed to a person, never resumed. On shutdown the service stops claiming and waits up to 25 seconds for its runs. Each tool call carries the idempotency key `<run id>:<tool use id>`. The API never runs agents; in development and tests the loop is driven directly.
Why: ADR 0029. Failing to a person is simpler and safer than replaying half a run.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### AGT9. Pins, verified conversations and masking

Decision: a conversation names its patient and, for a job, its subject record. A tool's pinned fields (`TOOL_POLICY[...].pins`) are left out of the schema the model sees and set from the conversation when the tool runs, whatever the model sent. Tools that touch a patient's record (`patientRecord`) are offered only in a verified conversation: signed-in chat with a patient. Email, SMS, voice and public chat are unverified: help centre answers, message taking and handoff only, because caller ids and From addresses can be faked. Patient text is stored and sent to the model masked: the channel passes the patient's own known values (name, email, phone, Medicare number) to mask first, then `maskText` removes anything shaped like contact details or identifiers. A tool's reply loses the values of identity fields at any depth (`name`, `firstName`, `email`, `phone`, `address`, `dateOfBirth`, `medicareNumber` and the like), is masked by pattern, and is cut to 20,000 characters; a route names other things under other keys (`productName`, not `name`). Names are not put back into the model's reply. Patient text reaches the model inside `<patient_message>` tags as data, never as instructions.
Why: AGENTS.md forbids patient details in a model prompt without masking, and an agent must never be able to reach another patient's record however it is asked.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### AGT10. Versions and the eval gate

Decision: an agent's version is a hash of its definition (purpose, model id, limits), the shared rules, its tools' names, descriptions, schemas and policy lines, the handoff tool and the safety screen (`agentVersion`). `npm run evals` runs each agent's cases (`evals/<agent>.json`, plus the shared `evals/safety.json`) through the same engine with fake tools; `--record` writes `evals/results/<agent>.json` and is refused unless the model client is Bedrock. An agent can't be switched on, and a run stops before its first model call, unless a passing result is recorded for the version that would run. In CI (`npm run check`), every agent must have cases and a recorded result must match the current version. A missing result is allowed in CI, because results can only be recorded with staging's Bedrock access; it still blocks switching the agent on. Safety cases must all pass. Eval cases and fixtures use made-up people; edited or rejected cards feed back only as a decision reason, from which a person writes a synthetic case.
Why: AIP-06. The gate lives where the agent runs, not only in CI, so an unevaluated prompt or model change can't reach a patient.
Decided by: stand-in (Fable 5.2); allowing a missing result in CI by the AI agents thread; to confirm with Vahid

### AGT11. Handoff, the safety screen, disclosure and hand back

Decision: a handoff carries one reason: `emergency`, `self_harm`, `clinical`, `distress`, `complaint`, `adverse_event`, `legal` or `patient_asked` (the model may choose these through the `hand_off` tool), or `refusal`, `limit`, `error` or `agent_off` (the runtime's). `emergency`, `self_harm` and `adverse_event` are urgent. Every patient message is screened before the model on every channel (`runtime/safety-screen.ts`, versioned, part of the agent version): emergency and self-harm terms, and asking for a person. On a match the patient gets fixed text (000, Lifeline 13 11 14), the conversation goes to a person, and the model is not called, even while the agent is off. The matched words are never stored in audit details or events. A model refusal, error or timeout hands off too. Once handed off the agent stays out until a person hands it back. Patients are told by fixed text, never by the model, that they are talking to an AI agent, by its name, and how to reach a person (`aiDisclosure`). Tenant terms for the screen, the banned-terms check on replies and help centre article citations come with the support and marketing compliance modules.
Why: AIP-08 and SUP-07. The safety net has to work when the model is wrong, slow or refusing.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### AGT12. Proposals, shown as approval cards

Decision: a proposal stores exactly what would run: the tool, the permission its route needs and the model's input. Approving re-checks now, not when the card was made: the agent must be on, the tool's route must still exist with the same permission and still be in the agent's role, and the card must be pending and less than seven days old. Only one approval moves a proposal on (`for update` and a status check), so approving twice runs once. The route runs after the approval commits, as the agent narrowed to the approver, with the proposal's idempotency key, and pinned fields set again from the conversation, so an approver's edit can't move the change to another patient. The outcome goes on the proposal and into the conversation as a notice for the agent's next run. A proposal approved but whose outcome never arrived stays approved and is not retried. A rejection takes a reason code (`DECISION_REASONS`). The proposal keeps the AI's input and the approver's final input side by side.
Why: AIP-03, AIP-10 and AIP-13. What a person approves is what happens, once.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### AGT13. The clinical copilot and jobs

Decision: the copilot runs only as a job about one intake (`startJob`), started by a staff member or by the module that books the consult, and narrowed to the person who started it. It reads the intake's answers and the protocol engine's checklist and proposes one summary on a card. Every summary line cites the answer it restates, and met or not met comes only from the protocol engine; the intake thread's `save_intake_summary` route enforces both in its schema. It makes no recommendation, ranking or eligibility call, and nothing else reads its output. The prescriber accepts, edits or rejects; the AI's version stays on the card beside the prescriber's (AIP-10). No scribe or transcription is built.
Why: every statement traceable to a patient answer is what keeps this out of medical device territory.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### AGT14. Voice comes next, after written proof audio stays in Australia

Decision: AI voice is the `voice` channel of the support and care coordinator agents, built in the next pull request on the EMR thread's Twilio client. It waits for written confirmation that Twilio media streams on AU1 keep audio in Australia, and for the AWS AI services opt-out on the account. No audio is recorded or stored. Callers are unverified (AGT9). The opening is fixed text: brand, the agent's name, that it is automated, that the call is transcribed, and "press 0 for a person". Outbound calls are approved scripts only, to numbers with recorded consent, inside a platform floor on hours in the patient's time zone, at most two attempts, and "stop calling" is honoured at once.
Why: ADRs 0005 and 0020. The announcement and an easy way to a person are the consent basis.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### AGT15. Delivery

Decision: the runtime and all four agents land in one backend and one frontend pull request, stacked on the staff access branch (ADR 0036) because agent permissions follow its zones, its `member` access and its forbidden list. Each agent gets its tools when the owning module's routes merge: the owning thread declares `agentTool` on its own route, under the name in `TOOL_POLICY`, and removes the line's `waitingOn` (a test fails until it does). Stand-in routes live only in tests and evals.
Why: the coordinator's brief asked for one pull request per repo; an agent without its tools can't be switched on, because its version changes when they arrive and needs a fresh eval.
Decided by: the coordinator's brief, to confirm with Vahid

### AGT16. How other modules hand work in

Decision: modules reach the agents only through the agents module's front door: `openConversation`, `receiveMessage` (returns whether the agent, a person or the safety screen answers), `startJob`, `readReply`, `handBack` and `screenMessage`. Replies go out through the `agent_message.created` event, which the channel's module delivers; handoffs emit `agent_conversation.handed_off` with the reason and whether it is urgent, which the helpdesk turns into a queue item. The agents module never writes another module's tables.
Why: ADR 0027. Each channel keeps its own sending rules (consent, quiet hours, limits) and the agents keep theirs.
Decided by: the AI agents thread, to confirm with Vahid

### AGT17. Models

Decision: Claude through Amazon Bedrock in Sydney (`ap-southeast-2`) only; the service refuses another region. Patient-facing agents run Sonnet 5.5 at low effort; the copilot runs Opus 5.5 at medium effort. Each definition pins its model id, which is part of the agent's version, so a model change needs a fresh eval. No sampling parameters, no forced tool choice; the system prompt is cached. In development and tests a scripted stand-in answers, and `AGENTS_ENABLED=true` in a deployed environment requires Bedrock.
Why: patient conversations need speed and steady cost; the copilot's work is read by a prescriber and is worth the stronger model.
Decided by: the AI agents thread, to confirm with Vahid
