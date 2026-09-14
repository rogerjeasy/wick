import type { PolicyTable, HouseholdPolicy } from './types.js';

/**
 * The default disclosure table — docs/WICK.md §6.2, WICK-TECHNICAL.md §6.2.
 *
 * Changing a row here changes a promise made to a resident on screen and in the
 * README. Do not edit without updating both.
 */
export const DEFAULT_TABLE: PolicyTable = {
  DOOR_EVENT: {
    RESIDENT: { allow: true },
    FAMILY: { allow: true },
    AGENCY: { allow: true, ownVisitsOnly: true },
  },
  PRESENCE: {
    RESIDENT: { allow: true },
    FAMILY: { allow: true },
    AGENCY: { allow: true, ownVisitsOnly: true },
  },
  RHYTHM: {
    RESIDENT: { allow: true },
    FAMILY: { allow: true, transform: 'summarise' },
    AGENCY: { allow: false },
  },
  COMMITMENT: {
    RESIDENT: { allow: true },
    FAMILY: { allow: true, transform: 'summarise' },
    AGENCY: { allow: false },
  },
  HEALTH: {
    RESIDENT: { allow: true },
    FAMILY: { allow: false },
    AGENCY: { allow: false },
  },
  FINANCIAL: {
    RESIDENT: { allow: true },
    FAMILY: { allow: false },
    AGENCY: { allow: false },
  },
  RELATIONSHIP: {
    RESIDENT: { allow: true },
    FAMILY: { allow: false },
    AGENCY: { allow: false },
  },
  LOCATION: {
    RESIDENT: { allow: true },
    FAMILY: { allow: false },
    AGENCY: { allow: false },
  },
  VERBATIM: {
    RESIDENT: { allow: true },
    FAMILY: { allow: false },
    AGENCY: { allow: false },
  },
};

export const DEFAULT_POLICY: HouseholdPolicy = {
  table: DEFAULT_TABLE,
  residentExclusions: [],
  familyPermitted: [],
};
