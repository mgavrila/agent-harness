# Healthcare form templates

Two fillable AcroForm PDFs and one CSV specification. The PDFs are generated,
not authored: run `pnpm forms:generate` to rebuild them. Output is
byte-deterministic, so a diff on these files means a field changed.

`templates.json` maps each PDF form field to one source in the record store.

| `source`     | Extra keys                                                             | Resolves to                                                                        |
| ------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `provider`   | `property`: `name` \| `npi`                                            | the `providers` row                                                                |
| `field`      | `name`                                                                 | the `fields` row with that name, only when its status is `extracted` or `verified` |
| `credential` | `kind`, `property`: `issuer` \| `state` \| `issued_at` \| `expires_at` | the credential of that kind with the latest expiry                                 |

**A mapping may never name a restricted value.** `credentials.number` is absent
from the `property` enum on purpose, and a `field` mapping whose name is a
restricted identifier (`ssn`, `ein`, `dea_number`, …) is refused at fill time
by `forms_fill`. A filled form leaves the harness as a file released to a
human on the configured messaging surface; restricted identifiers do not
travel that way.

## Roster CSV columns

`forms_roster(payer_id, provider_ids)` writes exactly these columns, in this
order, with a header row, CRLF-free `\n` line endings, and UTF-8 encoding.

| Column                   | Source                          | Notes                                                                                                 |
| ------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `payer_id`               | the tool argument               | repeated on every row so a concatenated file stays self-describing                                    |
| `provider_name`          | `providers.name`                |                                                                                                       |
| `npi`                    | `providers.npi`                 | empty when unknown                                                                                    |
| `primary_specialty`      | field `primary_specialty`       | empty when pending                                                                                    |
| `practice_address`       | field `practice_address`        | empty when pending                                                                                    |
| `license_state`          | latest `license` credential     |                                                                                                       |
| `license_issuer`         | latest `license` credential     |                                                                                                       |
| `license_expires_at`     | latest `license` credential     | ISO `YYYY-MM-DD`                                                                                      |
| `license_number_on_file` | latest `license` credential     | `yes` only when a number is actually stored on that credential; `no` otherwise — **never the number** |
| `dea_on_file`            | latest `dea` credential         | `yes` only when a number is actually stored on that credential; `no` otherwise — **never the number** |
| `malpractice_carrier`    | latest `malpractice` credential |                                                                                                       |
| `malpractice_expires_at` | latest `malpractice` credential | ISO `YYYY-MM-DD`                                                                                      |
| `board_cert_expires_at`  | latest `board_cert` credential  | ISO `YYYY-MM-DD`                                                                                      |
| `provider_status`        | `providers.status`              |                                                                                                       |

Cells are quoted when they contain a comma, a double quote, a newline or a
carriage return; internal double quotes are doubled. A cell whose first
character after any leading spaces, tabs, carriage returns or newlines is `=`,
`+`, `-` or `@` is prefixed with a single quote so a spreadsheet does not read
it as a formula.
