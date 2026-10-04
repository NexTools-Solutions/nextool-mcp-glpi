/**
 * MCP prompts for GLPI.
 *
 * Deliberately few. A prompt catalogue is dead weight unless each entry
 * encodes a workflow that is genuinely awkward to drive from tool
 * descriptions alone — which here means knowing which tool to reach for, in
 * what order, and which numeric codes to expect back.
 */

/** Structural type of the registerPrompt bits used here. */
interface PromptCapableServer {
  registerPrompt(
    name: string,
    metadata: Record<string, unknown>,
    build: (args: Record<string, unknown>) => {
      messages: { role: "user" | "assistant"; content: { type: "text"; text: string } }[];
    },
  ): unknown;
}

function userMessage(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  /** Zod raw shape for the arguments, injected by the server. */
  argsShape: Record<string, unknown>;
  build(args: Record<string, unknown>): string;
}

/**
 * Builds the prompt definitions. The zod schemas come from the caller so this
 * module does not depend on a second copy of zod.
 */
export function buildPrompts(schemas: {
  ticketId: unknown;
  optionalText: unknown;
  requiredText: unknown;
}): PromptDefinition[] {
  return [
    {
      name: "triage_ticket",
      title: "Triage a ticket",
      description:
        "Read a ticket and its timeline, then propose category, urgency/impact and the group " +
        "or technician to assign, justified by what the ticket actually says.",
      argsShape: { ticket_id: schemas.ticketId },
      build: (args) => `Triage GLPI ticket ${String(args.ticket_id)}.

Steps:
1. glpi_get_ticket for the ticket itself.
2. glpi_list_followups and glpi_list_ticket_tasks for what has happened so far.
3. glpi_list_ticket_users to see who is already involved (type 1=requester, 2=assigned, 3=observer).
4. Read glpi://code-maps to interpret the status, urgency, impact and priority codes,
   and glpi://itil-categories to pick a category that exists on this instance.

Then report:
- What the requester is actually asking for, in one or two sentences.
- Whether it is an incident (type 1) or a request (type 2), and why.
- The category you would set, by name and id.
- Urgency and impact you would set, with the reason.
- Who should take it, and whether anything is blocking.
- Anything missing that should be asked of the requester.

Do not modify the ticket. Propose; the human decides.`,
    },
    {
      name: "investigate_recurrence",
      title: "Investigate a recurring incident",
      description:
        "Given a ticket, find similar past tickets and their solutions, and judge whether this " +
        "warrants a Problem record.",
      argsShape: { ticket_id: schemas.ticketId, keywords: schemas.optionalText },
      build: (args) => {
        const kw = args.keywords ? String(args.keywords) : "";
        return `Investigate whether GLPI ticket ${String(args.ticket_id)} is a recurrence.

Steps:
1. glpi_get_ticket to read the symptom.
2. glpi_search on Ticket with criteria matching the symptom${kw ? ` (start from these keywords: ${kw})` : ""}.
   Use glpi_list_search_options to find the right field ids.
3. glpi_get_ticket_stats to see the volume this instance is dealing with.
4. For the closest matches, read their solutions (glpi_list_followups and the solution field).
5. glpi_list_problems to check whether a Problem already covers this.

Then report:
- How many comparable tickets you found, and over what period.
- The pattern they share, if any — same asset, same user group, same time of day, same change.
- What fixed them before, and whether that fix stuck.
- Your call: one-off, or a Problem record is warranted. Say which and why.

Read only. Do not create the Problem yourself.`;
      },
    },
    {
      name: "requester_history",
      title: "Summarise a requester's history",
      description:
        "Everything a technician should know before picking up a call from this person: open " +
        "items, recent history and recurring themes.",
      argsShape: { user: schemas.requiredText },
      build: (args) => `Summarise the GLPI history of requester "${String(args.user)}".

Steps:
1. Resolve the user: glpi_search_user_by_email if it looks like an email, otherwise
   glpi_search on User by name.
2. glpi_search on Ticket filtered by that requester. Use glpi_list_search_options
   to find the requester field id.
3. Read glpi://code-maps to interpret the status codes.

Then report:
- What is open right now, oldest first, with status and age.
- What was solved recently and how.
- Recurring themes — the same asset, the same software, the same request over and over.
- One line a technician should read before calling this person back.`,
    },
    {
      name: "asset_context",
      title: "Asset context for a call",
      description:
        "Hardware profile of an asset plus the tickets around it — the picture to have open " +
        "before touching a machine.",
      argsShape: { asset_type: schemas.requiredText, asset_id: schemas.ticketId },
      build: (args) => `Give me the working context for ${String(args.asset_type)} ${String(args.asset_id)}.

Steps:
1. glpi_get_asset_details for the hardware (processors, memory, disks, operating system).
   Ask for the 'softwares' section only if the question is about software.
2. glpi_count_items on Ticket, with criteria linking to this asset, to size the ticket history.
3. glpi_search on Ticket for the recent ones, and read what they were about.

Then report:
- What the machine is: model, CPU, memory, disks, OS.
- Who uses it and where it is.
- What has gone wrong with it before, and whether anything is still open.
- Anything that looks like a hardware limit about to be hit (disk nearly full, memory undersized).`,
    },
  ];
}

/** Registers every prompt on the server. */
export function registerPrompts(server: object, definitions: PromptDefinition[]): void {
  const target = server as PromptCapableServer;
  for (const def of definitions) {
    target.registerPrompt(
      def.name,
      { title: def.title, description: def.description, argsSchema: def.argsShape },
      (args: Record<string, unknown>) => userMessage(def.build(args)),
    );
  }
}
