/**
 * Unpaired-device screen. §4.2 steps 1–2: a 6-digit code, where to enter it,
 * and nothing else — S4's pairing gate ("unpaired devices show the code and
 * nothing else") already constrains what this may render.
 *
 * The code is entered in the family app by someone signed in there
 * (services/edge-device/lambda/pair-claim.mjs): the organiser, for the
 * resident's television, or any member the resident has allowed, for a
 * television of their own. Which of the two this television becomes is
 * chosen there, not here — so the sentence below names no button, and is
 * true of both. The link opens that app with the code filled in.
 *
 * Always in English, whatever language a household later chooses: there is
 * no household yet, and a television learns its home's language only from
 * the home it is connected to (packages/contracts language.ts). The words
 * are read from the table all the same (words/words.ts), so they are kept
 * in one place with the rest.
 */
import * as React from 'react';
import { StyleSheet, Text, View } from '@amazon-devices/react-native-kepler';
import { DEFAULT_LANGUAGE } from '@wick/contracts';
import { fontSize, safe } from '@wick/vega-calm-ui';
import { words } from '../words/words.js';
import type { PairingStartResponse } from './PairingFlow.js';

export interface PairingScreenProps {
  readonly info?: PairingStartResponse;
}

/** English, always: see the header. */
const say = words(DEFAULT_LANGUAGE);

export function PairingScreen({ info }: PairingScreenProps): React.JSX.Element {
  return (
    <View style={styles.root}>
      <Text style={styles.headline}>{say('pairing.title')}</Text>
      {info ? (
        <>
          <Text style={styles.code}>{info.code}</Text>
          <Text style={styles.body}>{say('pairing.instructions')}</Text>
          <Text style={styles.link}>{info.url}</Text>
        </>
      ) : (
        <Text style={styles.body}>{say('pairing.gettingCode')}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: safe.ground },
  headline: { fontSize: fontSize('headline'), color: safe.ink, marginBottom: 24 },
  code: { fontSize: fontSize('display'), color: safe.accent, letterSpacing: 8, marginBottom: 16 },
  body: { fontSize: fontSize('body'), color: safe.inkDim, textAlign: 'center', paddingHorizontal: 96, marginBottom: 16 },
  link: { fontSize: fontSize('body'), color: safe.inkDim },
});
