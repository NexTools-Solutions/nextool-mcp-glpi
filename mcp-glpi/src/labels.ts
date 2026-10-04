/**
 * Labels for GLPI codes (status, type, actor role, validation status, priority,
 * urgency, impact) in the language of the connected GLPI user (API v1).
 *
 * The API v1 returns codes (`status: 5`); the API v2 returns the label in the
 * user's language ("Solucionado"). Before 3.5.0 the v1 tools added fixed
 * English labels, so the same GLPI answered "Solved" on one family and
 * "Solucionado" on the other. The session language (getFullSession ->
 * session.glpilanguage) now picks the table, cached per credential.
 *
 * The texts are GLPI's own: taken from the msgids GLPI 11 uses for these codes
 * (Ticket/Problem/Change::getAllStatusArray, Ticket::getTicketTypeName,
 * CommonITILObject::getPriorityName/getUrgencyName/getImpactName, the actor
 * role labels, CommonITILValidation::getAllStatusArray, Planning::getState for
 * the task state) and their translations
 * in glpi-project/glpi locales/*.po (11.0/bugfixes). A language without a table
 * falls back to its family (es_MX -> es_ES), then to GLPI's English.
 */

import { getFullSession, v1CredentialKey, type GlpiConfig } from "./glpi-client.js";
import { listTickets, v2CredentialKey, type GlpiV2Config } from "./glpi-v2-client.js";

export type LabelKind =
  | "ticket_status"
  | "problem_status"
  | "change_status"
  | "ticket_type"
  | "actor_type"
  | "validation_status"
  | "priority"
  | "urgency"
  | "impact"
  | "task_state";

export type LabelTable = Readonly<Record<LabelKind, Readonly<Record<number, string>>>>;

export const LABELS: Readonly<Record<string, LabelTable>> = {
  en: {
    ticket_status: { 1: "New", 2: "Processing (assigned)", 3: "Processing (planned)", 4: "Pending", 5: "Solved", 6: "Closed", 10: "Approval" },
    problem_status: { 1: "New", 2: "Processing (assigned)", 3: "Processing (planned)", 4: "Pending", 5: "Solved", 6: "Closed", 7: "Accepted", 8: "Under observation" },
    change_status: { 1: "New", 4: "Pending", 5: "Applied", 6: "Closed", 7: "Accepted", 8: "Review", 9: "Evaluation", 10: "Approval", 11: "Testing", 12: "Qualification", 13: "Refused", 14: "Cancelled" },
    ticket_type: { 1: "Incident", 2: "Request" },
    actor_type: { 1: "Requester", 2: "Assigned to", 3: "Observer" },
    validation_status: { 1: "Not subject to approval", 2: "Waiting for approval", 3: "Granted", 4: "Refused" },
    priority: { 1: "Very low", 2: "Low", 3: "Medium", 4: "High", 5: "Very high", 6: "Major" },
    urgency: { 1: "Very low", 2: "Low", 3: "Medium", 4: "High", 5: "Very high" },
    impact: { 1: "Very low", 2: "Low", 3: "Medium", 4: "High", 5: "Very high" },
    task_state: { 0: "Information", 1: "To do", 2: "Done" },
  },
  "pt_BR": {
    ticket_status: { 1: "Novo", 2: "Em atendimento (atribuído)", 3: "Em atendimento (planejado)", 4: "Pendente", 5: "Solucionado", 6: "Fechado", 10: "Aprovação" },
    problem_status: { 1: "Novo", 2: "Em atendimento (atribuído)", 3: "Em atendimento (planejado)", 4: "Pendente", 5: "Solucionado", 6: "Fechado", 7: "Aceito", 8: "Em observação" },
    change_status: { 1: "Novo", 4: "Pendente", 5: "Aplicado", 6: "Fechado", 7: "Aceito", 8: "Revisão", 9: "Avaliação", 10: "Aprovação", 11: "Testando", 12: "Qualificação", 13: "Recusado", 14: "Cancelado" },
    ticket_type: { 1: "Incidente", 2: "Requisição" },
    actor_type: { 1: "Requerente", 2: "Atribuído", 3: "Observador" },
    validation_status: { 1: "Não está sujeita a aprovação", 2: "Esperando por uma validação", 3: "Concedida", 4: "Recusado" },
    priority: { 1: "Muito baixa", 2: "Baixa", 3: "Média", 4: "Alta", 5: "Muito alta", 6: "Critica" },
    urgency: { 1: "Muito Baixa", 2: "Baixa", 3: "Média", 4: "Alta", 5: "Muito Alta" },
    impact: { 1: "Muito Baixo", 2: "Baixo", 3: "Médio", 4: "Alto", 5: "Muito alto" },
    task_state: { 0: "Informação", 1: "A fazer", 2: "Feito" },
  },
  "pt_PT": {
    ticket_status: { 1: "Novo", 2: "A processar (atribuído)", 3: "A processar (planeado)", 4: "Aguardando", 5: "Resolvido", 6: "Encerrado", 10: "Aprovação" },
    problem_status: { 1: "Novo", 2: "A processar (atribuído)", 3: "A processar (planeado)", 4: "Aguardando", 5: "Resolvido", 6: "Encerrado", 7: "Aceite", 8: "Em observação" },
    change_status: { 1: "Novo", 4: "Aguardando", 5: "Aplicado", 6: "Encerrado", 7: "Aceite", 8: "Rever", 9: "Avaliação", 10: "Aprovação", 11: "A testar", 12: "Qualificação", 13: "Recusado", 14: "Cancelado" },
    ticket_type: { 1: "Incidente", 2: "Pedido" },
    actor_type: { 1: "Requerente", 2: "Atribuído a", 3: "Observador" },
    validation_status: { 1: "Não tem matéria para aprovação", 2: "A aguardar aprovação", 3: "Concedido", 4: "Recusado" },
    priority: { 1: "Muito Baixo", 2: "Baixo", 3: "Médio", 4: "Alto", 5: "Muito Alto", 6: "Principal" },
    urgency: { 1: "Muito Baixo", 2: "Baixo", 3: "Médio", 4: "Alto", 5: "Muito Alto" },
    impact: { 1: "Muito Baixo", 2: "Baixo", 3: "Médio", 4: "Alto", 5: "Muito Alto" },
    task_state: { 0: "Informação", 1: "Por fazer", 2: "Feito" },
  },
  "es_ES": {
    ticket_status: { 1: "Nuevo", 2: "En curso (asignado)", 3: "En curso (planificada)", 4: "En espera", 5: "Resuelto", 6: "Cerrado", 10: "Aprobación" },
    problem_status: { 1: "Nuevo", 2: "En curso (asignado)", 3: "En curso (planificada)", 4: "En espera", 5: "Resuelto", 6: "Cerrado", 7: "Aceptado", 8: "Bajo observación" },
    change_status: { 1: "Nuevo", 4: "En espera", 5: "Aplicado", 6: "Cerrado", 7: "Aceptado", 8: "Revisar", 9: "Evaluación", 10: "Aprobación", 11: "Pruebas", 12: "Calificación", 13: "Rechazado", 14: "Cancelled" },
    ticket_type: { 1: "Incidencia", 2: "Petición" },
    actor_type: { 1: "Solicitante", 2: "Asignado a", 3: "Observador" },
    validation_status: { 1: "No está sujeto a validación", 2: "En espera de aprobación", 3: "Concedido", 4: "Rechazado" },
    priority: { 1: "Muy baja", 2: "Baja", 3: "Media", 4: "Alta", 5: "Muy alta", 6: "Bloqueante" },
    urgency: { 1: "Muy baja", 2: "Baja", 3: "Media", 4: "Alta", 5: "Muy alta" },
    impact: { 1: "Muy bajo", 2: "Bajo", 3: "Medio", 4: "Alto", 5: "Muy alto" },
    task_state: { 0: "Information", 1: "Por hacer", 2: "Hecho" },
  },
  "fr_FR": {
    ticket_status: { 1: "Nouveau", 2: "En cours (Attribué)", 3: "En cours (Planifié)", 4: "En attente", 5: "Résolu", 6: "Clos", 10: "Validation" },
    problem_status: { 1: "Nouveau", 2: "En cours (Attribué)", 3: "En cours (Planifié)", 4: "En attente", 5: "Résolu", 6: "Clos", 7: "Accepté", 8: "En observation" },
    change_status: { 1: "Nouveau", 4: "En attente", 5: "Appliqué", 6: "Clos", 7: "Accepté", 8: "Revue", 9: "Évaluation", 10: "Validation", 11: "En test", 12: "Qualification", 13: "Refusée", 14: "Annulé" },
    ticket_type: { 1: "Incident", 2: "Demande" },
    actor_type: { 1: "Demandeur", 2: "Attribué à", 3: "Observateur" },
    validation_status: { 1: "Non soumis à validation", 2: "En attente de validation", 3: "Acceptée", 4: "Refusée" },
    priority: { 1: "Très basse", 2: "Basse", 3: "Moyenne", 4: "Haute", 5: "Très haute", 6: "Majeure" },
    urgency: { 1: "Très basse", 2: "Basse", 3: "Moyenne", 4: "Haute", 5: "Très haute" },
    impact: { 1: "Très bas", 2: "Bas", 3: "Moyen", 4: "Haut", 5: "Très haut" },
    task_state: { 0: "Information", 1: "A faire", 2: "Fait" },
  },
  "it_IT": {
    ticket_status: { 1: "Nuova", 2: "In lavorazione (assegnata)", 3: "In lavorazione (pianificata)", 4: "In sospeso", 5: "Risolto", 6: "Chiusa", 10: "Convalida" },
    problem_status: { 1: "Nuova", 2: "In lavorazione (assegnata)", 3: "In lavorazione (pianificata)", 4: "In sospeso", 5: "Risolto", 6: "Chiusa", 7: "Accettato", 8: "Sotto osservazione" },
    change_status: { 1: "Nuova", 4: "In sospeso", 5: "Applicata", 6: "Chiusa", 7: "Accettato", 8: "Revisione", 9: "Valutazione", 10: "Convalida", 11: "Analisi", 12: "Qualificazione", 13: "Rifiutato", 14: "Cancellato" },
    ticket_type: { 1: "Incidente", 2: "Richiesta" },
    actor_type: { 1: "Richiedente", 2: "Assegnatario", 3: "Osservatore" },
    validation_status: { 1: "Non soggetto a convalida", 2: "In attesa di convalida", 3: "Accettato", 4: "Rifiutato" },
    priority: { 1: "Molto bassa", 2: "Bassa", 3: "Media", 4: "Alta", 5: "Molto alta", 6: "Massima" },
    urgency: { 1: "Molto bassa", 2: "Bassa", 3: "Media", 4: "Alta", 5: "Molto alta" },
    impact: { 1: "Molto basso", 2: "Basso", 3: "Medio", 4: "Alto", 5: "Molto alto" },
    task_state: { 0: "Informazione", 1: "Da fare", 2: "Fatto" },
  },
  "de_DE": {
    ticket_status: { 1: "Neu", 2: "In Bearbeitung (zugewiesen)", 3: "In Bearbeitung (mit Zeitplan)", 4: "Wartend", 5: "Gelöst", 6: "Geschlossen", 10: "Genehmigung" },
    problem_status: { 1: "Neu", 2: "In Bearbeitung (zugewiesen)", 3: "In Bearbeitung (mit Zeitplan)", 4: "Wartend", 5: "Gelöst", 6: "Geschlossen", 7: "Akzeptiert", 8: "Unter Beobachtung" },
    change_status: { 1: "Neu", 4: "Wartend", 5: "Ausgeführt", 6: "Geschlossen", 7: "Akzeptiert", 8: "Überprüfung", 9: "Evaluierung", 10: "Genehmigung", 11: "Testen", 12: "Eignung", 13: "Abgelehnt", 14: "Abgebrochen" },
    ticket_type: { 1: "Störung", 2: "Anfrage" },
    actor_type: { 1: "Anforderer", 2: "Bearbeiter", 3: "Beobachter" },
    validation_status: { 1: "Keine Genehmigung beantragt", 2: "Wartet auf Genehmigung", 3: "Genehmigt", 4: "Abgelehnt" },
    priority: { 1: "Sehr niedrig", 2: "Niedrig", 3: "Mittel", 4: "Hoch", 5: "Sehr hoch", 6: "Kritisch" },
    urgency: { 1: "Sehr niedrig", 2: "Niedrig", 3: "Mittel", 4: "Hoch", 5: "Sehr hoch" },
    impact: { 1: "Sehr niedrig", 2: "Niedrig", 3: "Mittel", 4: "Hoch", 5: "Sehr hoch" },
    task_state: { 0: "Information", 1: "geplant", 2: "erledigt" },
  },
};

/** Languages with a table of their own (besides the English fallback). */
export const LABEL_LANGUAGES: readonly string[] = Object.keys(LABELS).filter((l) => l !== "en");

/** Language family -> table, for regional variants without one (es_MX, fr_CA, pt_AO...). */
const FAMILY: Record<string, string> = { pt: "pt_BR", es: "es_ES", fr: "fr_FR", it: "it_IT", de: "de_DE", en: "en" };

/** "pt_BR" -> pt_BR table; "es_MX" -> es_ES; unknown or absent -> English. */
export function labelsFor(language: string | null | undefined): LabelTable {
  if (typeof language === "string" && language) {
    const exact = LABELS[language];
    if (exact) return exact;
    const family = FAMILY[language.split(/[_-]/)[0].toLowerCase()];
    if (family && LABELS[family]) return LABELS[family];
  }
  return LABELS.en;
}

// ---------------------------------------------------------------------------
// Session (user + language), cached per credential
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 5 * 60_000;
/** A failed lookup is retried sooner: labels fall back to English meanwhile. */
const FAILED_TTL_MS = 60_000;
const MAX_ENTRIES = 1000;

export interface SessionInfo {
  /** glpiID; null when the session has none. */
  userId: number | null;
  /** glpifriendlyname, else glpiname. */
  userName: string | null;
  /** glpilanguage, e.g. "pt_BR". */
  language: string | null;
}

const sessions = new Map<string, { info: SessionInfo; expires: number }>();
const failures = new Map<string, number>();

/** getFullSession reduced to what the tools use; cached per credential for a few minutes. Errors propagate. */
export async function sessionInfo(config: GlpiConfig): Promise<SessionInfo> {
  const key = v1CredentialKey(config);
  const hit = sessions.get(key);
  if (hit && hit.expires > Date.now()) return hit.info;
  const res = (await getFullSession(config)) as { session?: Record<string, unknown> } | undefined;
  const s = res?.session ?? {};
  const id = Number(s.glpiID);
  const friendly = [s.glpifriendlyname, s.glpiname].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  const info: SessionInfo = {
    userId: Number.isInteger(id) && id > 0 ? id : null,
    userName: friendly ?? null,
    language: typeof s.glpilanguage === "string" && s.glpilanguage ? s.glpilanguage : null,
  };
  if (sessions.size >= MAX_ENTRIES) sessions.clear();
  sessions.set(key, { info, expires: Date.now() + SESSION_TTL_MS });
  failures.delete(key);
  return info;
}

/** The label table of the connected user's language; English when the session cannot be read. */
export async function sessionLabels(config: GlpiConfig): Promise<LabelTable> {
  const key = v1CredentialKey(config);
  const failedAt = failures.get(key);
  if (failedAt !== undefined && Date.now() - failedAt < FAILED_TTL_MS) return LABELS.en;
  try {
    return labelsFor((await sessionInfo(config)).language);
  } catch {
    if (failures.size >= MAX_ENTRIES) failures.clear();
    failures.set(key, Date.now());
    return LABELS.en;
  }
}

/** Status table of an ITIL itemtype. */
export function statusKind(itemtype: "Ticket" | "Problem" | "Change"): LabelKind {
  return itemtype === "Problem" ? "problem_status" : itemtype === "Change" ? "change_status" : "ticket_status";
}

// ---------------------------------------------------------------------------
// API v2: language read from the labels the API itself returns
// ---------------------------------------------------------------------------
//
// The v2 session (/api.php/v2/session) carries no language, and GET
// /Administration/User/Me needs a scope the usual client lacks. But the v2
// returns statuses already labelled in the user's language ({id: 5, name:
// "Solucionado"}) while priority, urgency, impact, type and the timeline
// states come as bare codes. The language whose status table holds every
// (id, name) seen picks the table for those codes; it is cached per credential.
// Without statuses at hand (the timeline), the cached language is used, or one
// ticket is read to find it. English (GLPI's msgids) when nothing matches.

const V2_TTL_MS = 30 * 60_000;
const v2Languages = new Map<string, { language: string; expires: number }>();
const v2Failures = new Map<string, number>();

/** Languages whose status table of `kind` matches every {id, name}; first of LABELS order wins (pt_BR before pt_PT). */
export function languageFromStatuses(kind: LabelKind, statuses: readonly unknown[]): string | undefined {
  const seen: [number, string][] = [];
  for (const s of statuses) {
    const o = s as { id?: unknown; name?: unknown } | null;
    if (o && typeof o === "object" && Number.isInteger(Number(o.id)) && typeof o.name === "string" && o.name) {
      seen.push([Number(o.id), o.name]);
    }
  }
  if (seen.length === 0) return undefined;
  return Object.keys(LABELS).find((lang) => seen.every(([id, name]) => LABELS[lang][kind][id] === name));
}

function rememberV2Language(config: GlpiV2Config, language: string): void {
  if (v2Languages.size >= MAX_ENTRIES) v2Languages.clear();
  v2Languages.set(v2CredentialKey(config), { language, expires: Date.now() + V2_TTL_MS });
}

/**
 * Label table for API v2 codes. `statuses` (the `status` objects of the rows at
 * hand, of the given kind) detect the language; otherwise the cached language.
 * Only without a hint (the timeline, which has no status) is one ticket read to
 * find it. Never throws: English when the language is unknown.
 */
export async function v2Labels(
  config: GlpiV2Config,
  hint?: { kind: LabelKind; statuses: readonly unknown[] },
): Promise<LabelTable> {
  if (hint) {
    const lang = languageFromStatuses(hint.kind, hint.statuses);
    if (lang) {
      rememberV2Language(config, lang);
      return LABELS[lang];
    }
  }
  const key = v2CredentialKey(config);
  const hit = v2Languages.get(key);
  if (hit && hit.expires > Date.now()) return LABELS[hit.language] ?? LABELS.en;
  if (hint) return LABELS.en;
  const failedAt = v2Failures.get(key);
  if (failedAt !== undefined && Date.now() - failedAt < FAILED_TTL_MS) return LABELS.en;
  try {
    const rows = await listTickets(config, { limit: 1 });
    const status = Array.isArray(rows) ? (rows[0] as { status?: unknown } | undefined)?.status : undefined;
    const lang = status ? languageFromStatuses("ticket_status", [status]) : undefined;
    if (lang) {
      rememberV2Language(config, lang);
      return LABELS[lang];
    }
  } catch {
    // fall through to English
  }
  if (v2Failures.size >= MAX_ENTRIES) v2Failures.clear();
  v2Failures.set(key, Date.now());
  return LABELS.en;
}

/** "<field>_name" beside each coded field of a v2 row that has a label (the code stays). */
export function withV2Labels(
  row: unknown,
  labels: LabelTable,
  fields: readonly (readonly [field: string, kind: LabelKind])[],
): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const r = row as Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  for (const [field, kind] of fields) {
    const v = r[field];
    if (typeof v === "number" && labels[kind][v] !== undefined) extra[`${field}_name`] = labels[kind][v];
  }
  return Object.keys(extra).length ? { ...r, ...extra } : row;
}
