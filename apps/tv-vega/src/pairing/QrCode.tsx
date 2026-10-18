/**
 * The pairing link as a QR code (packages/contracts qr.ts), so whoever sets
 * up her television can point a phone at it instead of typing the address.
 *
 * Black on the theme's lightest colour, its ink (off-white, or white with
 * higher contrast): a phone's camera reads a dark code on a light ground, and
 * the four light modules round it (the quiet zone) are part of the code.
 * Each row's dark modules are drawn as runs, one block a run, so a code is a
 * few hundred views rather than a thousand squares.
 *
 * Nothing at all for a link too long to carry (`qrModules` gives undefined):
 * the address under the code is still on the screen.
 */
import * as React from 'react';
import { StyleSheet, View } from '@amazon-devices/react-native-kepler';
import { qrModules, qrRuns } from '@wick/contracts';
import { useCalmStyles, type CalmTheme } from '@wick/vega-calm-ui';

/** The light modules round the code that a reader needs, by the standard. */
export const QUIET_ZONE_MODULES = 4;

export interface QrCodeProps {
  readonly text: string;
  /** How wide the whole code is, quiet zone and all, in dp. */
  readonly size: number;
  /** What a screen reader says it is. */
  readonly label: string;
}

export function QrCode({ text, size, label }: QrCodeProps): React.JSX.Element | null {
  const styles = useCalmStyles(makeStyles);
  const modules = React.useMemo(() => qrModules(text), [text]);
  if (!modules) return null;
  const across = modules.length + 2 * QUIET_ZONE_MODULES;
  // Whole dp a module: a module drawn half a pixel wide blurs into its neighbour.
  const module = Math.max(1, Math.floor(size / across));
  const side = module * across;
  const runs = qrRuns(modules);
  return (
    <View style={[styles.ground, { width: side, height: side }]} accessible accessibilityRole="image" accessibilityLabel={label}>
      {runs.flatMap((row, y) =>
        row.map(([x, length]) => (
          <View
            key={`${y}-${x}`}
            style={[
              styles.dark,
              { left: (x + QUIET_ZONE_MODULES) * module, top: (y + QUIET_ZONE_MODULES) * module, width: length * module, height: module },
            ]}
          />
        )),
      )}
    </View>
  );
}

const makeStyles = (t: CalmTheme) =>
  StyleSheet.create({
    ground: { backgroundColor: t.palette.ink },
    dark: { position: 'absolute', backgroundColor: '#000000' },
  });
