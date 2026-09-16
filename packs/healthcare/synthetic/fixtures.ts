import { deaNumber, digits, luhnNpi, pick, ssn } from './rng.js';
import type { SyntheticProvider } from './types.js';

const FIRST = [
  'Ada',
  'Grace',
  'Katherine',
  'Mae',
  'Chien-Shiung',
  'Rosalind',
  'Tu',
  'Vera',
  'Barbara',
  'Rita',
] as const;
const MIDDLE = ['Rae', 'Marie', 'Chen', 'Okonkwo', 'Patel', 'Nguyen', 'Silva', 'Haddad', 'Kim', 'Rossi'] as const;
const LAST = [
  'Lovelace',
  'Hopper',
  'Johnson',
  'Jemison',
  'Wu',
  'Franklin',
  'Youyou',
  'Rubin',
  'McClintock',
  'Levi-Montalcini',
] as const;
const SUFFIX = ['MD', 'DO', 'MD', 'MD', 'DO'] as const;
const STATES = ['CA', 'NY', 'TX', 'WA', 'MA', 'IL', 'FL', 'CO'] as const;
const SPECIALTIES = [
  'Internal Medicine',
  'Family Medicine',
  'Cardiology',
  'Dermatology',
  'Pediatrics',
  'Psychiatry',
] as const;
const SCHOOLS = [
  'Johns Hopkins University School of Medicine',
  'UCSF School of Medicine',
  'Mayo Clinic Alix School of Medicine',
  'University of Michigan Medical School',
] as const;
const CARRIERS = ['MedPro Group', 'The Doctors Company', 'Coverys', 'ProAssurance'] as const;
const BOARDS = [
  'American Board of Internal Medicine',
  'American Board of Family Medicine',
  'American Board of Pediatrics',
] as const;
const STREETS = ['1200 Mission Street', '44 Vine Avenue', '900 Cedar Park Road', '17 Harbour Way'] as const;
const CITIES = ['San Francisco', 'Brooklyn', 'Austin', 'Seattle', 'Cambridge', 'Chicago'] as const;

export const STATE_BOARD: Record<string, string> = {
  CA: 'Medical Board of California',
  NY: 'New York State Board for Medicine',
  TX: 'Texas Medical Board',
  WA: 'Washington Medical Commission',
  MA: 'Massachusetts Board of Registration in Medicine',
  IL: 'Illinois Department of Financial and Professional Regulation',
  FL: 'Florida Board of Medicine',
  CO: 'Colorado Medical Board',
};

export function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function makeProvider(rng: () => number, index: number): SyntheticProvider {
  const first = pick(rng, FIRST);
  const middle = pick(rng, MIDDLE);
  const last = pick(rng, LAST);
  const suffix = pick(rng, SUFFIX);
  const state = pick(rng, STATES);
  const slug = `${first}-${last}-${index + 1}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
  // Expiries are spread across three years from 2026 so deadline windows have
  // something inside them, something just outside, and something overdue.
  const licenseYear = 2026 + (index % 3);
  return {
    id: `p${String(index + 1).padStart(2, '0')}`,
    slug,
    first_name: first,
    middle_name: middle,
    last_name: last,
    suffix,
    full_name: `${first} ${middle} ${last}, ${suffix}`,
    npi: luhnNpi(rng),
    ssn: ssn(rng),
    ein: `${digits(rng, 2)}-${digits(rng, 7)}`,
    dea_number: deaNumber(rng, last[0]),
    license_number: `${state}${digits(rng, 6)}`,
    policy_number: `MP-${digits(rng, 8)}`,
    board_cert_number: `BC-${digits(rng, 7)}`,
    state,
    specialty: pick(rng, SPECIALTIES),
    practice_name: `${pick(rng, CITIES)} ${pick(rng, ['Family Health', 'Medical Group', 'Care Partners', 'Clinic'])}`,
    practice_address: `${pick(rng, STREETS)}, ${pick(rng, CITIES)}, ${state}`,
    email: `${first}.${last}@example-practice.test`.toLowerCase(),
    phone: `${digits(rng, 3)}-555-${digits(rng, 4)}`,
    medical_school: pick(rng, SCHOOLS),
    graduation_year: String(1998 + Math.floor(rng() * 22)),
    date_of_birth: isoDate(1965 + Math.floor(rng() * 25), 1 + Math.floor(rng() * 12), 1 + Math.floor(rng() * 28)),
    malpractice_carrier: pick(rng, CARRIERS),
    malpractice_coverage: pick(rng, ['$1,000,000 / $3,000,000', '$2,000,000 / $6,000,000']),
    license_issued: isoDate(licenseYear - 2, 1 + Math.floor(rng() * 12), 1 + Math.floor(rng() * 28)),
    license_expires: isoDate(licenseYear, 1 + Math.floor(rng() * 12), 1 + Math.floor(rng() * 28)),
    dea_issued: isoDate(licenseYear - 3, 6, 1),
    dea_expires: isoDate(licenseYear + 1, 6, 30),
    malpractice_issued: isoDate(licenseYear - 1, 1, 1),
    malpractice_expires: isoDate(licenseYear, 12, 31),
    board_issuer: pick(rng, BOARDS),
    board_issued: isoDate(licenseYear - 5, 11, 15),
    board_expires: isoDate(licenseYear + 2, 11, 15),
  };
}
