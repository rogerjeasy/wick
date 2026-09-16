/**
 * Unpaired-device screen. §4.2 steps 1–2: a 6-digit code and a short URL, and
 * nothing else — S4's pairing gate ("unpaired devices show the code and
 * nothing else") already constrains what this may render.
 */
import * as React from 'react';
import { StyleSheet, Text, View } from '@amazon-devices/react-native-kepler';
import { fontSize, safe } from '@wick/vega-calm-ui';
import type { PairingStartResponse } from './PairingFlow.js';

export interface PairingScreenProps {
  readonly info?: PairingStartResponse;
}

export function PairingScreen({ info }: PairingScreenProps): React.JSX.Element {
  return (
    <View style={styles.root}>
      <Text style={styles.headline}>Set up Wick</Text>
      {info ? (
        <>
          <Text style={styles.code}>{info.code}</Text>
          <Text style={styles.body}>Go to {info.url} to finish pairing.</Text>
        </>
      ) : (
        <Text style={styles.body}>Getting a code…</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: safe.ground },
  headline: { fontSize: fontSize('headline'), color: safe.ink, marginBottom: 24 },
  code: { fontSize: fontSize('display'), color: safe.accent, letterSpacing: 8, marginBottom: 16 },
  body: { fontSize: fontSize('body'), color: safe.inkDim },
});
