# NetBox Fleet Dashboard

Single-page, fully client-side dashboard for NetBox device CSV exports: fleet
composition analytics with a data-completeness QA layer on top. No backend,
no network calls — nothing leaves the browser.

## Run it

Open `index.html` directly in a browser, or serve the folder so the bundled
sample dataset button works:

```sh
python3 -m http.server 4173   # then open http://localhost:4173
```

Libraries (PapaParse 5.5, Chart.js 4.5) are vendored in `vendor/` — the app
works offline. `sample_devices.csv` is **synthetic demo data** (420 fake
devices + 2 deliberately malformed rows) generated for testing.

## What it does

- **Upload & parse** — drag-and-drop or file picker; header validated against
  the 65-column NetBox device export schema. Missing/extra/reordered columns
  produce warnings, not crashes (columns are matched by name). Rows with a
  wrong field count are kept, counted as empty where short, and listed in the
  "malformed rows" panel.
- **Weighted completeness scoring** — per device: Σ weights of non-empty
  tiered fields ÷ Σ weights of all tiered fields. Defaults: 14 critical
  fields × weight 3, 11 important × weight 1, everything else ignored.
  Tiers, weights, empty-value markers, and status exclusions are all editable
  in **Settings** and exportable/importable as JSON (state is in-memory only —
  download the config JSON to keep it across sessions).
- **Fleet composition** — dynamic breakdowns (no hardcoded enums) for
  Manufacturer, Role, Status, Region, Criticality, Tenant, plus
  **Generation (parsed from Type)** — extracted from a trailing
  `G1`/`Gen 3`/`Gen3` token; non-matches land in "Unspecified", never guessed.
  Site/rack density top-10.
- **Completeness charts** — per-field fill rate (worst first), per-device
  score histogram, averages by site and role, and a dedicated callout for
  **Active devices missing BMC IP or OOB IP** (no out-of-band path to live gear).
- **Lifecycle / risk** — past-EOL and 90/180-day EOL windows, device age from
  Installation Date, and FW-bundle presence on active devices. Each card shows
  field-population badges and states explicitly when a field is empty
  fleet-wide instead of rendering a misleading empty chart.
- **Filters** — Site, Region, Criticality, Status, Role, Manufacturer,
  Generation, Tenant; every chart, KPI, and the table respect the same filter
  set. Debounced; handles a few thousand rows comfortably.
- **Device table** — sortable, searchable, paginated; click a row for the full
  field-by-field view grouped by tier with empties highlighted. Export the
  current view as CSV annotated with score + missing critical/important fields.

## Decisions taken (edit in Settings if wrong for your instance)

| Open question | Default shipped |
|---|---|
| Tier assignment | The proposed 14-critical / 11-important split, fully editable |
| Ignored fields in UI | Visible but de-emphasized: collapsed group in the device detail, excluded from scoring |
| Decommissioned/Offline scoring | **Scored by default**; a Settings checklist excludes any statuses you pick |
| Generation regex | `…(G\|Gen)[ -]?N$` at end of Type, case-insensitive. HPE's "DL380 Gen10" **does** match as Gen 10 — check the Unspecified bucket and the Generation panel against reality before trusting it |
| Date parsing | ISO (`T` or space separator) parsed; `DD/MM` vs `MM/DD` only resolved when unambiguous, otherwise counted as "unparseable/ambiguous" — never guessed |
| FW Bundle | Presence/absence only; the mixed `dell/30092025` vs `01/02/2026` formats make date parsing unsafe |

## Parsing notes

- "Empty" = blank after trim, or any of `-`, `–`, `N/A`, `n/a`, `None`,
  `null`, `NULL` (editable list in Settings).
- Tiered columns absent from the uploaded file are excluded from the score
  denominator and flagged in the schema warnings.
