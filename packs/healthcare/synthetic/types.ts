export type SyntheticKind = 'state_license' | 'dea_certificate' | 'malpractice_certificate' | 'w9';

export interface SyntheticProvider {
  id: string;
  slug: string;
  first_name: string;
  middle_name: string;
  last_name: string;
  suffix: string;
  full_name: string;
  npi: string;
  ssn: string;
  ein: string;
  dea_number: string;
  license_number: string;
  policy_number: string;
  board_cert_number: string;
  state: string;
  specialty: string;
  practice_name: string;
  practice_address: string;
  email: string;
  phone: string;
  medical_school: string;
  graduation_year: string;
  date_of_birth: string;
  malpractice_carrier: string;
  malpractice_coverage: string;
  license_issued: string;
  license_expires: string;
  dea_issued: string;
  dea_expires: string;
  malpractice_issued: string;
  malpractice_expires: string;
  board_issuer: string;
  board_issued: string;
  board_expires: string;
}

export interface GroundTruthCredential {
  kind: 'license' | 'dea' | 'malpractice' | 'board_cert';
  state?: string;
  issuer: string;
  issued_at?: string;
  expires_at: string;
}

export interface GroundTruthDocument {
  document_id: string;
  provider_id: string;
  kind: SyntheticKind;
  split: 'text_layer' | 'scan';
  /** Relative to the output directory. */
  path: string;
  /** Field values a correct extraction should return from THIS document. */
  fields: Record<string, string>;
  credentials: GroundTruthCredential[];
  /** Restricted values printed on this document, which redaction must catch. */
  restricted: Record<string, string>;
}

export interface GroundTruth {
  seed: number;
  generated_at: string;
  providers: SyntheticProvider[];
  documents: GroundTruthDocument[];
}

export interface GenerateOptions {
  outDir: string;
  count?: number;
  seed?: number;
  /** Rasterise every document into an image-only twin. Off makes generation about six times faster. */
  scans?: boolean;
  /** Also emit the prompt-injection document the injection eval uses. */
  injection?: boolean;
}

export interface PageSpec {
  title: string;
  lines: string[];
}

export interface DocumentPlan {
  kind: SyntheticKind;
  pages: PageSpec[];
  fields: Record<string, string>;
  credentials: GroundTruthCredential[];
  restricted: Record<string, string>;
}
