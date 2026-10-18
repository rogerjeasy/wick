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
 * true of both. The link opens that app with the code filled in, and the
 * QR code beside the words is that link, for a phone's camera (QrCode.tsx).
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
import { useCalmStyles, type CalmTheme } from '@wick/vega-calm-ui';
import { words } from '../words/words.js';
import type { PairingStartResponse } from './PairingFlow.js';
import { STILL_TRYING } from './connect.js';
import { QrCode } from './QrCode.js';

/** How wide the code is on a 960x540dp screen, quiet zone and all: a phone reads it from the sofa. */
const QR_SIZE = 216;

export interface PairingScreenProps {
  readonly info?: PairingStartResponse;
  /**
   * The pairing service could not be reached, and is being tried again
   * (connect.ts). The screen then says so under "Getting a code…", rather
   * than go on promising one.
   */
  readonly trying?: boolean;
}

/** English, always: see the header. */
const say = words(DEFAULT_LANGUAGE);

export function PairingScreen({ info, trying }: PairingScreenProps): React.JSX.Element {
  const styles = useCalmStyles(makeStyles);
  return (
    <View style={styles.root}>
      <Text style={styles.headline}>{say('pairing.title')}</Text>
      {info ? (
        <View style={styles.row}>
          <View style={styles.words}>
            <Text style={styles.code}>{info.code}</Text>
            <Text style={styles.body}>{say('pairing.instructions')}</Text>
            <Text style={styles.link}>{info.url}</Text>
          </View>
          <View style={styles.qr}>
            <QrCode text={info.url} size={QR_SIZE} label={say('pairing.scanLabel')} />
            <Text style={styles.scan}>{say('pairing.scan')}</Text>
          </View>
        </View>
      ) : (
        <>
          <Text style={styles.body}>{say('pairing.gettingCode')}</Text>
          {trying ? <Text style={styles.body}>{STILL_TRYING}</Text> : null}
        </>
      )}
    </View>
  );
}

const makeStyles = (t: CalmTheme) =>
  StyleSheet.create({
    root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.palette.ground },
    headline: { fontSize: t.fontSize('headline'), color: t.palette.ink, marginBottom: 24 },
    code: { fontSize: t.fontSize('display'), color: t.palette.accent, letterSpacing: 8, marginBottom: 16 },
    body: { fontSize: t.fontSize('body'), color: t.palette.inkDim, textAlign: 'center', paddingHorizontal: 24, marginBottom: 16 },
    link: { fontSize: t.fontSize('body'), color: t.palette.inkDim },
    row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 48 },
    words: { flex: 1, alignItems: 'center' },
    qr: { alignItems: 'center', marginLeft: 32 },
    scan: { fontSize: t.fontSize('body'), color: t.palette.inkDim, marginTop: 12, maxWidth: QR_SIZE + 64, textAlign: 'center' },
  });
