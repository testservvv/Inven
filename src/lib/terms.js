// German display names for the fixed value lists stored in the database.

export const ASSET_STATUS = {
  active: 'In Betrieb',
  storage: 'Eingelagert',
  repair: 'In Reparatur',
  retired: 'Ausgemustert',
  lost: 'Verlust / Diebstahl',
};

export const OWNERSHIP = {
  owned: 'Eigentum',
  leased: 'Leasing',
  rented: 'Miete',
  loaned: 'Leihgabe',
};

export const SEVERITY = {
  low: 'Gering',
  medium: 'Mittel',
  critical: 'Kritisch',
};

export const SEVERITY_HINT = {
  low: 'Gerät bleibt nutzbar',
  medium: 'Nur eingeschränkt nutzbar',
  critical: 'Nicht nutzbar / Sicherheitsrisiko',
};

export const DEFECT_STATUS = {
  open: 'Offen',
  in_progress: 'In Arbeit',
  resolved: 'Behoben',
};

export const RESULT = {
  passed: 'Bestanden',
  remarks: 'Bestanden mit Mängeln',
  failed: 'Nicht bestanden',
};

export const ROLE = {
  admin: 'Administrator',
  member: 'Mitarbeiter',
};

export const ATTACHMENT_KIND = {
  photo: 'Foto',
  invoice: 'Rechnung / Beleg',
  report: 'Prüfprotokoll',
  document: 'Dokument',
};

/** Inspection plan states, ordered from most to least urgent. */
export const PLAN_STATE = {
  failed: 'Nicht bestanden',
  overdue: 'Überfällig',
  open: 'Termin offen',
  soon: 'Bald fällig',
  ok: 'In Ordnung',
};
