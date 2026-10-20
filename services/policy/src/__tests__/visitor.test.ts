import { describe, expect, it } from 'vitest';
import { clearForFamily, clearNameForFamily, clearVisitorForFamily, LEXICON } from '../index.js';

/**
 * The words a family member types for an arranged visitor (arrange_visit's
 * `who`). A doctor coming to the door is the visit a family most needs to
 * arrange, so a general clinician's title is set aside as "someone"; what a
 * title says the visit is for, and every other protected word, still is not.
 */
describe('clearVisitorForFamily — who is coming, as the member typed it', () => {
  it('clears what cleared before: plain words and names', () => {
    for (const who of ['the plumber', 'Dave from the council', 'Anna Cash', 'Mrs Banks', 'Maria', 'Doctor Who', 'Иван']) {
      expect(clearVisitorForFamily(who), who).toBe(true);
    }
  });

  it('sets aside a general clinician’s title, and clears the rest when the rest clears', () => {
    for (const who of [
      'Doctor Rossi', 'the doctor', 'a doctor', 'the doctors', 'Dr Patel', 'Dr. Patel', 'DR PATEL', 'Drs Khan and Patel', 'the GP', 'the G.P.',
      'the nurse', 'Nurse Joy', 'the nurses', 'the district nurse', 'District Nurse Jones', 'her physio', 'the physiotherapist',
      'the podiatrist', 'the chiropodist', 'the optician', 'the doctor’s', 'Dóctor Rossi', 'the doctor from the practice',
    ]) {
      expect(clearVisitorForFamily(who), who).toBe(true);
    }
  });

  it('keeps refusing a title that says what the visit is for', () => {
    for (const who of ['the psychiatrist', 'a psychologist', 'her therapist', 'the counsellor', 'the counselor', 'the midwife', 'the paramedic', 'paramedics', 'the dentist', 'the chemist', 'the pharmacist', 'the surgeon', 'a physician', 'the health visitor', 'the medic', 'nursing staff']) {
      expect(clearVisitorForFamily(who), who).toBe(false);
    }
  });

  it('keeps refusing any other protected word beside the title', () => {
    for (const who of [
      'Dr Patel about her dialysis', 'the nurse for her insulin', 'the doctor about her hip', 'the GP from the hospital', 'the nurse with her pills',
      'Doctor Rossi about the pension', 'the doctor and her husband', 'the nurse from 14 Elm Road', 'the district nurse, NHS', 'the doctor, she is ill',
    ]) {
      expect(clearVisitorForFamily(who), who).toBe(false);
    }
  });

  it('keeps refusing what it cannot read: another script mixed in, a look-alike letter, an invisible one, a pictograph', () => {
    for (const who of ['Doctor Иван', 'Dоctor Rossi', 'Doc​tor Rossi', 'Doctor Rossi 💊', 'the nurse 🙂', '医生 Rossi']) {
      expect(clearVisitorForFamily(who), who).toBe(false);
    }
  });

  it('agrees with the lexicon’s own examples: only a general clinician’s title is set aside', () => {
    const general = new Set(['Dr Patel', 'the doctor', 'Doctor Khan', 'GP', 'a nurse', 'the district nurse', 'her physio']);
    for (const marker of LEXICON) {
      for (const example of marker.examples) {
        expect(clearVisitorForFamily(example), example).toBe(general.has(example));
      }
    }
  });

  it('changes nothing else: the lexicon still refuses "a nurse" in any other sentence, and a name still is not a title', () => {
    expect(clearForFamily('A woman in a nurse’s uniform holding a medication box.').cleared).toBe(false);
    expect(clearForFamily('A nurse is at the door.').cleared).toBe(false);
    expect(clearForFamily('Doctor Rossi').cleared).toBe(false);
    expect(clearNameForFamily('Dr Patel')).toBe(false);
    expect(clearNameForFamily('the nurse')).toBe(false);
  });
});
